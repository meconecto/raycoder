# raycoder

raycoder is a local, browser-based orchestrator for coding agents. Its engine gives every ticket an isolated Git workspace, records lifecycle and dependency history in SQLite, and recovers conservatively after crashes.

This repository currently implements session 1 of the engine. Normal execution stops at `READY_TO_MERGE`; Git integration and `DONE` are intentionally reserved for session 2.

## Development

Requirements: Node.js 20+, pnpm, and Git.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev -- /path/to/a/git/repository
```

The local server prints its URL at startup. The real Codex smoke test is separate from the standard suite and may consume ChatGPT quota:

```bash
pnpm build
pnpm smoke:codex
```

It creates and uses a disposable Git fixture; it never runs against the raycoder repository.
