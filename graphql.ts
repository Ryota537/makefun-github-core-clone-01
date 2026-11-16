// GraphQL v4 executor for the github-core-clone-01 forge.
//
// Implements exactly the operations the make.fun env exercises (see
// work-gcc/digest-graphql-mcp.md section A): viewer, repository (+ issues
// with states filter + orderBy, issue by number, pullRequests/pullRequest),
// createIssue, closeIssue, createPullRequest (via rest.openPullRequest),
// mergePullRequest (via rest.mergePullRequest, SQUASH), addComment,
// introspection __type for Issue/PullRequest/Repository (+ SearchType enum),
// Query.node(id:) with inline fragments, and batched requests.
//
// Notes:
// - Global ids are opaque and stable: base64("<Kind>:<numeric id>"), never
//   random, never the raw database id / issue number.
// - No Date.now() / new Date() / Math.random() anywhere; timestamps come
//   from TRIAL_NOW via the store.
// - The handler never throws: every failure inside becomes a GraphQL
//   errors payload (HTTP 200 for field/validation errors, HTTP 400 only
//   for malformed requests / syntax errors, HTTP 401 without auth).
// - Unknown field -> HTTP 200 + errors naming the field. Unknown repo ->
//   data.repository = null with no errors.
// - PR file lists are computed by walking the stored git trees inline
//   (commit -> tree -> recursive entries); no dependency on git.ts.
// - GraphQL field shapes are built by the resolvers below (global ids,
//   uppercase enums); the REST serializers in rest.ts describe REST
//   shapes, so they are not reused here — only openPullRequest and
//   mergePullRequest are imported from rest.ts, per CONTRACT.md.

import { VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, TRIAL_NOW } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { openPullRequest, mergePullRequest } from './rest.ts';

// ---------------------------------------------------------------------------
// Errors (internal control flow only; never escape handleGraphQL)
// ---------------------------------------------------------------------------

class GqlError extends Error {}

// ---------------------------------------------------------------------------
// Global ids: opaque + stable across reads
// ---------------------------------------------------------------------------

