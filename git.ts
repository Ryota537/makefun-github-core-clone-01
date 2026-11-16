// git.ts — smart-HTTP git server for the github-core-clone-01 forge.
//
// Implements, against the in-memory store only (no git binary, no network):
//   - GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//     upload-pack: protocol v2 when `Git-Protocol: version=2` is sent
//     (advertises `version 2`, caps fetch + ls-refs, object-format sha1),
//     otherwise v0 (`# service=git-upload-pack` preamble, side-band-64k, ...).
//     receive-pack: v0 only (report-status, side-band-64k, delete-refs).
//     Missing repo -> 404, empty body.
//   - POST /{owner}/{repo}.git/git-upload-pack
//     v2 commands ls-refs + fetch (sections acknowledgments / shallow-info /
//     packfile, sideband band 1/2/3, thin-pack, ofs-delta, no-progress,
//     deepen); v0 fallback (want/have/done, side-band-64k).
//     The server sends packs with 0 deltas (allowed by the checks).
//   - POST /{owner}/{repo}.git/git-receive-pack
//     v0 only, report-status demuxed from sideband band 1, fast-forward only
//     (non-FF -> `ng <ref> non-fast-forward`, ref unmoved; mixed pushes apply
//     the FF refs and report one line per ref).
//   - Packfile READ v2/v3: OFS_DELTA + REF_DELTA (recursive, thin packs via
//     objects already in the repo), trailer checksum verified.
//   - Raw object bytes are stored exactly as received, never re-serialized.
//
// Determinism: no Date.now(), no new Date(), no Math.random(). Timestamps
// come from TRIAL_NOW (store.ts). No throwing out of handleGit: every failure
// inside a handler is caught and returned as an error result.
//
// Node 22, stdlib only, erasable TS syntax only (explicit `.ts` imports).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { TRIAL_NOW, VIEWER_EMAIL, VIEWER_NAME, sha1Hex } from './store.ts';
import type { GitObject, GitObjectType, Pull, Repo, Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const PKT_LINE_MAX = 65520;
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode every pkt-line in `buf`. Throws on a malformed header or truncation. */
function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Decode pkt-lines up to (and including) the first flush packet; everything
 * after it is returned untouched as `rest` (the raw packfile of a push).
 */
function decodePktLinesUntilFlush(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream ended without a flush');
}

function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// object model
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: GitObjectType, data: Buffer): string {
  return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]));
}

/** Store raw object bytes exactly; returns the object id. */
function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  repo.git.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Follow annotated tags to the ultimate non-tag target ('' when unresolvable). */
function peelToNonTag(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return '';
    seen.add(current);
    const obj = repo.git.objects.get(current);
    if (!obj) return '';
    if (obj.type !== 'tag') return current;
    const target = parseTag(obj.data).object;
    if (!isObjectId(target)) return '';
    current = target;
  }
}

/** Every object reachable from `roots` (gitlinks skipped). Missing objects are skipped. */
function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.git.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Objects reachable from `haves`, but the walk does not descend into the
 * parents of commits listed in `shallowBoundaries` (a shallow clone holds
 * those commits but not their history).
 */
function heldReachable(repo: Repo, haves: readonly string[], shallowBoundaries: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.git.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowBoundaries.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return held;
}

/**
 * Depth-limited reachable set from `wants`. `depth` is the total depth from
 * the wants (want = depth 1): with depth 2 a want, its parents and their
 * trees/blobs are included, grandparents are not. `null` means unlimited.
 * Returns the included object ids and the shallow boundary commits (included
 * commits whose parent was cut off by the depth limit).
 */
