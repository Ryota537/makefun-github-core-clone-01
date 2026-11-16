# GitHub Core Clone — github-core-clone-01

[![Bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01) [![Rank](https://make.fun/badge/github-core-clone-01/Ryota537/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01) [![Reward](https://make.fun/badge/github-core-clone-01/Ryota537/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, standard
library only: git smart HTTP (upload-pack protocol v2, receive-pack v0 with
report-status, side-band-64k and delete-refs), the REST v3 API under
`/api/v3`, GraphQL v4 at `/api/graphql`, and a Model Context Protocol endpoint
at `/mcp` — all served from one in-memory store, with no git binary, no
outside service and no model calls.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=test-token node main.ts
```

`main.ts` is the entry ↔ env lifecycle (kept as the kit's starter ships it):
bind an ephemeral port, `POST {"port": N}` to `$MAKEFUN_ENV_URL/register`,
poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exit 0.

## Layout

- `main.ts` — lifecycle only (register / poll / exit 0).
- `app.ts` — HTTP routing, body reading, auth gate, JSON envelope.
- `store.ts` — the in-memory store: repositories, issues, pull requests,
  labels, contents and the git object database; deterministic ids and
  timestamps (`MAKEFUN_TRIAL_NOW`, else a fixed epoch).
- `git.ts` — pkt-line framing, packfile parsing and generation (v2/v3,
  OFS + REF deltas, thin packs), upload-pack v2/v0 and receive-pack v0,
  plus the commit/tree helpers the contents API and pull-request merge use.
- `rest.ts` — REST v3: repositories, issues, pull requests, contents,
  labels, pagination, and the shared object serializers.
- `graphql.ts` — GraphQL v4 for the documents `gh` and `github-mcp-server`
  send, including introspection of `Issue`, `PullRequest`, `Repository`
  and `SearchType`.
- `mcp.ts` — MCP over Streamable HTTP (`server/discover` for revision
  2026-07-28, `initialize` for earlier revisions; `tools/list` and
  `tools/call` over the same store as REST).

## Determinism

Two runs on the same instance leave the same state: no wall clock, no
unseeded randomness anywhere in the request path. All timestamps come from
`MAKEFUN_TRIAL_NOW`, all ids from counters, all request ids from a counter.
The owner of every repository is the login the trial token names
(`adaiversen` in the sealed scenario); the same repository name under any
other owner is 404, never 403.

## Grade locally

```sh
node --experimental-strip-types ~/workspace/makefun/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token test-token [--perf] [--json]
```

Start the forge first with `MAKEFUN_ENV_URL` pointed at a local mock env
(or run `main.ts` with a stub that answers `/register` and `/done`), then
point the kit's conformance runner at it.
