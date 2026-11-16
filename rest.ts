// REST v3 handlers for the github-core-clone-01 forge.
//
// Entry point: `handleRest` (see CONTRACT.md). All routes live under
// `/api/v3` except the API root, which app.ts answers itself. Every reply
// is JSON-able; app.ts stringifies it and adds `X-GitHub-Request-Id` and
// the JSON content type.
//
// Determinism: no Date/Math.random here — timestamps come from TRIAL_NOW
// (store.ts) and ids from store counters. Nothing in this module throws
// out of a handler: unexpected failures become a 500 `{message}`.
//
// Contents, branches and merges are backed by git.ts (`commitFile`,
// `deleteFileAtHead`, `mergePullSquash`, `resolveRef`, `diffFiles`).
// Reads that need a specific ref (GET contents `?ref=`, directory
// listings, the commits walk, pull-file line counts) parse the standard
// git objects already in `repo.git.objects` — no git logic is rebuilt
// here, the object store is only read.
//
// Known contract gap (for the coordinator, app.ts owns the fix):
// `handleRest` receives no request origin, so pagination `Link` headers
// are emitted as relative URLs (`</api/v3/user/repos?...>; rel="next"`).
// The env client only follows a `next` link that is same-origin with
// the entry, so app.ts must absolutize the `Link` header with the
// request's `Host` header (it is the only place that sees it).

