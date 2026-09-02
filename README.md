# raycoder

raycoder is a local, browser-based orchestrator for coding agents. Its engine gives every ticket an isolated Git workspace, records lifecycle and dependency history in SQLite, integrates reviewed work against the current base branch, and recovers conservatively after crashes.

The current engine supports the complete ticket path through `DONE`, including conditional verification when the base has moved and optional confirmation before integration. The broader V1 planning and project-management experience is under active development.

## Development

Requirements: Node.js 20+, pnpm, and Git.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev -- /path/to/a/git/repository
```

Integration is automatic by default. To require approval before changing a base branch:

```bash
pnpm dev -- config set integration-mode confirm
pnpm dev -- config show
```

The local server prints its URL at startup. The real Codex smoke test is separate from the standard suite and may consume ChatGPT quota:

```bash
pnpm build
pnpm smoke:codex
```

It creates and uses a disposable Git fixture; it never runs against the raycoder repository.

Project metadata lives in `.raycoder/` and is excluded through the repository-local Git exclude file. Global configuration lives in `~/.raycoder/`. Both locations are removed only through an explicit user cleanup.

## License

AGPL-3.0-only.
