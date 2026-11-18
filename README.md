# sphntr-github-core-clone-rebuild

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/pranz73/sphntr-github-core-clone-rebuild/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/pranz73/sphntr-github-core-clone-rebuild/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge that runs as a single Node.js process with no dependencies and no external git binary. It keeps its own git object store in memory (real SHA-1 objects, packfiles with delta resolution, shallow fetch semantics) and serves four surfaces from that one store: git smart HTTP (protocol v2 ls-refs/fetch plus v0 fetch and receive-pack), the REST v3 API (repositories, contents, branches, git refs, commits, labels, issues, comments, pull requests with three-way squash and merge), a GraphQL v4 subset (viewer, repository, node, introspection, connections, and the create/close/merge/comment mutations), and an MCP endpoint (JSON-RPC with discover, initialize and six repository tools). The forge is single-tenant and fully deterministic: every timestamp comes from the trial clock, so a run and its replay produce identical state. Entry point is main.ts, which registers the process with the trial environment, serves until told the run is done, and exits.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