function gid(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; value: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx <= 0) return null;
    return { kind: decoded.slice(0, idx), value: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function findPullById(store: Store, id: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && input[j] !== '"') {
        const c = input[j] as string;
        if (c === '\\' && j + 1 < n) {
          const esc = input[j + 1] as string;
          if (esc === 'u' && j + 5 < n) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += c;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k += 1;
        if (/[0-9]/.test(input[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`GraphQL syntax error: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent; directives are parsed and ignored)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  tokens: Token[];
  pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const tok = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new GqlError(`GraphQL syntax error: expected '${value}' but got '${tok.value}'`);
    }
  }

  matchPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') {
      throw new GqlError(`GraphQL syntax error: expected a name but got '${tok.value}'`);
    }
    return tok.value;
  }

  skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.parseArguments();
      }
    }
  }

  parseType(): void {
    // Type = Name | [Type] with optional trailing '!'; value is not needed.
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return defs;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) {
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: parseFloat(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new GqlError(`GraphQL syntax error: unexpected value token '${tok.value}'`);
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
      }
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        this.next();
        const kind = tok.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVariableDefinitions();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, varDefs, selections });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onTok = this.expectName();
        if (onTok !== 'on') {
          throw new GqlError(`GraphQL syntax error: expected 'on' in fragment definition`);
        }
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selections });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'subscription') {
        throw new GqlError('GraphQL subscriptions are not supported');
      }
      throw new GqlError(`GraphQL syntax error: unexpected token '${tok.value}'`);
    }
    return { operations, fragments };
  }
}

function parseDocument(query: string): Document {
  return new Parser(lex(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// Value resolution (variables, literals)
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(field.args)) {
    out[key] = resolveValue(field.args[key] as ValueNode, variables);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Introspection model (field lists match what the resolvers support)
// ---------------------------------------------------------------------------

interface TypeInfo {
  name: string;
  kind: 'OBJECT' | 'ENUM';
  fields: string[] | null;
  enumValues: string[] | null;
  description: string | null;
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state'],
    enumValues: null,
    description: 'An issue in a repository.',
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
    enumValues: null,
    description: 'A pull request in a repository.',
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: null,
    description: 'A repository.',
  },
  User: {
    name: 'User',
    kind: 'OBJECT',
    fields: ['id', 'login', 'name'],
    enumValues: null,
    description: 'A user.',
  },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    fields: null,
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE', 'TOPIC', 'WIKI', 'MARKETPLACE', 'MILESTONE', 'PROJECT'],
    description: 'The types of search results.',
  },
  IssueState: {
    name: 'IssueState',
    kind: 'ENUM',
    fields: null,
    enumValues: ['OPEN', 'CLOSED'],
    description: null,
  },
  PullRequestState: {
    name: 'PullRequestState',
    kind: 'ENUM',
    fields: null,
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
    description: null,
  },
  MergeableState: {
    name: 'MergeableState',
    kind: 'ENUM',
    fields: null,
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
    description: null,
  },
  PullRequestMergeMethod: {
    name: 'PullRequestMergeMethod',
    kind: 'ENUM',
    fields: null,
    enumValues: ['MERGE', 'SQUASH', 'REBASE'],
    description: null,
  },
  RepositoryPermission: {
    name: 'RepositoryPermission',
    kind: 'ENUM',
    fields: null,
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
    description: null,
  },
  IssueOrderField: {
    name: 'IssueOrderField',
    kind: 'ENUM',
    fields: null,
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
    description: null,
  },
  OrderDirection: {
    name: 'OrderDirection',
    kind: 'ENUM',
    fields: null,
    enumValues: ['ASC', 'DESC'],
    description: null,
  },
};

// ---------------------------------------------------------------------------
// Pagination helpers (opaque cursors over the store sequence number)
// ---------------------------------------------------------------------------

function issueCursor(issue: Issue): string {
  return Buffer.from(`cursor:${issue.seq}`, 'utf8').toString('base64');
}

function parseCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginateIssues(list: Issue[], first: unknown, after: unknown): Page<Issue> {
  let start = 0;
  const afterSeq = parseCursor(after);
  if (afterSeq !== null) {
    const idx = list.findIndex((issue) => issue.seq === afterSeq);
    start = idx >= 0 ? idx + 1 : list.length;
  }
  const limit = typeof first === 'number' && first >= 0 ? Math.floor(first) : list.length - start;
  const nodes = list.slice(start, start + limit);
  return {
    nodes,
    hasNextPage: start + nodes.length < list.length,
    endCursor: nodes.length > 0 ? issueCursor(nodes[nodes.length - 1] as Issue) : null,
    startCursor: nodes.length > 0 ? issueCursor(nodes[0] as Issue) : null,
  };
}

// ---------------------------------------------------------------------------
// Git tree walk (PR files): commit -> tree -> recursive entries
// ---------------------------------------------------------------------------

function commitTreeSha(repo: Repo, commitSha: string): string | null {
  const obj = repo.git.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const m = /^tree ([0-9a-f]{40})$/m.exec(text);
  return m ? (m[1] as string) : null;
}

function walkTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.git.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  const buf = obj.data;
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = buf.toString('utf8', off, sp);
    const nul = buf.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > buf.length) break;
    const name = buf.toString('utf8', sp + 1, nul);
    const sha = buf.subarray(nul + 1, nul + 21).toString('hex');
    off = nul + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') {
      walkTree(repo, sha, path, out);
    } else {
      out.set(path, sha);
    }
  }
}

function diffPaths(repo: Repo, baseSha: string, headSha: string): string[] {
  const base = new Map<string, string>();
  const head = new Map<string, string>();
  const baseTree = baseSha !== '' ? commitTreeSha(repo, baseSha) : null;
  const headTree = headSha !== '' ? commitTreeSha(repo, headSha) : null;
  if (baseTree) walkTree(repo, baseTree, '', base);
  if (headTree) walkTree(repo, headTree, '', head);
  const paths = new Set<string>();
  for (const [p, s] of base) if (head.get(p) !== s) paths.add(p);
  for (const [p, s] of head) if (base.get(p) !== s) paths.add(p);
  return [...paths].sort();
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

type Source = Repo | Issue | Pull | Record<string, unknown>;

function unknownField(typeName: string, fieldName: string): never {
  throw new GqlError(`Field '${fieldName}' doesn't exist on type '${typeName}'`);
}

function collectFields(
  selections: SelectionNode[],
  fragments: Map<string, FragmentDef>,
  runtimeType: string,
): FieldNode[] {
  const out: FieldNode[] = [];
  for (const sel of selections) {
    if (sel.kind === 'field') {
      out.push(sel);
    } else if (sel.kind === 'inline') {
      if (sel.typeCondition === null || sel.typeCondition === runtimeType) {
        out.push(...collectFields(sel.selections, fragments, runtimeType));
      }
    } else if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (frag && frag.typeCondition === runtimeType) {
        out.push(...collectFields(frag.selections, fragments, runtimeType));
      }
    }
  }
  return out;
}

function resolveSelectionSet(
  typeName: string,
  source: Source,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (selections === null) return out;
  for (const field of collectFields(selections, ctx.fragments, typeName)) {
    out[field.alias ?? field.name] = resolveField(typeName, source, field, ctx);
  }
  return out;
}

function requireSelections(field: FieldNode, typeName: string): SelectionNode[] {
  if (field.selections === null) {
    throw new GqlError(`Field '${field.name}' of type '${typeName}' must have a selection of subfields`);
  }
  return field.selections;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function viewerUser(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME };
}

function sortIssues(list: Issue[], orderBy: unknown): Issue[] {
  const obj = (orderBy !== null && typeof orderBy === 'object' ? orderBy : {}) as Record<string, unknown>;
  const field = typeof obj.field === 'string' ? obj.field : 'CREATED_AT';
  const direction = typeof obj.direction === 'string' ? obj.direction : 'ASC';
  const sorted = [...list];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (field === 'COMMENTS') {
      cmp = a.comments.length - b.comments.length;
    } else {
      // CREATED_AT / UPDATED_AT: every timestamp is TRIAL_NOW, so the
      // store sequence number is the creation order.
      cmp = a.seq - b.seq;
    }
    if (cmp === 0) cmp = a.seq - b.seq;
    return direction === 'DESC' ? -cmp : cmp;
  });
  return sorted;
}

function resolveIssuesConnection(repo: Repo, field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args = resolveArgs(field, ctx.variables);
  let list = [...repo.issues];
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  list = sortIssues(list, args.orderBy);
  const page = paginateIssues(list, args.first, args.after);
  const selections = requireSelections(field, 'Repository');
  const out: Record<string, unknown> = {};
  for (const sub of collectFields(selections, ctx.fragments, 'IssueConnection')) {
    if (sub.name === 'nodes') {
      const nodeSels = requireSelections(sub, 'IssueConnection');
      out[sub.alias ?? sub.name] = page.nodes.map((issue) => resolveSelectionSet('Issue', issue, nodeSels, ctx));
    } else if (sub.name === 'pageInfo') {
      const infoSels = requireSelections(sub, 'IssueConnection');
      out[sub.alias ?? sub.name] = resolveSelectionSet('PageInfo', {
        hasNextPage: page.hasNextPage,
        endCursor: page.endCursor,
        startCursor: page.startCursor,
        hasPreviousPage: false,
      }, infoSels, ctx);
    } else if (sub.name === 'totalCount') {
      out[sub.alias ?? sub.name] = list.length;
    } else if (sub.name === '__typename') {
      out[sub.alias ?? sub.name] = 'IssueConnection';
    } else {
      unknownField('IssueConnection', sub.name);
    }
  }
  return out;
}

function resolvePullsConnection(repo: Repo, field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args = resolveArgs(field, ctx.variables);
  const list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
  const limit = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : list.length;
  const nodes = list.slice(0, limit);
  const selections = requireSelections(field, 'Repository');
  const out: Record<string, unknown> = {};
  for (const sub of collectFields(selections, ctx.fragments, 'PullRequestConnection')) {
    if (sub.name === 'nodes') {
      const nodeSels = requireSelections(sub, 'PullRequestConnection');
      out[sub.alias ?? sub.name] = nodes.map((pull) => resolveSelectionSet('PullRequest', pull, nodeSels, ctx));
    } else if (sub.name === 'pageInfo') {
      const infoSels = requireSelections(sub, 'PullRequestConnection');
      out[sub.alias ?? sub.name] = resolveSelectionSet('PageInfo', {
        hasNextPage: nodes.length < list.length,
        endCursor: null,
        startCursor: null,
        hasPreviousPage: false,
      }, infoSels, ctx);
    } else if (sub.name === 'totalCount') {
      out[sub.alias ?? sub.name] = list.length;
    } else if (sub.name === '__typename') {
      out[sub.alias ?? sub.name] = 'PullRequestConnection';
    } else {
      unknownField('PullRequestConnection', sub.name);
    }
  }
  return out;
}

function resolveIssue(repo: Repo, issue: Issue, field: FieldNode, ctx: Ctx): Record<string, unknown> {
  return resolveSelectionSet('Issue', issue, requireSelections(field, 'Repository'), ctx);
}

function resolvePull(repo: Repo, pull: Pull, field: FieldNode, ctx: Ctx): Record<string, unknown> {
  return resolveSelectionSet('PullRequest', pull, requireSelections(field, 'Repository'), ctx);
}

function resolveNode(ctx: Ctx, field: FieldNode): Record<string, unknown> | null {
  const args = resolveArgs(field, ctx.variables);
  const id = typeof args.id === 'string' ? args.id : '';
  const parsed = parseGid(id);
  if (!parsed) return null;
  const num = parseInt(parsed.value, 10);
  if (Number.isNaN(num)) return null;
  const selections = requireSelections(field, 'Query');
  if (parsed.kind === 'Repository') {
    const repo = findRepoById(ctx.store, num);
    if (!repo) return null;
    return resolveSelectionSet('Repository', repo, selections, ctx);
  }
  if (parsed.kind === 'Issue') {
    const found = findIssueById(ctx.store, num);
    if (!found) return null;
    return resolveSelectionSet('Issue', found.issue, selections, ctx);
  }
  if (parsed.kind === 'PullRequest') {
    const found = findPullById(ctx.store, num);
    if (!found) return null;
    return resolveSelectionSet('PullRequest', found.pull, selections, ctx);
  }
  return null;
}

function resolveTypeField(ctx: Ctx, field: FieldNode): Record<string, unknown> | null {
  const args = resolveArgs(field, ctx.variables);
  const name = typeof args.name === 'string' ? args.name : '';
  const info = TYPE_INFO[name];
  if (!info) return null;
  const selections = requireSelections(field, 'Query');
  const out: Record<string, unknown> = {};
  for (const sub of collectFields(selections, ctx.fragments, '__Type')) {
    if (sub.name === 'name') {
      out[sub.alias ?? sub.name] = info.name;
    } else if (sub.name === 'kind') {
      out[sub.alias ?? sub.name] = info.kind;
    } else if (sub.name === 'description') {
      out[sub.alias ?? sub.name] = info.description;
    } else if (sub.name === 'fields') {
      if (info.fields === null) {
        out[sub.alias ?? sub.name] = null;
      } else {
        const sels = requireSelections(sub, '__Type');
        out[sub.alias ?? sub.name] = info.fields.map((f) =>
          resolveSelectionSet('__TypeField', { name: f, description: null }, sels, ctx),
        );
      }
    } else if (sub.name === 'enumValues') {
      if (info.enumValues === null) {
        out[sub.alias ?? sub.name] = null;
      } else {
        const sels = requireSelections(sub, '__Type');
        out[sub.alias ?? sub.name] = info.enumValues.map((v) =>
          resolveSelectionSet('__TypeEnumValue', { name: v, description: null }, sels, ctx),
        );
      }
    } else if (sub.name === '__typename') {
      out[sub.alias ?? sub.name] = '__Type';
    } else {
      unknownField('__Type', sub.name);
    }
  }
  return out;
}

function inputObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new GqlError(`Argument '${key}' must be an input object`);
}

function inputString(input: Record<string, unknown>, key: string, required: boolean): string {
  const value = input[key];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) {
    if (required) throw new GqlError(`Input field '${key}' is required`);
    return '';
  }
  throw new GqlError(`Input field '${key}' must be a string`);
}

