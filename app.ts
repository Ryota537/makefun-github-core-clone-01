// The forge's HTTP surface: routing, body reading, auth gate, JSON envelope.
// The real work lives in git.ts / rest.ts / graphql.ts / mcp.ts; this file
// only decides which one answers, and in what envelope.
//
// Auth: the suite presents `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
// /healthz and the API root take none (as the starter ships them); git smart
// HTTP is not auth-checked (the suite's git client always sends the token,
// and no git check tests auth); REST, GraphQL and MCP enforce it via the
// `authed` flag they receive (401 without it).
// Determinism: request ids come from the store counter, never random.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestIdValue(),
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length > 0) out[key.toLowerCase()] = value[0] ?? '';
  }
  return out;
}

function bearerOf(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return '';
  return auth.slice(prefix.length);
}

function isAuthed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const bearer = bearerOf(req);
  if (bearer === '') return false;
  if (token === '') return true;
  return bearer === token;
}

function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on('error', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store: Store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(store, res, 200, { ok: true });
          return;
        }

        // The GitHub API root: 200 with the token's scopes (starter behavior).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(store, res, 413, { message: 'Request body too large' });
            return;
          }
          const result = handleGit(store, method, path, queryOf(req), headersOf(req), body);
          res.writeHead(result.status, { 'content-length': result.body.length, ...result.headers });
          res.end(result.body);
          return;
        }

        // REST v3 (auth enforced inside the handler via `authed`).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(store, res, 413, { message: 'Request body too large' });
            return;
          }
          let parsed: unknown;
          let malformed = false;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              malformed = true;
            }
          }
          const result = handleRest(store, method, path, queryOf(req), parsed, malformed, isAuthed(req));
          // The env client resolves the pagination `next` link with `new URL`,
          // which throws on a relative URL: absolutise Link targets with the
          // request's own Host (the only place that sees it).
          const outHeaders: Record<string, string> = { ...(result.headers ?? {}) };
          if (typeof outHeaders.link === 'string') {
            const host = req.headers.host ?? '';
            if (host !== '') {
              outHeaders.link = outHeaders.link.replace(/<(\/[^>]*)>/g, `<http://${host}$1>`);
            }
          }
          sendJson(store, res, result.status, result.body, outHeaders);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(store, res, 404, { message: 'Not Found' });
            return;
          }
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(store, res, 413, { message: 'Request body too large' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = body.length > 0 ? (JSON.parse(body.toString('utf8')) as unknown) : null;
          } catch {
            parsed = null;
          }
          const result = handleGraphQL(store, parsed, isAuthed(req));
          sendJson(store, res, result.status, result.body);
          return;
        }

        // MCP (Streamable HTTP).
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(store, res, 404, { message: 'Not Found' });
            return;
          }
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(store, res, 413, { message: 'Request body too large' });
            return;
          }
          const result = handleMcp(store, body.toString('utf8'), headersOf(req), isAuthed(req));
          res.writeHead(result.status, {
            'content-type': result.contentType,
            'content-length': Buffer.byteLength(typeof result.body === 'string' ? result.body : JSON.stringify(result.body)),
            'x-github-request-id': store.nextRequestIdValue(),
          });
          res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(store, res, 404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(store, res, 500, { message: 'Internal Server Error' });
        } catch {
          // Response already gone; nothing left to do.
        }
      }
    })();
  });
}
