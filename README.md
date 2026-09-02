# raycoder

raycoder is a local, browser-based orchestrator for coding agents. Its engine gives every ticket an isolated Git workspace, records lifecycle and dependency history in SQLite, integrates reviewed work against the current base branch, and recovers conservatively after crashes.

The current engine supports the complete ticket path through `DONE`, including conditional verification when the base has moved, optional confirmation before integration, multiple project runtimes and structured independent review. The broader V1 planning experience is under active development.

## Install and run

raycoder is distributed as one npm package and requires Node.js 20+ and Git. Until the
first public release, build a local tarball and exercise exactly what will be published:

```bash
pnpm build
pnpm --filter raycoder pack --pack-destination ./artifacts
npx --package ./artifacts/raycoder-0.1.0.tgz raycoder --help
npx --package ./artifacts/raycoder-0.1.0.tgz raycoder doctor /path/to/project
```

`raycoder doctor` checks Node, the bundled Codex runtime, ChatGPT authentication and the
target Git repository without creating project metadata. Start the local application with
`npx raycoder /path/to/project`.

## Development

Requirements: Node.js 20+, pnpm, and Git.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm package:smoke
pnpm package:npx-smoke
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

## Local API

Projects are catalogued globally and opened as independent runtimes. The API is rooted at
`/api/projects/:projectId/` and exposes tickets, dependencies, history, provider sessions,
capabilities and lifecycle actions. Mutations are serialized per project; different projects
can run concurrently. The legacy single-project diagnostic endpoints remain available for
the initial screen.

## License

AGPL-3.0-only.