function resolveMutation(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const args = resolveArgs(field, ctx.variables);
  const selections = requireSelections(field, 'Mutation');
  switch (field.name) {
    case 'createIssue': {
      const input = inputObject(args, 'input');
      const repositoryId = inputString(input, 'repositoryId', true);
      const title = inputString(input, 'title', true);
      const body = inputString(input, 'body', false);
      const parsed = parseGid(repositoryId);
      if (!parsed || parsed.kind !== 'Repository') {
        throw new GqlError(`Could not resolve repository id '${repositoryId}'`);
      }
      const repoId = parseInt(parsed.value, 10);
      const repo = Number.isNaN(repoId) ? undefined : findRepoById(ctx.store, repoId);
      if (!repo) throw new GqlError(`Could not resolve repository id '${repositoryId}'`);
      const issue = ctx.store.createIssue(repo, title, body, []);
      return resolveSelectionSet('CreateIssuePayload', { issue }, selections, ctx);
    }
    case 'closeIssue': {
      const input = inputObject(args, 'input');
      const issueId = inputString(input, 'issueId', true);
      const parsed = parseGid(issueId);
      if (!parsed || parsed.kind !== 'Issue') {
        throw new GqlError(`Could not resolve issue id '${issueId}'`);
      }
      const id = parseInt(parsed.value, 10);
      const found = Number.isNaN(id) ? undefined : findIssueById(ctx.store, id);
      if (!found) throw new GqlError(`Could not resolve issue id '${issueId}'`);
      found.issue.state = 'closed';
      found.issue.updatedAt = TRIAL_NOW;
      return resolveSelectionSet('CloseIssuePayload', { issue: found.issue }, selections, ctx);
    }
    case 'createPullRequest': {
      const input = inputObject(args, 'input');
      const repositoryId = inputString(input, 'repositoryId', true);
      const baseRefName = inputString(input, 'baseRefName', true);
      const headRefName = inputString(input, 'headRefName', true);
      const title = inputString(input, 'title', true);
      const parsed = parseGid(repositoryId);
      if (!parsed || parsed.kind !== 'Repository') {
        throw new GqlError(`Could not resolve repository id '${repositoryId}'`);
      }
      const repoId = parseInt(parsed.value, 10);
      const repo = Number.isNaN(repoId) ? undefined : findRepoById(ctx.store, repoId);
      if (!repo) throw new GqlError(`Could not resolve repository id '${repositoryId}'`);
      const result = openPullRequest(ctx.store, repo.owner, repo.name, title, '', headRefName, baseRefName);
      if ('error' in result) {
        throw new GqlError(result.error);
      }
      return resolveSelectionSet('CreatePullRequestPayload', { pullRequest: result.pull }, selections, ctx);
    }
    case 'mergePullRequest': {
      const input = inputObject(args, 'input');
      const pullRequestId = inputString(input, 'pullRequestId', true);
      const parsed = parseGid(pullRequestId);
      if (!parsed || parsed.kind !== 'PullRequest') {
        throw new GqlError(`Could not resolve pull request id '${pullRequestId}'`);
      }
      const id = parseInt(parsed.value, 10);
      const found = Number.isNaN(id) ? undefined : findPullById(ctx.store, id);
      if (!found) throw new GqlError(`Could not resolve pull request id '${pullRequestId}'`);
      const result = mergePullRequest(ctx.store, found.repo.owner, found.repo.name, found.pull.number);
      if ('error' in result) {
        throw new GqlError(result.error);
      }
      return resolveSelectionSet('MergePullRequestPayload', { pullRequest: result.pull }, selections, ctx);
    }
    case 'addComment': {
      const input = inputObject(args, 'input');
      const subjectId = inputString(input, 'subjectId', true);
      const body = inputString(input, 'body', true);
      const parsed = parseGid(subjectId);
      if (!parsed || parsed.kind !== 'Issue') {
        throw new GqlError(`Could not resolve subject id '${subjectId}'`);
      }
      const id = parseInt(parsed.value, 10);
      const found = Number.isNaN(id) ? undefined : findIssueById(ctx.store, id);
      if (!found) throw new GqlError(`Could not resolve subject id '${subjectId}'`);
      const comment = {
        id: found.repo.nextCommentId++,
        body,
        userLogin: VIEWER_LOGIN,
        createdAt: TRIAL_NOW,
        updatedAt: TRIAL_NOW,
      };
      found.issue.comments.push(comment);
      const node = { id: gid('IssueComment', `${found.repo.id}:${comment.id}`), body: comment.body };
      return resolveSelectionSet('AddCommentPayload', { commentEdge: { node } }, selections, ctx);
    }
    default:
      return unknownField('Mutation', field.name);
  }
}