function depthLimitedReachable(
  repo: Repo,
  wants: readonly string[],
  depth: number | null,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const expandedCommit = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    if (repo.git.objects.has(want)) queue.push({ oid: want, depth: 1 });
  }
  let head = 0;
  while (head < queue.length) {
    const item = queue[head++];
    const oid = item.oid;
    const d = item.depth;
    if (included.has(oid)) continue;
    const object = repo.git.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      if (depth !== null && d > depth) continue;
      if (expandedCommit.has(oid)) continue;
      expandedCommit.add(oid);
      included.add(oid);
      const commit = parseCommit(object.data);
      if (repo.git.objects.has(commit.tree)) queue.push({ oid: commit.tree, depth: d });
      for (const parent of commit.parents) {
        if (depth !== null && d + 1 > depth) {
          if (repo.git.objects.has(parent)) boundary.add(oid);
        } else {
          queue.push({ oid: parent, depth: d + 1 });
        }
      }
    } else if (object.type === 'tag') {
      included.add(oid);
      const target = parseTag(object.data).object;
      if (isObjectId(target) && repo.git.objects.has(target)) queue.push({ oid: target, depth: d });
    } else if (object.type === 'tree') {
      included.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (repo.git.objects.has(entry.oid)) queue.push({ oid: entry.oid, depth: d });
      }
    } else {
      included.add(oid);
    }
  }
  return { included, boundary };
}

