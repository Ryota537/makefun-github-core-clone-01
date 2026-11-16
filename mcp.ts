// MCP (Model Context Protocol) handler for the github-core-clone-01 forge.
//
// JSON-RPC 2.0 over Streamable HTTP at POST /mcp. Answers application/json
// only (no SSE stream: the suite's client also accepts a plain JSON body).
//
// Two protocol eras are served from the same handler:
//   modern 2026-07-28: `server/discover` (identity + capabilities +
//           supportedVersions in one request), then tools/list/call with no
//           handshake and no protocol-level session.
//   legacy  2025-11-25 and earlier: `initialize` (echoes the offered
//           revision) + `notifications/initialized`.
//
// No session id is ever issued: handleMcp has no way to return response
// headers, and the client only sends Mcp-Session-Id when the server first
// issued one, so issuing none is the safe choice (no session to echo).
//
// Determinism: no Date.now(), no new Date(), no Math.random(). The tool
// list is built once as a module-level const, so two tools/list calls are
// byte-identical. tools/call executes against the same store via rest.ts
// helpers + serializers; no per-call shared mutable state, so concurrent
// calls stay independent. Never throws out of the handler.

import { Store, VIEWER_LOGIN } from './store.ts';
import { issueJson, mergePullRequest, openPullRequest, pullJson, repoJson } from './rest.ts';

export const MCP_PREFERRED_REVISION = '2026-07-28';
export const MCP_LEGACY_REVISIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  MCP_PREFERRED_REVISION,
  ...MCP_LEGACY_REVISIONS,
];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const MCP_UNSUPPORTED_VERSION = -32022;
const MCP_UNAUTHORIZED = -32001;