function resolveField(typeName: string, source: Source, field: FieldNode, ctx: Ctx): unknown {
  if (field.name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return resolveSelectionSet('User', viewerUser(), requireSelections(field, 'Query'), ctx);
        case 'repository': {
          const args = resolveArgs(field, ctx.variables);
          const owner = typeof args.owner === 'string' ? args.owner : '';
          const name = typeof args.name === 'string' ? args.name : '';
          const repo = ctx.store.getRepo(owner, name);
          if (!repo) return null;
          return resolveSelectionSet('Repository', repo, requireSelections(field, 'Query'), ctx);
        }
        case 'node':
          return resolveNode(ctx, field);
        case '__type':
          return resolveTypeField(ctx, field);
        default:
          return unknownField('Query', field.name);
      }
    }
    case 'Mutation':
      return resolveMutation(ctx, field);
    case 'User': {
      const user = source as Record<string, unknown>;
      switch (field.name) {
        case 'login':
          return user.login ?? VIEWER_LOGIN;
        case 'name':
          return user.name ?? VIEWER_NAME;
        case 'id': {
          const numeric = typeof user.id === 'number' ? user.id : VIEWER_ID;
          return gid('User', numeric);
        }
        default:
          return unknownField('User', field.name);
      }
    }
    case 'Repository': {
      const repo = source as Repo;
      switch (field.name) {
        case 'id':
          return gid('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return resolveSelectionSet(
            'User',
            { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, name: repo.owner === VIEWER_LOGIN ? VIEWER_NAME : repo.owner },
            requireSelections(field, 'Repository'),
            ctx,
          );
        case 'defaultBranchRef':
          return resolveSelectionSet('Ref', { name: repo.defaultBranch }, requireSelections(field, 'Repository'), ctx);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const args = resolveArgs(field, ctx.variables);
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.find((i) => i.number === number);
          if (!issue) return null;
          return resolveIssue(repo, issue, field, ctx);
        }
        case 'issues':
          return resolveIssuesConnection(repo, field, ctx);
        case 'pullRequests':
          return resolvePullsConnection(repo, field, ctx);
        case 'pullRequest': {
          const args = resolveArgs(field, ctx.variables);
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.find((p) => p.number === number);
          if (!pull) return null;
          return resolvePull(repo, pull, field, ctx);
        }
        default:
          return unknownField('Repository', field.name);
      }
    }
    case 'Ref': {
      const ref = source as Record<string, unknown>;
      if (field.name === 'name') return ref.name ?? null;
      return unknownField('Ref', field.name);
    }
    case 'Issue': {
      const issue = source as Issue;
      switch (field.name) {
        case 'id':
          return gid('Issue', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueState(issue);
        default:
          return unknownField('Issue', field.name);
      }
    }
    case 'PullRequest': {
      const pull = source as Pull;
      switch (field.name) {
        case 'id':
          return gid('PullRequest', pull.id);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
        case 'files': {
          // The Pull record does not carry its repo; find it by pull id.
          const found = findPullById(ctx.store, pull.id);
          const repo = found ? found.repo : undefined;
          const paths = repo ? diffPaths(repo, pull.baseSha, pull.headSha) : [];
          const args = resolveArgs(field, ctx.variables);
          const limit = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : paths.length;
          const nodes = paths.slice(0, limit).map((path) => ({ path }));
          return resolveSelectionSet('PullRequestChangedFileConnection', { nodes }, requireSelections(field, 'PullRequest'), ctx);
        }
        default:
          return unknownField('PullRequest', field.name);
      }
    }
    case 'PullRequestChangedFileConnection': {
      // Entered once per requested subfield of the connection (nodes /
      // totalCount / __typename); dispatch on the subfield itself.
      const conn = source as Record<string, unknown>;
      const nodes = (conn.nodes ?? []) as Record<string, unknown>[];
      if (field.name === 'nodes') {
        const nodeSels = requireSelections(field, 'PullRequestChangedFileConnection');
        return nodes.map((n) => resolveSelectionSet('PullRequestChangedFile', n, nodeSels, ctx));
      }
      if (field.name === 'totalCount') return nodes.length;
      if (field.name === '__typename') return 'PullRequestChangedFileConnection';
      return unknownField('PullRequestChangedFileConnection', field.name);
    }
    case 'PullRequestChangedFile': {
      const file = source as Record<string, unknown>;
      if (field.name === 'path') return file.path ?? null;
      return unknownField('PullRequestChangedFile', field.name);
    }
    case 'PageInfo': {
      const info = source as Record<string, unknown>;
      switch (field.name) {
        case 'hasNextPage':
          return info.hasNextPage ?? false;
        case 'hasPreviousPage':
          return info.hasPreviousPage ?? false;
        case 'endCursor':
          return info.endCursor ?? null;
        case 'startCursor':
          return info.startCursor ?? null;
        default:
          return unknownField('PageInfo', field.name);
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = source as Record<string, unknown>;
      if (field.name === 'issue') {
        return resolveSelectionSet('Issue', payload.issue as Issue, requireSelections(field, typeName), ctx);
      }
      return unknownField(typeName, field.name);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = source as Record<string, unknown>;
      if (field.name === 'pullRequest') {
        return resolveSelectionSet('PullRequest', payload.pullRequest as Pull, requireSelections(field, typeName), ctx);
      }
      return unknownField(typeName, field.name);
    }
    case 'AddCommentPayload': {
      const payload = source as Record<string, unknown>;
      if (field.name === 'commentEdge') {
        return resolveSelectionSet('IssueCommentEdge', payload.commentEdge as Record<string, unknown>, requireSelections(field, typeName), ctx);
      }
      return unknownField(typeName, field.name);
    }
    case 'IssueCommentEdge': {
      const edge = source as Record<string, unknown>;
      if (field.name === 'node') {
        return resolveSelectionSet('IssueComment', edge.node as Record<string, unknown>, requireSelections(field, typeName), ctx);
      }
      return unknownField('IssueCommentEdge', field.name);
    }
    case 'IssueComment': {
      const comment = source as Record<string, unknown>;
      if (field.name === 'id') return comment.id ?? null;
      if (field.name === 'body') return comment.body ?? null;
      return unknownField('IssueComment', field.name);
    }
    case '__TypeField':
    case '__TypeEnumValue': {
      const item = source as Record<string, unknown>;
      if (field.name === 'name') return item.name ?? null;
      if (field.name === 'description') return item.description ?? null;
      return unknownField(typeName, field.name);
    }
    default:
      return unknownField(typeName, field.name);
  }
}