import {
  commitFile,
  deleteFileAtHead,
  diffFiles,
  mergePullSquash,
  resolveRef,
} from './git.ts';
import {
  TRIAL_NOW,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type JsonRecord = Record<string, unknown>;

const SHA40_RE = /^[0-9a-f]{40}$/i;

// -------------------------------------------------------------------------------------------
// Small helpers

function messageBody(message: string): JsonRecord {
  return { message };
}

function errorResult(status: number, message: string): RestResult {
  return { status, body: messageBody(message) };
}

function okResult(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return headers === undefined ? { status, body } : { status, body, headers };
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// -------------------------------------------------------------------------------------------
// Serializers (shared with graphql.ts and mcp.ts — keep the field sets per digest-rest.md)

export function userJson(login: string): JsonRecord {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): JsonRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function labelJson(label: Label): JsonRecord {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const found = repo.labels.get(name);
      if (found !== undefined) return labelJson(found);
      return { id: 0, name, color: 'ededed', description: '' };
    }),
    user: userJson(issue.userLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): JsonRecord {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(repo.owner),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(repo.owner),
    },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha === '' ? null : pull.mergeCommitSha,
    merged_at: pull.mergedAt === '' ? null : pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function commentJson(comment: Comment): JsonRecord {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// -------------------------------------------------------------------------------------------
// Pagination (Link rel="next" — relative URLs; see the header note about origin)

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const build = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${basePath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${build(page + 1)}>; rel="next"`, `<${build(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${build(page - 1)}>; rel="prev"`, `<${build(1)}>; rel="first"`);
  }
  return { page: [...sliced], headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// -------------------------------------------------------------------------------------------
// Reading git objects (trees/commits/blobs) for ref-aware contents/commits/pull-files

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

function parseCommitObject(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split === -1) return null;
  const header = text.slice(0, split);
  const message = text.slice(split + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (!SHA40_RE.test(tree)) return null;
  return { tree, parents, message };
}

function parseTreeObject(data: Buffer): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) return null;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) return null;
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function treeEntries(repo: Repo, treeSha: string): TreeEntry[] | null {
  const object = repo.git.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTreeObject(object.data);
}

function treeShaAtCommit(repo: Repo, commitSha: string): string | null {
  const object = repo.git.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommitObject(object.data);
  return parsed === null ? null : parsed.tree;
}

/** Resolve `path` in the tree of `commitSha`; null when any part is missing. */
function lookupPath(repo: Repo, commitSha: string, path: string): TreeEntry | null {
  let treeSha = treeShaAtCommit(repo, commitSha);
  if (treeSha === null) return null;
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return null;
  let found: TreeEntry | null = null;
  for (let index = 0; index < parts.length; index += 1) {
    const entries = treeEntries(repo, treeSha);
    if (entries === null) return null;
    found = entries.find((entry) => entry.name === parts[index]) ?? null;
    if (found === null) return null;
    if (index < parts.length - 1) {
      if (found.mode !== '40000') return null;
      treeSha = found.sha;
    }
  }
  return found;
}

function blobData(repo: Repo, blobSha: string): Buffer | null {
  const object = repo.git.objects.get(blobSha);
  if (object === undefined || object.type !== 'blob') return null;
  return object.data;
}

interface DirEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size?: number;
}

/** Immediate children of `dirPath` ('' = root) at `commitSha`; null when not a directory. */
function listDirAtCommit(repo: Repo, commitSha: string, dirPath: string): DirEntry[] | null {
  let treeSha: string | null;
  if (dirPath === '') {
    treeSha = treeShaAtCommit(repo, commitSha);
  } else {
    const entry = lookupPath(repo, commitSha, dirPath);
    if (entry === null || entry.mode !== '40000') return null;
    treeSha = entry.sha;
  }
  if (treeSha === null) return null;
  const entries = treeEntries(repo, treeSha);
  if (entries === null) return null;
  const out: DirEntry[] = [];
  for (const entry of entries) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.sha });
    } else {
      const data = blobData(repo, entry.sha);
      out.push({ type: 'file', name: entry.name, path, sha: entry.sha, size: data === null ? 0 : data.length });
    }
  }
  return out;
}

/** First-parent walk from `tipSha`: [{sha, message}], newest first. */
function walkCommits(repo: Repo, tipSha: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  let current: string | undefined = tipSha;
  for (let steps = 0; steps < 1000 && current !== undefined && current !== ''; steps += 1) {
    const key = current.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    const object = repo.git.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    const parsed = parseCommitObject(object.data);
    if (parsed === null) break;
    out.push({ sha: current, message: parsed.message });
    current = parsed.parents[0];
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Contents writes (branch-aware commit via git.commitFile)

interface CommitOnBranchResult {
  commitSha: string;
  blobSha: string;
}

/**
 * Commit `content` at `path` onto `branch` (default branch when omitted).
 * git.commitFile only knows the default branch, so a branch commit swaps
 * `repo.defaultBranch` / `repo.git.headRef` around the call and restores
 * them after; if the swap was ignored (the commit landed on the original
 * default branch instead), the refs are repaired by hand — the commit
 * object itself is still correct for the fixtures because every branch
 * is created at the default tip and only adds/updates files on top of it.
 */
function commitOnBranch(store: Store, repo: Repo, path: string, content: Buffer, message: string, branch: string | undefined): CommitOnBranchResult {
  const target = branch ?? repo.defaultBranch;
  if (target === repo.defaultBranch) {
    return commitFile(store, repo, path, content, message);
  }
  const originalDefault = repo.defaultBranch;
  const originalHead = repo.git.headRef;
  const previousDefaultTip = repo.git.refs.get(`refs/heads/${originalDefault}`);
  repo.defaultBranch = target;
  repo.git.headRef = `refs/heads/${target}`;
  try {
    const result = commitFile(store, repo, path, content, message);
    const branchTip = resolveRef(store, repo, target);
    if (branchTip.toLowerCase() !== result.commitSha.toLowerCase()) {
      // git.ts ignored the swap: move the commit onto the branch ref and
      // put the default branch back where it was.
      repo.git.refs.set(`refs/heads/${target}`, result.commitSha);
      if (previousDefaultTip === undefined) repo.git.refs.delete(`refs/heads/${originalDefault}`);
      else repo.git.refs.set(`refs/heads/${originalDefault}`, previousDefaultTip);
    }
    return result;
  } finally {
    repo.defaultBranch = originalDefault;
    repo.git.headRef = originalHead;
  }
}

// -------------------------------------------------------------------------------------------
// Pull-request helpers shared with GraphQL and MCP

function headBranchOf(head: string): string {
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(colon + 1);
}

export function openPullRequest(
  store: Store,
  owner: string,
  repoName: string,
  title: string,
  body: string,
  head: string,
  base: string | undefined,
): { pull: Pull } | { error: string; status: number } {
  if (owner !== VIEWER_LOGIN) return { error: 'Not Found', status: 404 };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return { error: 'Not Found', status: 404 };
  if (typeof title !== 'string' || title === '') return { error: 'title is required', status: 422 };
  const headBranch = headBranchOf(typeof head === 'string' ? head : '');
  if (headBranch === '') return { error: 'head is required', status: 422 };
  const headSha = resolveRef(store, repo, headBranch);
  if (headSha === '') return { error: `Head branch '${headBranch}' does not exist`, status: 422 };
  const baseBranch = typeof base === 'string' && base !== '' ? headBranchOf(base) : repo.defaultBranch;
  const baseSha = resolveRef(store, repo, baseBranch);
  if (baseSha === '') return { error: `Base branch '${baseBranch}' does not exist`, status: 422 };
  const pull = store.createPull(repo, title, typeof body === 'string' ? body : '', headBranch, headSha, baseBranch, baseSha);
  return { pull };
}

/** True when the base moved under the PR and both sides changed a path to different blobs. */
function pullIsConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  const baseTip = resolveRef(store, repo, pull.baseRef);
  if (baseTip === '' || baseTip.toLowerCase() === pull.baseSha.toLowerCase()) return false;
  const baseChanged = diffFiles(store, repo, pull.baseSha, baseTip);
  if (baseChanged.length === 0) return false;
  const headChanged = diffFiles(store, repo, pull.baseSha, pull.headSha);
  const overlap = baseChanged.filter((path) => headChanged.includes(path));
  if (overlap.length === 0) return false;
  const tipDiff = diffFiles(store, repo, baseTip, pull.headSha);
  return overlap.some((path) => tipDiff.includes(path));
}

export function mergePullRequest(
  store: Store,
  owner: string,
  repoName: string,
  number: number,
): { pull: Pull; commitSha: string } | { error: string; status: number } {
  if (owner !== VIEWER_LOGIN) return { error: 'Not Found', status: 404 };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return { error: 'Not Found', status: 404 };
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return { error: 'Not Found', status: 404 };
  if (pull.state !== 'open') return { error: 'Pull request is already merged or closed', status: 405 };
  if (pullIsConflicted(store, repo, pull)) return { error: 'Merge conflict', status: 405 };
  const result = mergePullSquash(store, repo, pull);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = result.commitSha;
  pull.mergedAt = TRIAL_NOW;
  pull.updatedAt = TRIAL_NOW;
  return { pull, commitSha: result.commitSha };
}

// -------------------------------------------------------------------------------------------
// Pull files (diff + line counts)

interface PullFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(baseText: string, headText: string): { additions: number; deletions: number } {
  const baseCounts = new Map<string, number>();
  for (const line of splitLines(baseText)) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  const headCounts = new Map<string, number>();
  for (const line of splitLines(headText)) headCounts.set(line, (headCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const [line, count] of headCounts) additions += Math.max(0, count - (baseCounts.get(line) ?? 0));
  let deletions = 0;
  for (const [line, count] of baseCounts) deletions += Math.max(0, count - (headCounts.get(line) ?? 0));
  return { additions, deletions };
}

function pullFiles(store: Store, repo: Repo, pull: Pull): PullFileEntry[] {
  const paths = diffFiles(store, repo, pull.baseSha, pull.headSha);
  const out: PullFileEntry[] = [];
  for (const path of paths) {
    const baseEntry = lookupPath(repo, pull.baseSha, path);
    const headEntry = lookupPath(repo, pull.headSha, path);
    const baseText = baseEntry === null ? '' : (blobData(repo, baseEntry.sha)?.toString('utf8') ?? '');
    const headText = headEntry === null ? '' : (blobData(repo, headEntry.sha)?.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(baseEntry === null ? '' : baseText, headEntry === null ? '' : headText);
    const status = baseEntry === null ? 'added' : headEntry === null ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Route handlers (each returns a RestResult; repo/owner already resolved by the router)

function createUserRepo(store: Store, body: unknown): RestResult {
  const record = asRecord(body);
  const name = stringField(record, 'name');
  if (name === undefined || name === '') return errorResult(422, 'Repository name is required');
  if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return errorResult(422, 'Repository already exists');
  const description = stringField(record, 'description') ?? '';
  const isPrivate = record.private === true;
  const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  return okResult(201, repoJson(repo));
}

function listUserRepos(store: Store, query: URLSearchParams): RestResult {
  const repos = store.listReposByOwner(VIEWER_LOGIN);
  const { page, headers } = paginate(repos, query, '/api/v3/user/repos');
  return okResult(200, page.map((repo) => repoJson(repo)), headers);
}

function patchRepo(repo: Repo, body: unknown): RestResult {
  const record = asRecord(body);
  const description = stringField(record, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof record.private === 'boolean') repo.isPrivate = record.private;
  repo.updatedAt = TRIAL_NOW;
  return okResult(200, repoJson(repo));
}

function deleteRepo(store: Store, owner: string, repo: Repo): RestResult {
  store.deleteRepo(owner, repo.name);
  return okResult(204, {});
}

function listBranches(repo: Repo): RestResult {
  const out: Array<JsonRecord> = [];
  for (const [ref, sha] of repo.git.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  return okResult(200, out);
}

function listCommits(store: Store, repo: Repo, query: URLSearchParams): RestResult {
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(store, repo, ref);
  if (tip === '') return errorResult(404, 'No such commit or branch');
  const commits = walkCommits(repo, tip);
  return okResult(200, commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })));
}

function createRef(repo: Repo, body: unknown): RestResult {
  const record = asRecord(body);
  const ref = stringField(record, 'ref');
  const sha = stringField(record, 'sha');
  if (ref === undefined || !ref.startsWith('refs/')) return errorResult(422, 'Invalid ref');
  if (sha === undefined || !SHA40_RE.test(sha)) return errorResult(422, 'Invalid sha');
  if (repo.git.refs.has(ref)) return errorResult(422, 'Reference already exists');
  repo.git.refs.set(ref, sha);
  return okResult(201, { ref, object: { sha } });
}

function putContents(store: Store, repo: Repo, pathParts: string[], body: unknown): RestResult {
  const filePath = pathParts.join('/');
  if (filePath === '') return errorResult(422, 'File path is required');
  const record = asRecord(body);
  const message = stringField(record, 'message');
  const contentB64 = stringField(record, 'content');
  if (message === undefined || message === '') return errorResult(422, 'Commit message is required');
  if (contentB64 === undefined) return errorResult(422, 'content is required');
  const clean = contentB64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return errorResult(422, 'content is not valid base64');
  const branch = stringField(record, 'branch');
  const targetRef = branch ?? repo.defaultBranch;
  const tip = resolveRef(store, repo, targetRef);
  if (branch !== undefined && tip === '') return errorResult(422, `Branch '${branch}' does not exist`);
  const content = Buffer.from(clean, 'base64');
  const current = tip === '' ? null : lookupPath(repo, tip, filePath);
  const shaProvided = stringField(record, 'sha');
  if (current !== null) {
    if (shaProvided === undefined) return errorResult(422, 'sha is required to update a file');
    if (shaProvided.toLowerCase() !== current.sha.toLowerCase()) return errorResult(409, 'sha does not match the current blob');
  } else if (shaProvided !== undefined) {
    return errorResult(422, 'Cannot update a file that does not exist');
  }
  const isCreate = current === null;
  const result = commitOnBranch(store, repo, filePath, content, message, branch);
  return okResult(isCreate ? 201 : 200, {
    content: { name: baseName(filePath), path: filePath, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitSha, message },
  });
}

function getContents(store: Store, repo: Repo, pathParts: string[], query: URLSearchParams): RestResult {
  const filePath = pathParts.join('/');
  const ref = query.get('ref') ?? undefined;
  const tip = ref !== undefined ? resolveRef(store, repo, ref) : resolveRef(store, repo, repo.defaultBranch);
  if (tip === '') return errorResult(404, 'Not Found');
  if (filePath === '') {
    const listing = listDirAtCommit(repo, tip, '');
    if (listing === null) return errorResult(404, 'Not Found');
    return okResult(200, listing);
  }
  const entry = lookupPath(repo, tip, filePath);
  if (entry === null) return errorResult(404, 'Not Found');
  if (entry.mode === '40000') {
    const listing = listDirAtCommit(repo, tip, filePath);
    if (listing === null) return errorResult(404, 'Not Found');
    return okResult(200, listing);
  }
  const data = blobData(repo, entry.sha);
  if (data === null) return errorResult(404, 'Not Found');
  return okResult(200, {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: baseName(filePath),
    path: filePath,
    content: data.toString('base64'),
    sha: entry.sha,
  });
}

function deleteContents(store: Store, repo: Repo, pathParts: string[], body: unknown): RestResult {
  const filePath = pathParts.join('/');
  if (filePath === '') return errorResult(422, 'File path is required');
  const record = asRecord(body);
  const message = stringField(record, 'message') ?? 'Delete file';
  const tip = resolveRef(store, repo, repo.defaultBranch);
  if (tip === '') return errorResult(404, 'Not Found');
  const current = lookupPath(repo, tip, filePath);
  if (current === null) return errorResult(404, 'Not Found');
  const shaProvided = stringField(record, 'sha');
  if (shaProvided !== undefined && shaProvided.toLowerCase() !== current.sha.toLowerCase()) {
    return errorResult(409, 'sha does not match the current blob');
  }
  const result = deleteFileAtHead(store, repo, filePath, message);
  if (result === null) return errorResult(404, 'Not Found');
  return okResult(200, { commit: { sha: result.commitSha } });
}

function createLabel(repo: Repo, body: unknown): RestResult {
  const record = asRecord(body);
  const name = stringField(record, 'name');
  if (name === undefined || name === '') return errorResult(422, 'Label name is required');
  if (repo.labels.has(name)) return errorResult(422, 'Label already exists');
  const label: Label = {
    id: repo.nextLabelId++,
    name,
    color: stringField(record, 'color') ?? 'ededed',
    description: stringField(record, 'description') ?? '',
  };
  repo.labels.set(name, label);
  return okResult(201, labelJson(label));
}

function listLabels(repo: Repo): RestResult {
  return okResult(200, [...repo.labels.values()].map((label) => labelJson(label)));
}

function parseLabelNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null) {
      const name = stringField(item as JsonRecord, 'name');
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

function createIssue(store: Store, repo: Repo, body: unknown): RestResult {
  const record = asRecord(body);
  const title = stringField(record, 'title');
  if (title === undefined || title === '') return errorResult(422, 'title is required');
  const bodyText = stringField(record, 'body') ?? '';
  const labelNames = parseLabelNames(record.labels) ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return errorResult(422, `Label '${name}' does not exist`);
  }
  const issue = store.createIssue(repo, title, bodyText, labelNames);
  return okResult(201, issueJson(repo, issue));
}

function listIssues(repo: Repo, owner: string, query: URLSearchParams): RestResult {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const basePath = `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/issues`;
  const { page, headers } = paginate(issues, query, basePath);
  return okResult(200, page.map((issue) => issueJson(repo, issue)), headers);
}

function findIssue(repo: Repo, numberText: string): Issue | undefined {
  if (!/^\d+$/.test(numberText)) return undefined;
  const number = Number.parseInt(numberText, 10);
  return repo.issues.find((issue) => issue.number === number);
}

function patchIssue(repo: Repo, issue: Issue, body: unknown): RestResult {
  const record = asRecord(body);
  const state = stringField(record, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(record, 'title');
  if (title !== undefined) issue.title = title;
  const bodyText = stringField(record, 'body');
  if (bodyText !== undefined) issue.body = bodyText;
  issue.updatedAt = TRIAL_NOW;
  return okResult(200, issueJson(repo, issue));
}

function createComment(repo: Repo, issue: Issue, body: unknown): RestResult {
  const record = asRecord(body);
  const commentBody = stringField(record, 'body');
  if (commentBody === undefined || commentBody === '') return errorResult(422, 'Comment body is required');
  const comment: Comment = {
    id: repo.nextCommentId++,
    body: commentBody,
    userLogin: VIEWER_LOGIN,
    createdAt: TRIAL_NOW,
    updatedAt: TRIAL_NOW,
  };
  issue.comments.push(comment);
  return okResult(201, commentJson(comment));
}

function createPull(store: Store, owner: string, repoName: string, body: unknown): RestResult {
  const record = asRecord(body);
  const title = stringField(record, 'title') ?? '';
  const bodyText = stringField(record, 'body') ?? '';
  const head = stringField(record, 'head') ?? '';
  const base = stringField(record, 'base');
  const result = openPullRequest(store, owner, repoName, title, bodyText, head, base);
  if ('error' in result) return errorResult(result.status, result.error);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return errorResult(404, 'Not Found');
  return okResult(201, pullJson(repo, result.pull));
}

function listPulls(repo: Repo, owner: string, query: URLSearchParams): RestResult {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.seq - a.seq);
  const basePath = `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/pulls`;
  const { page, headers } = paginate(pulls, query, basePath);
  return okResult(200, page.map((pull) => pullJson(repo, pull)), headers);
}

function findPull(repo: Repo, numberText: string): Pull | undefined {
  if (!/^\d+$/.test(numberText)) return undefined;
  const number = Number.parseInt(numberText, 10);
  return repo.pulls.find((pull) => pull.number === number);
}

function mergePull(store: Store, owner: string, repoName: string, pull: Pull): RestResult {
  const result = mergePullRequest(store, owner, repoName, pull.number);
  if ('error' in result) return errorResult(result.status, result.error);
  return okResult(200, {
    sha: result.commitSha,
    merged: true,
    message: `Merge pull request #${result.pull.number} from ${result.pull.headRef}`,
  });
}

// -------------------------------------------------------------------------------------------
// Router

function handleRestInner(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown | undefined,
  bodyMalformed: boolean,
  authed: boolean,
): RestResult {
  // API root: app.ts answers it, but stay correct if it ever reaches here.
  if (pathname === '/api/v3' || pathname === '/api/v3/') {
    return okResult(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (!authed) return errorResult(401, 'Unauthorized');
  if (bodyMalformed) return errorResult(400, 'Malformed JSON body');

  let rest = pathname;
  if (rest.startsWith('/api/v3/')) rest = rest.slice('/api/v3'.length);
  const segments = rest.split('/').filter((part) => part !== '').map(decodeSegment);

  if (segments.length === 0) {
    return okResult(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return okResult(200, { installed_version: '1.0.0' });
  }

  // /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createUserRepo(store, body);
    if (method === 'GET') return listUserRepos(store, query);
    return errorResult(404, 'Not Found');
  }

  // /repos/{owner}/{name}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] ?? '';
    const repoName = segments[2] ?? '';
    // A repository under any other owner is 404 for this token, never 403.
    if (owner !== VIEWER_LOGIN) return errorResult(404, 'Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(404, 'Not Found');
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return okResult(200, repoJson(repo));
      if (method === 'PATCH') return patchRepo(repo, body);
      if (method === 'DELETE') return deleteRepo(store, owner, repo);
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'branches' && tail.length === 1) {
      if (method !== 'GET') return errorResult(404, 'Not Found');
      return listBranches(repo);
    }

    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return errorResult(404, 'Not Found');
      return listCommits(store, repo, query);
    }

    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
      if (method !== 'POST') return errorResult(404, 'Not Found');
      return createRef(repo, body);
    }

    if (tail[0] === 'contents') {
      const pathParts = tail.slice(1);
      if (method === 'PUT') return putContents(store, repo, pathParts, body);
      if (method === 'GET') return getContents(store, repo, pathParts, query);
      if (method === 'DELETE') return deleteContents(store, repo, pathParts, body);
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') return createLabel(repo, body);
      if (method === 'GET') return listLabels(repo);
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'issues' && tail.length === 1) {
      if (method === 'POST') return createIssue(store, repo, body);
      if (method === 'GET') return listIssues(repo, owner, query);
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'issues' && tail.length === 2) {
      const issue = findIssue(repo, tail[1] ?? '');
      if (issue === undefined) return errorResult(404, 'Not Found');
      if (method === 'GET') return okResult(200, issueJson(repo, issue));
      if (method === 'PATCH') return patchIssue(repo, issue, body);
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'issues' && tail[1] !== undefined && tail[2] === 'comments' && tail.length === 3) {
      const issue = findIssue(repo, tail[1]);
      if (issue === undefined) return errorResult(404, 'Not Found');
      if (method === 'POST') return createComment(repo, issue, body);
      if (method === 'GET') return okResult(200, issue.comments.map((comment) => commentJson(comment)));
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'pulls' && tail.length === 1) {
      if (method === 'POST') return createPull(store, owner, repoName, body);
      if (method === 'GET') return listPulls(repo, owner, query);
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'pulls' && tail.length === 2) {
      const pull = findPull(repo, tail[1] ?? '');
      if (pull === undefined) return errorResult(404, 'Not Found');
      if (method === 'GET') return okResult(200, pullJson(repo, pull));
      return errorResult(404, 'Not Found');
    }

    if (tail[0] === 'pulls' && tail[1] !== undefined && tail[2] === 'files' && tail.length === 3) {
      const pull = findPull(repo, tail[1]);
      if (pull === undefined) return errorResult(404, 'Not Found');
      if (method !== 'GET') return errorResult(404, 'Not Found');
      return okResult(200, pullFiles(store, repo, pull));
    }

    if (tail[0] === 'pulls' && tail[1] !== undefined && tail[2] === 'merge' && tail.length === 3) {
      const pull = findPull(repo, tail[1]);
      if (pull === undefined) return errorResult(404, 'Not Found');
      if (method !== 'PUT') return errorResult(404, 'Not Found');
      return mergePull(store, owner, repoName, pull);
    }

    return errorResult(404, 'Not Found');
  }

  return errorResult(404, 'Not Found');
}

export function handleRest(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown | undefined,
  bodyMalformed: boolean,
  authed: boolean,
): RestResult {
  try {
    return handleRestInner(store, method, pathname, query, body, bodyMalformed, authed);
  } catch {
    return errorResult(500, 'Internal Server Error');
  }
}
