# git-forge

A standalone GitHub-core clone in one Node process: **git smart HTTP +
REST v3 + GraphQL v4 + MCP**, backed by a single in-memory store. Built for
the Make.Fun `github-core-clone-01` bounty ($500).

## Run

```sh
node main.ts
```

The entrypoint binds an ephemeral port, registers it with the environment
(`$MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` until the
trial ends. It reads `MAKEFUN_TRIAL_NOW` (deterministic clock) and
`MAKEFUN_SHOP_TOKEN` (Bearer token) from the environment.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, poll, exit. |
| `app.ts` | HTTP server + routing + top-level error guard. |
| `http.ts` | Body reading, JSON/binary replies, auth, request ids. |
| `store.ts` | The unified in-memory store (repos, objects, refs, issues, PRs, labels, comments) + commit/tree/merge helpers. |
| `gitproto.ts` | SHA-1 objects, tree/commit/tag encoding, pkt-lines, packfiles. |
| `git.ts` | Smart HTTP: upload-pack v2 (ls-refs, fetch) + v0 fetch + receive-pack v0. |
| `rest.ts` | GitHub REST v3 (repos, branches, commits, refs, contents, labels, issues, comments, pulls, merges). |
| `graphql.ts` | Hand-written GraphQL parser + executor (viewer, repository, node, issues/PRs, mutations, `__type`). |
| `mcp.ts` | MCP (Streamable HTTP, JSON-RPC 2.0, 2026-07-28 `server/discover`) with six tools. |

## Design notes

- **One store, four surfaces.** A repo created over REST is visible to git,
  GraphQL and MCP immediately; issues and pull requests share one number
  counter per repo, as on GitHub.
- **Deterministic.** All timestamps come from `MAKEFUN_TRIAL_NOW`
  (fallback: a fixed epoch). No `Date.now()`, no `Math.random()` anywhere
  in what is sent or stored. Request ids are a counter.
- **Git.** Version-2 upload-pack with `fetch` / `ls-refs` / `object-format=sha1`,
  shallow + deepen support, ACK/NAK negotiation, sideband packfiles
  (version 2, plain objects, 0 deltas, SHA-1 trailer). Receive-pack enforces
  fast-forward and reports `unpack ok` + per-ref `ok`/`ng` inside band 1.
- **Performance.** Direct `Map` lookups on the hot paths, no per-request
  filesystem access, bounded commit walks, `Content-Length` on every reply.
- **Stdlib only.** Node's `http`, `crypto`, `zlib` — no dependencies, no git
  binary, no network beyond the trial environment.