function selectOperation(doc: Document, operationName: unknown): Operation {
  if (typeof operationName === 'string' && operationName !== '') {
    const found = doc.operations.find((op) => op.name === operationName);
    if (!found) throw new GqlError(`Unknown operation named '${operationName}'`);
    return found;
  }
  if (doc.operations.length === 1) return doc.operations[0] as Operation;
  if (doc.operations.length === 0) throw new GqlError('No operation found in document');
  throw new GqlError('Must provide operation name when there are multiple operations');
}

function executeOperation(store: Store, doc: Document, operationName: unknown, variables: Record<string, unknown>): Record<string, unknown> {
  const op = selectOperation(doc, operationName);
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== null) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx: Ctx = { store, variables: vars, fragments: doc.fragments };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const source: Source = {};
  return resolveSelectionSet(rootType, source, op.selections, ctx);
}

// ---------------------------------------------------------------------------
// Single-operation runner (never throws)
// ---------------------------------------------------------------------------

function badRequest(message: string): { status: number; body: unknown } {
  return { status: 400, body: { errors: [{ message }] } };
}

function runSingle(store: Store, entry: unknown): { status: number; body: unknown } {
  try {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return badRequest('Request body must be a JSON object with a query string');
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return badRequest('Request body must include a query string');
    }
    const variables = record.variables;
    const vars: Record<string, unknown> =
      variables !== null && typeof variables === 'object' && !Array.isArray(variables)
        ? (variables as Record<string, unknown>)
        : {};
    let doc: Document;
    try {
      doc = parseDocument(query);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'GraphQL syntax error';
      return { status: 400, body: { errors: [{ message }] } };
    }
    try {
      const data = executeOperation(store, doc, record.operationName, vars);
      return { status: 200, body: { data } };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Internal error';
      return { status: 200, body: { data: null, errors: [{ message }] } };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Internal error';
    return { status: 200, body: { data: null, errors: [{ message }] } };
  }
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export function handleGraphQL(
  store: Store,
  body: unknown,
  authed: boolean,
): { status: number; body: unknown } {
  try {
    if (!authed) {
      return { status: 401, body: { data: null, errors: [{ message: 'Unauthorized' }] } };
    }
    let parsed: unknown = body;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return badRequest('Request body is not valid JSON');
      }
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => runSingle(store, entry).body);
      return { status: 200, body: results };
    }
    return runSingle(store, parsed);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Internal error';
    return { status: 200, body: { data: null, errors: [{ message }] } };
  }
}
