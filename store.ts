// Shared in-memory store for the github-core-clone-01 forge.
// Single process, no persistence: the env's export is derived from the
// suite's own observations, not from our disk. Everything deterministic:
// timestamps come from MAKEFUN_TRIAL_NOW (or a fixed epoch), ids from
// counters, request ids from a counter. No Date.now(), no Math.random().
//
// Module layout (all imports use explicit `.ts` extensions, Node 22
// type-stripping, erasable syntax only):
//   store.ts    this file: data model + counters + deterministic helpers
//   git.ts      pkt-line, packfile parse/generate, upload-pack v2/v0,
//               receive-pack v0, commit/tree/blob helpers for contents+merge
//   rest.ts     REST v3 handlers + repoJson/issueJson/pullJson serializers
//               (GraphQL and MCP import the serializers from here)
//   graphql.ts  GraphQL v4 executor for the gh / github-mcp-server docs
//   mcp.ts      MCP Streamable HTTP: initialize/discover, tools/list/call
//   app.ts      HTTP routing, body reading, auth gate, JSON envelope
//   main.ts     lifecycle (register / poll done / exit 0), kept as starter

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Deterministic "now" for every timestamp the forge emits. */
export const TRIAL_NOW: string = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw)) return raw;
  return '2025-01-01T00:00:00.000Z';
})();

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface GitStore {
  /** sha1 hex -> object (raw bytes preserved exactly). */
  objects: Map<string, GitObject>;
  /** full ref name -> tip sha1 hex. */
  refs: Map<string, string>;
  /** HEAD target ref, e.g. 'refs/heads/main'. */
  headRef: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  /** Logical sequence for stable CREATED_AT ordering (ties by number). */
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string;
  mergedAt: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface ContentEntry {
  path: string;
  sha: string;
  size: number;
  content: Buffer;
  commitSha: string;
  message: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  git: GitStore;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  contents: Map<string, ContentEntry>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextLabelId: number;
  /** Monotonic sequence shared by issues/pulls for ordering. */
  seq: number;
}

export class Store {
  repos: Map<string, Repo> = new Map();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextGlobalCommentId = 1;
  nextRequestId = 1;
  /** Global logical clock: increments on every mutation (ordering only). */
  seq = 1;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  nextSeq(): number {
    const s = this.seq;
    this.seq += 1;
    return s;
  }

  nextRequestIdValue(): string {
    const n = this.nextRequestId;
    this.nextRequestId += 1;
    return `req-${n}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: TRIAL_NOW,
      updatedAt: TRIAL_NOW,
      pushedAt: TRIAL_NOW,
      git: { objects: new Map(), refs: new Map(), headRef: 'refs/heads/main' },
      labels: new Map(),
      issues: [],
      pulls: [],
      contents: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      seq: 1,
    };
    this.repos.set(Store.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER_LOGIN,
      createdAt: TRIAL_NOW,
      updatedAt: TRIAL_NOW,
      comments: [],
      seq: this.nextSeq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergeCommitSha: '',
      mergedAt: '',
      createdAt: TRIAL_NOW,
      updatedAt: TRIAL_NOW,
      seq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }
}

export function createStore(): Store {
  return new Store();
}