/** True when `ancestorOid` is reachable from `descendantOid` (parents walk, tags peeled). */
function isAncestor(repo: Repo, ancestorOid: string, descendantOid: string): boolean {
  const start = peelToNonTag(repo, descendantOid);
  if (!start) return false;
  if (start === ancestorOid) return true;
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.git.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestorOid) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas). Deterministic order: by oid. */
function writePack(objects: ReadonlyMap<string, GitObject>): Buffer {
  const list = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const [, object] of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (v2/v3, OFS_DELTA + REF_DELTA, thin packs)
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
 * leaves out (an object the server already holds). The trailer checksum is
 * verified; any structural problem throws.
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor held by the server`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// deterministic time + commit building (helpers for rest.ts / mcp.ts)
// ---------------------------------------------------------------------------------------------

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** TRIAL_NOW as Unix epoch seconds, computed without Date (deterministic). */
function trialNowEpochSec(): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(TRIAL_NOW);
  if (!m) return 0;
  const days = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  return days * 86400 + Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
}

function buildCommitObject(treeOid: string, parents: readonly string[], message: string): Buffer {
  const epoch = trialNowEpochSec();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  let out = `tree ${treeOid}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// tree / file helpers
// ---------------------------------------------------------------------------------------------

interface FileEntry {
  oid: string;
  mode: string;
}

function treeFiles(repo: Repo, treeOid: string, prefix: string, out: Map<string, FileEntry>): void {
  const obj = repo.git.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') treeFiles(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** Flat path -> blob map for a commit (tags peeled); empty when unresolvable. */
function filesAtCommit(repo: Repo, commitSha: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  if (!commitSha) return out;
  let obj = repo.git.objects.get(commitSha);
  if (!obj) return out;
  if (obj.type === 'tag') {
    const target = peelToNonTag(repo, commitSha);
    if (!target) return out;
    obj = repo.git.objects.get(target);
  }
  if (!obj || obj.type !== 'commit') return out;
  treeFiles(repo, parseCommit(obj.data).tree, '', out);
  return out;
}

interface DirNode {
  files: Map<string, FileEntry>;
  dirs: Map<string, DirNode>;
}

/** Build (and store) the full tree for a flat path map; returns the root tree oid. */
function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, FileEntry>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segs = path.split('/').filter((s) => s.length > 0);
    if (!segs.length) continue;
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      let child = node.dirs.get(segs[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segs[i], child);
      }
      node = child;
    }
    node.files.set(segs[segs.length - 1], entry);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// exported helpers (used by rest.ts / graphql.ts / mcp.ts)
// ---------------------------------------------------------------------------------------------

export function commitFile(
  store: Store,
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  void store;
  const blobSha = putObject(repo, 'blob', content);
  const headTip = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const files = filesAtCommit(repo, headTip);
  const cleanPath = path.split('/').filter((s) => s.length > 0).join('/');
  files.set(cleanPath, { oid: blobSha, mode: '100644' });
  const treeSha = buildTreeFromFiles(repo, files);
  const commitSha = putObject(repo, 'commit', buildCommitObject(treeSha, headTip ? [headTip] : [], message));
  repo.git.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
  return { commitSha, blobSha };
}

export function readFileAtHead(store: Store, repo: Repo, path: string): Buffer | null {
  void store;
  const headTip = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const cleanPath = path.split('/').filter((s) => s.length > 0).join('/');
  const entry = filesAtCommit(repo, headTip).get(cleanPath);
  if (!entry) return null;
  const obj = repo.git.objects.get(entry.oid);
  if (!obj || obj.type !== 'blob') return null;
  return obj.data;
}

export function fileShaAtHead(store: Store, repo: Repo, path: string): string | null {
  void store;
  const headTip = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const cleanPath = path.split('/').filter((s) => s.length > 0).join('/');
  const entry = filesAtCommit(repo, headTip).get(cleanPath);
  if (!entry) return null;
  const obj = repo.git.objects.get(entry.oid);
  if (!obj || obj.type !== 'blob') return null;
  return entry.oid;
}

export function deleteFileAtHead(
  store: Store,
  repo: Repo,
  path: string,
  message: string,
): { commitSha: string } | null {
  void store;
  const headTip = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  if (!headTip) return null;
  const files = filesAtCommit(repo, headTip);
  const cleanPath = path.split('/').filter((s) => s.length > 0).join('/');
  if (!files.has(cleanPath)) return null;
  files.delete(cleanPath);
  const treeSha = buildTreeFromFiles(repo, files);
  const commitSha = putObject(repo, 'commit', buildCommitObject(treeSha, [headTip], message));
  repo.git.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
  return { commitSha };
}

export function mergePullSquash(store: Store, repo: Repo, pull: Pull): { commitSha: string } {
  void store;
  const headSha = pull.headSha || resolveRef(store, repo, pull.headRef);
  const baseSha = pull.baseSha || resolveRef(store, repo, pull.baseRef);
  let treeOid = '';
  if (headSha) {
    const headFiles = filesAtCommit(repo, headSha);
    // Rebuild the head tip's tree from its files so the squash tree is exact.
    // (filesAtCommit already resolved the head commit's tree.)
    if (headFiles.size > 0 || repo.git.objects.has(headSha)) {
      const headObj = repo.git.objects.get(peelToNonTag(repo, headSha) || headSha);
      if (headObj && headObj.type === 'commit') treeOid = parseCommit(headObj.data).tree;
    }
  }
  if (!treeOid) {
    if (baseSha) {
      const baseObj = repo.git.objects.get(peelToNonTag(repo, baseSha) || baseSha);
      if (baseObj && baseObj.type === 'commit') treeOid = parseCommit(baseObj.data).tree;
    }
    if (!treeOid) treeOid = putObject(repo, 'tree', Buffer.alloc(0));
  }
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitSha = putObject(repo, 'commit', buildCommitObject(treeOid, baseSha ? [baseSha] : [], message));
  const baseRefFull = pull.baseRef.startsWith('refs/') ? pull.baseRef : `refs/heads/${pull.baseRef}`;
  repo.git.refs.set(baseRefFull, commitSha);
  return { commitSha };
}

export function resolveRef(store: Store, repo: Repo, ref: string): string {
  void store;
  if (!ref) return '';
  if (HEX40.test(ref)) return ref;
  if (ref === 'HEAD') return repo.git.refs.get(repo.git.headRef) ?? '';
  if (ref.startsWith('refs/')) return repo.git.refs.get(ref) ?? '';
  const asHead = repo.git.refs.get(`refs/heads/${ref}`);
  if (asHead) return asHead;
  return repo.git.refs.get(`refs/tags/${ref}`) ?? '';
}

export function diffFiles(store: Store, repo: Repo, baseSha: string, headSha: string): string[] {
  void store;
  const baseFiles = filesAtCommit(repo, baseSha);
  const headFiles = filesAtCommit(repo, headSha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: string[] = [];
  for (const path of paths) {
    if (baseFiles.get(path)?.oid !== headFiles.get(path)?.oid) out.push(path);
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------------------------
// smart-HTTP handlers
// ---------------------------------------------------------------------------------------------

interface GitResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function plainResult(status: number, body: Buffer, contentType?: string): GitResult {
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  return { status, headers, body };
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.git.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** Peel an annotated tag ref to its ultimate target oid ('' when not a tag). */
function peeledOid(repo: Repo, oid: string): string {
  const obj = repo.git.objects.get(oid);
  if (!obj || obj.type !== 'tag') return '';
  return peelToNonTag(repo, oid);
}

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const base =
    service === 'git-upload-pack'
      ? `symref=HEAD:${repo.git.headRef} side-band-64k thin-pack ofs-delta shallow`
      : `symref=HEAD:${repo.git.headRef} report-status side-band-64k delete-refs ofs-delta`;
  return base;
}

/** v0 ref advertisement body (service preamble + refs, caps on the first line). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = `# service=${service}\n`;
  const parts: Buffer[] = [pktLine(serviceLine), pktFlush()];
  const caps = v0Capabilities(repo, service);
  const refs = sortedRefs(repo);
  const headTip = repo.git.refs.get(repo.git.headRef) ?? '';
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip || ZERO_OID} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement body (service preamble + `version 2` + caps). */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('agent\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function handleInfoRefs(
  repo: Repo | undefined,
  service: string,
  gitProtocolV2: boolean,
): GitResult {
  if (!repo) return plainResult(404, Buffer.alloc(0));
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) {
      return plainResult(200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    }
    return plainResult(200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
  }
  if (service === 'git-receive-pack') {
    return plainResult(200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
  }
  return plainResult(404, Buffer.alloc(0));
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

/** ls-refs v2 response lines for the repo, honouring server-side ref-prefix filtering. */
function lsRefsLines(repo: Repo, args: LsRefsArgs): string[] {
  const headTip = repo.git.refs.get(repo.git.headRef) ?? '';
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (keep('HEAD')) {
    const symref = args.symrefs ? ` symref-target:${repo.git.headRef}` : '';
    if (headTip) lines.push(`${headTip} HEAD${symref}`);
    else lines.push(`unborn HEAD${symref}`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return lines;
}

function handleLsRefs(repo: Repo, lines: string[]): GitResult {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  for (const line of lines.slice(1)) {
    if (line === 'delim') continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'unborn') continue;
    else if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    // Unknown ls-refs arguments are ignored (lenient server).
  }
  const parts: Buffer[] = [];
  for (const line of lsRefsLines(repo, args)) parts.push(pktLine(`${line}\n`));
  parts.push(pktFlush());
  return plainResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
  /** The client sent `done`: negotiation is over, so the v2 response must
   * not carry an `acknowledgments` section (real git in stateless mode goes
   * straight to the packfile and fails on it; the kit client parses sections
   * generically and tolerates its absence). */
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, done: false };
  for (const line of lines.slice(1)) {
    if (line === 'delim') continue;
    if (line === 'done') {
      args.done = true;
      continue;
    }
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (line.startsWith('filter ')) args.filter = line.slice(7);
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) continue;
    // Unknown fetch arguments are ignored (lenient server).
  }
  args.wants = [...new Set(args.wants)].filter((w) => isObjectId(w));
  args.haves = [...new Set(args.haves)].filter((h) => isObjectId(h));
  args.shallow = [...new Set(args.shallow)].filter((s) => isObjectId(s));
  return args;
}

/** The objects a fetch must deliver, plus the shallow boundary bookkeeping. */
function planFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const { included, boundary } = depthLimitedReachable(repo, args.wants, args.depth);
  const shallowSet = new Set(args.shallow);
  const held = heldReachable(repo, args.haves, shallowSet);
  const send = new Map<string, GitObject>();
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = repo.git.objects.get(oid);
    if (object) send.set(oid, object);
  }
  const shallow = [...boundary].filter((oid) => send.has(oid)).sort();
  const unshallow: string[] = [];
  for (const old of args.shallow) {
    const obj = repo.git.objects.get(old);
    if (!obj || obj.type !== 'commit') continue;
    if (!included.has(old) && !held.has(old)) continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => included.has(p) || held.has(p))) unshallow.push(old);
  }
  unshallow.sort();
  return { objects: send, shallow, unshallow };
}

/** ACK lines for the haves the server holds (NAK when none are held). */
function ackLines(repo: Repo, haves: readonly string[]): string[] {
  const held = haves.filter((h) => repo.git.objects.has(h));
  if (held.length === 0) return ['NAK'];
  const lines = held.map((h) => `ACK ${h}`);
  lines.push('ready');
  return lines;
}

/** Chunk a packfile into sideband band-1 pkt-lines (each <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function handleFetchV2(repo: Repo, lines: string[]): GitResult {
  const args = parseFetchArgs(lines);
  const parts: Buffer[] = [];
  if (!args.done) {
    const acks = ackLines(repo, args.haves);
    const ready = acks.includes('ready');
    parts.push(pktLine('acknowledgments\n'));
    for (const line of acks) parts.push(pktLine(`${line}\n`));
    if (!ready) {
      // NAK only: no packfile in this response — the client will send
      // another request (more haves, or done). End with a flush so the
      // client can read the response end; anything after it would corrupt
      // the next round on the keep-alive connection.
      parts.push(pktFlush());
      return plainResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    }
    // 'ready' was sent, so a packfile follows in this same response.
    // fetch-pack.c process_ack demands a DELIM here, not a flush:
    // "a DELIM is expected if 'ready' is sent, and a FLUSH otherwise".
    parts.push(pktDelim());
  }
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const part of sidebandPack(pack)) parts.push(part);
  parts.push(pktFlush());
  return plainResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(repo: Repo, body: Buffer): GitResult {
  const packets = decodePktLines(body);
  // Two sections split by the first flush: wants (+shallow/deepen), then have/done.
  const firstFlush = packets.findIndex((p) => p.kind === 'flush');
  const sectionLines = packetLines(firstFlush < 0 ? packets : packets.slice(0, firstFlush));
  const secondLines = packetLines(firstFlush < 0 ? [] : packets.slice(firstFlush + 1));
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, done: false };
  for (const line of sectionLines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  for (const line of secondLines) {
    if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
  }
  args.wants = [...new Set(args.wants)].filter((w) => isObjectId(w));
  args.haves = [...new Set(args.haves)].filter((h) => isObjectId(h));
  args.shallow = [...new Set(args.shallow)].filter((s) => isObjectId(s));
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const line of ackLines(repo, args.haves)) parts.push(pktLine(`${line}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const part of sidebandPack(pack)) parts.push(part);
  parts.push(pktFlush());
  return plainResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): GitResult {
  let parsed: { packets: PktPacket[]; rest: Buffer };
  try {
    parsed = decodePktLinesUntilFlush(body);
  } catch {
    return plainResult(400, Buffer.from('malformed pkt-line stream', 'utf8'), 'text/plain');
  }
  const lines = packetLines(parsed.packets);
  if (lines.length === 0) {
    return plainResult(400, Buffer.from('empty push', 'utf8'), 'text/plain');
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (i === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ').filter(Boolean);
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) {
      return plainResult(400, Buffer.from('malformed push command', 'utf8'), 'text/plain');
    }
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);

  // Unpack: ingest the pack (even when a ref update is later refused).
  let unpackDetail = 'ok';
  if (parsed.rest.length > 0) {
    try {
      const read = readPack(parsed.rest, (oid) => repo.git.objects.get(oid));
      for (const [oid, object] of read.objects) repo.git.objects.set(oid, object);
    } catch (err) {
      unpackDetail = `unpacker error: ${(err as Error).message}`;
    }
  } else if (hasUpdates) {
    unpackDetail = 'unpacker error: missing packfile';
  }

  const reportLines: string[] = [];
  if (unpackDetail === 'ok') {
    for (const command of commands) {
      const current = repo.git.refs.get(command.ref);
      let verdict: { ok: boolean; reason: string } | null = null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) verdict = { ok: false, reason: 'ref does not exist' };
        else if (current !== command.oldOid) verdict = { ok: false, reason: 'old value mismatch' };
        else verdict = { ok: true, reason: '' };
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) verdict = { ok: false, reason: 'already exists' };
        else if (!repo.git.objects.has(command.newOid)) verdict = { ok: false, reason: 'object not found' };
        else if (command.ref.startsWith('refs/heads/')) {
          const peeled = peelToNonTag(repo, command.newOid);
          const target = peeled ? repo.git.objects.get(peeled) : undefined;
          verdict =
            target && target.type === 'commit'
              ? { ok: true, reason: '' }
              : { ok: false, reason: 'not a commit' };
        } else verdict = { ok: true, reason: '' };
      } else {
        // Update.
        if (current === undefined) verdict = { ok: false, reason: 'ref does not exist' };
        else if (current !== command.oldOid) verdict = { ok: false, reason: 'non-fast-forward' };
        else if (!repo.git.objects.has(command.newOid)) verdict = { ok: false, reason: 'object not found' };
        else if (command.ref.startsWith('refs/heads/')) {
          verdict = isAncestor(repo, command.oldOid, command.newOid)
            ? { ok: true, reason: '' }
            : { ok: false, reason: 'non-fast-forward' };
        } else verdict = { ok: true, reason: '' };
      }
      if (verdict.ok) {
        if (command.newOid === ZERO_OID) repo.git.refs.delete(command.ref);
        else repo.git.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      } else {
        reportLines.push(`ng ${command.ref} ${verdict.reason}`);
      }
    }
  }

  const innerLines = [`unpack ${unpackDetail}`, ...reportLines];
  const parts: Buffer[] = [];
  if (sideband) {
    // The report lines are pkt-line framed INSIDE the sideband payload, and
    // the inner stream ends with its own flush: the client's sideband demux
    // strips one level and hands the inner pkt-lines to its status reader,
    // which needs the inner flush to stop (a bare outer flush only ends the
    // demux, leaving the reader at EOF). This is exactly how git's own
    // receive-pack frames it (one band-1 packet holding the whole inner
    // report, then an outer flush).
    const inner = Buffer.concat([...innerLines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
    for (const part of sidebandPack(inner)) parts.push(part);
    parts.push(pktFlush());
  } else {
    for (const line of innerLines) parts.push(pktLine(`${line}\n`));
    parts.push(pktFlush());
  }
  return plainResult(200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

function parseGitPath(pathname: string): { owner: string; repoName: string; tail: string[] } | null {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  if (!parts[1].endsWith('.git')) return null;
  return { owner: parts[0], repoName: parts[1].slice(0, -4), tail: parts.slice(2) };
}

export function handleGit(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
): GitResult {
  try {
    const parsed = parseGitPath(pathname);
    if (!parsed) return plainResult(404, Buffer.alloc(0));
    const repo = store.getRepo(parsed.owner, parsed.repoName);
    const verb = method.toUpperCase();
    const gitProtocol = getHeader(headers, 'Git-Protocol') ?? '';
    const wantsV2 = gitProtocol.includes('version=2');

    if (verb === 'GET' && parsed.tail.length === 2 && parsed.tail[0] === 'info' && parsed.tail[1] === 'refs') {
      const service = query.get('service') ?? '';
      return handleInfoRefs(repo, service, wantsV2);
    }
    if (verb === 'POST' && parsed.tail.length === 1 && parsed.tail[0] === 'git-upload-pack') {
      if (!repo) return plainResult(404, Buffer.alloc(0));
      if (wantsV2) {
        let packets: PktPacket[];
        try {
          packets = decodePktLines(body);
        } catch {
          return plainResult(400, Buffer.from('malformed pkt-line stream', 'utf8'), 'text/plain');
        }
        const lines = packetLines(packets);
        const command = lines[0] ?? '';
        if (command === 'command=ls-refs') return handleLsRefs(repo, lines);
        if (command === 'command=fetch') return handleFetchV2(repo, lines);
        return plainResult(400, Buffer.from('unknown upload-pack command', 'utf8'), 'text/plain');
      }
      try {
        return handleFetchV0(repo, body);
      } catch {
        return plainResult(400, Buffer.from('malformed pkt-line stream', 'utf8'), 'text/plain');
      }
    }
    if (verb === 'POST' && parsed.tail.length === 1 && parsed.tail[0] === 'git-receive-pack') {
      if (!repo) return plainResult(404, Buffer.alloc(0));
      return handleReceivePack(repo, body);
    }
    return plainResult(404, Buffer.alloc(0));
  } catch {
    return plainResult(500, Buffer.from('internal error', 'utf8'), 'text/plain');
  }
}