type JsonRpcId = string | number | null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function strProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function boolProp(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

function intProp(description: string): Record<string, unknown> {
  return { type: 'integer', description };
}

/** Built once at module load: two tools/list calls must be byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: strProp('Name of the repository to create.'),
        description: strProp('A short description of the repository.'),
        private: boolProp('Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the issue.'),
        body: strProp('Body text of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        state: {
          type: 'string',
          description: 'Issue state filter: open, closed, or all.',
          enum: ['open', 'closed', 'all'],
        },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the pull request.'),
        body: strProp('Body text of the pull request.'),
        head: strProp('Name of the head branch.'),
        base: strProp('Name of the base branch.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        pull_number: intProp('Number of the pull request to merge.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lowerHeaders(headers: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(headers ?? {})) {
    out.set(key.toLowerCase(), value);
  }
  return out;
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Lenient id extraction for error answers (auth / parse failures). */
function idOf(value: unknown): JsonRpcId {
  if (isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number')) return value.id;
  return null;
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'GitHub core clone MCP server: create and read repositories, issues, and pull requests.',
    serverInfo: serverInfo(),
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

// ---------------------------------------------------------------------------
// Argument synonyms (digest B.7): the suite maps each semantic to the
// property name the tool's own schema uses; accept every listed spelling.
// ---------------------------------------------------------------------------

const OWNER_KEYS = ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'];
const REPO_KEYS = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'];
const FULL_NAME_KEYS = ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'];
const TITLE_KEYS = ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'];
const BODY_KEYS = ['body', 'issue_body', 'description', 'content', 'text', 'comment'];
const HEAD_KEYS = ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'];
const BASE_KEYS = ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'];
const PULL_NUMBER_KEYS = ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'];
const NAME_KEYS = ['name', 'repo', 'repository', 'repository_name', 'repo_name'];
const DESCRIPTION_KEYS = ['description', 'about', 'summary', 'body'];
const PRIVATE_KEYS = ['private', 'is_private'];
const STATE_KEYS = ['state', 'status'];

function pickRaw(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickStr(args: Record<string, unknown>, keys: string[]): string | undefined {
  const value = pickRaw(args, keys);
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function pickBool(args: Record<string, unknown>, keys: string[]): boolean | undefined {
  const value = pickRaw(args, keys);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function pickInt(args: Record<string, unknown>, keys: string[]): number | undefined {
  const value = pickRaw(args, keys);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Resolve owner + repo from arguments. An explicit owner/repo wins; a
 * `full_name` of the form "owner/repo" fills in whichever part is missing.
 */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string | undefined; repo: string | undefined } {
  let owner = pickStr(args, OWNER_KEYS);
  let repo = pickStr(args, REPO_KEYS);
  const fullName = pickStr(args, FULL_NAME_KEYS);
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      if (owner === undefined) owner = fullName.slice(0, slash);
      if (repo === undefined) repo = fullName.slice(slash + 1);
    }
  }
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

function toolOk(structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// tools/call executors (all run against the same store)
// ---------------------------------------------------------------------------

function callCreateRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const name = pickStr(args, NAME_KEYS);
  if (name === undefined) return toolError('Missing required argument: name');
  const owner = pickStr(args, OWNER_KEYS) ?? VIEWER_LOGIN;
  if (owner !== VIEWER_LOGIN) return toolError(`Not Found: owner ${owner} does not exist`);
  if (store.getRepo(owner, name) !== undefined) {
    return toolError(`Repository ${owner}/${name} already exists`);
  }
  const description = pickStr(args, DESCRIPTION_KEYS) ?? '';
  const isPrivate = pickBool(args, PRIVATE_KEYS) ?? false;
  const repo = store.createRepo(owner, name, description, isPrivate);
  return toolOk(repoJson(repo));
}

function callGetRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repoName === undefined) return toolError('Missing required argument: repo');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${repoName} does not exist`);
  return toolOk(repoJson(repo));
}

function callCreateIssue(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repoName === undefined) return toolError('Missing required argument: repo');
  const title = pickStr(args, TITLE_KEYS);
  if (title === undefined) return toolError('Missing required argument: title');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${repoName} does not exist`);
  const body = pickStr(args, BODY_KEYS) ?? '';
  const issue = store.createIssue(repo, title, body, []);
  return toolOk(issueJson(repo, issue));
}

function callListIssues(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repoName === undefined) return toolError('Missing required argument: repo');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${repoName} does not exist`);
  const state = pickStr(args, STATE_KEYS) ?? 'open';
  const filtered = repo.issues
    .filter((issue) => state === 'all' || issue.state === state)
    .sort((a, b) => a.number - b.number)
    .map((issue) => issueJson(repo, issue));
  return toolOk({ issues: filtered });
}

function callCreatePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repoName === undefined) return toolError('Missing required argument: repo');
  const title = pickStr(args, TITLE_KEYS);
  if (title === undefined) return toolError('Missing required argument: title');
  const head = pickStr(args, HEAD_KEYS);
  if (head === undefined) return toolError('Missing required argument: head');
  const base = pickStr(args, BASE_KEYS);
  if (base === undefined) return toolError('Missing required argument: base');
  const body = pickStr(args, BODY_KEYS) ?? '';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${repoName} does not exist`);
  const res = openPullRequest(store, owner, repoName, title, body, head, base);
  if ('error' in res) return toolError(res.error);
  return toolOk(pullJson(repo, res.pull));
}

function callMergePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repoName === undefined) return toolError('Missing required argument: repo');
  const pullNumber = pickInt(args, PULL_NUMBER_KEYS);
  if (pullNumber === undefined) return toolError('Missing required argument: pull_number');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Not Found: repository ${owner}/${repoName} does not exist`);
  const res = mergePullRequest(store, owner, repoName, pullNumber);
  if ('error' in res) return toolError(res.error);
  return toolOk(pullJson(repo, res.pull));
}

const TOOL_HANDLERS: Record<string, (store: Store, args: Record<string, unknown>) => Record<string, unknown>> = {
  create_repo: callCreateRepo,
  get_repo: callGetRepo,
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
};

/** The protocol version a request declares, from `_meta` or params. */
function requestedVersion(params: Record<string, unknown>): string | undefined {
  if (typeof params.protocolVersion === 'string') return params.protocolVersion;
  const meta = params._meta;
  if (isRecord(meta)) {
    const v = meta['io.modelcontextprotocol/protocolVersion'];
    if (typeof v === 'string') return v;
    const plain = meta.protocolVersion;
    if (typeof plain === 'string') return plain;
  }
  return undefined;
}

interface McpAnswer {
  status: number;
  body: unknown;
}

/** Handle one parsed JSON-RPC request object (never throws). */
function handleOne(
  store: Store,
  request: unknown,
  headers: Map<string, string>,
): McpAnswer {
  try {
    if (!isRecord(request)) {
      return { status: 400, body: rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object') };
    }
    const id: JsonRpcId = idOf(request);
    const method = request.method;
    if (typeof method !== 'string' || method === '') {
      return { status: 400, body: rpcError(id, JSON_RPC_INVALID_REQUEST, 'Invalid Request: missing method') };
    }
    const params: Record<string, unknown> = isRecord(request.params) ? request.params : {};

    // Notifications carry no id and get no JSON-RPC response: HTTP 202.
    if (id === null && request.id === undefined) {
      return { status: 202, body: {} };
    }

    if (method === 'server/discover') {
      const declared = requestedVersion(params) ?? headers.get('mcp-protocol-version');
      if (declared !== undefined && !MCP_SUPPORTED_VERSIONS.includes(declared)) {
        return {
          status: 200,
          body: rpcError(id, MCP_UNSUPPORTED_VERSION, `Unsupported protocol version: ${declared}`, {
            supported: [...MCP_SUPPORTED_VERSIONS],
          }),
        };
      }
      return { status: 200, body: rpcResult(id, discoverResult()) };
    }

    if (method === 'initialize') {
      const offered = requestedVersion(params);
      if (offered === undefined) {
        return {
          status: 200,
          body: rpcResult(id, {
            protocolVersion: MCP_PREFERRED_REVISION,
            capabilities: { tools: {} },
            serverInfo: serverInfo(),
          }),
        };
      }
      if (!MCP_SUPPORTED_VERSIONS.includes(offered)) {
        // -32602 so a legacy client retries with its next offered revision.
        return { status: 200, body: rpcError(id, JSON_RPC_INVALID_PARAMS, `Unsupported protocol version: ${offered}`) };
      }
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        }),
      };
    }

    if (method === 'ping') {
      return { status: 200, body: rpcResult(id, {}) };
    }

    if (method === 'tools/list') {
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    }

    if (method === 'tools/call') {
      const name = params.name;
      if (typeof name !== 'string' || name === '') {
        return { status: 200, body: rpcError(id, JSON_RPC_INVALID_PARAMS, 'Invalid params: tools/call requires a tool name') };
      }
      const handler = TOOL_HANDLERS[name];
      if (handler === undefined) {
        return { status: 200, body: rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`) };
      }
      const args: Record<string, unknown> = isRecord(params.arguments) ? params.arguments : {};
      return { status: 200, body: rpcResult(id, handler(store, args)) };
    }

    return { status: 200, body: rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 200, body: rpcError(idOf(request), JSON_RPC_INTERNAL_ERROR, `Internal error: ${message}`) };
  }
}

/**
 * MCP entry point: JSON-RPC 2.0 over Streamable HTTP.
 * Returns application/json; never throws.
 */
export function handleMcp(
  store: Store,
  rawText: string,
  headers: Record<string, string>,
  authed: boolean,
): { status: number; body: unknown; contentType: string } {
  const contentType = 'application/json';
  try {
    let parsed: unknown = null;
    let parseFailed = false;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      parseFailed = true;
    }

    // Auth is decided before anything else (even before the tool exists).
    if (!authed) {
      return {
        status: 401,
        body: rpcError(parseFailed ? null : idOf(parsed), MCP_UNAUTHORIZED, 'Unauthorized'),
        contentType,
      };
    }

    if (parseFailed) {
      return { status: 400, body: rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'), contentType };
    }

    const lower = lowerHeaders(headers);

    // A JSON array is answered as a batch, in order (the client tolerates
    // array answers; MCP itself defines no batching, so this is best-effort).
    if (Array.isArray(parsed)) {
      const answers = parsed.map((item) => handleOne(store, item, lower).body);
      return { status: 200, body: answers, contentType };
    }

    const answer = handleOne(store, parsed, lower);
    return { status: answer.status, body: answer.body, contentType };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 200,
      body: rpcError(null, JSON_RPC_INTERNAL_ERROR, `Internal error: ${message}`),
      contentType,
    };
  }
}
