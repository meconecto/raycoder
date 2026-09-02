# raycoder

raycoder is a local, browser-based orchestrator for coding agents. Its engine gives every ticket an isolated Git workspace, records lifecycle and dependency history in SQLite, integrates reviewed work against the current base branch, and recovers conservatively after crashes.

The `1.0.0-rc.2` candidate covers the complete V1 workflow: multi-project runtimes, versioned planning artifacts, confirmed dependency DAGs, isolated ticket workspaces, structured review, journaled integration through `DONE`, crash recovery, project settings, optional Engram memory, bundled skills, and workspace-aware preview.

## Install and run

raycoder is distributed as one npm package and requires Node.js 24 LTS or newer and Git. To
validate a checkout locally, build a tarball and exercise exactly what will be published:

```bash
pnpm build
pnpm --filter raycoder pack --pack-destination ./artifacts
npx --package ./artifacts/raycoder-1.0.0-rc.2.tgz raycoder --help
npx --package ./artifacts/raycoder-1.0.0-rc.2.tgz raycoder doctor /path/to/project
```

`raycoder doctor` checks Node, the bundled Codex runtime, ChatGPT authentication and the
optional Engram MCP setup, and the target Git repository without creating project metadata. Start the local application with
`npx raycoder /path/to/project`.

The package also exposes the provider-neutral runtime API from `raycoder`; the executable
and the runtime are built from the same package artifact and do not depend on unpublished
workspace packages.

## Development

Requirements: Node.js 24 LTS or newer, pnpm, and Git.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm package:smoke
pnpm package:npx-smoke
pnpm dogfood:v1
pnpm dev -- /path/to/a/git/repository
```

Integration is automatic by default. To require approval before changing a base branch:

```bash
pnpm dev -- config set integration-mode confirm
pnpm dev -- config show
```

For UI work, `pnpm dev:fixture` starts a disposable repository at
`http://127.0.0.1:4399`. The application includes project navigation, planning artifacts,
tickets, the read-only DAG, history, sessions, settings and preview. Preview uses the
selected active ticket's worktree when applicable; otherwise it uses the canonical base.
Projects without a runnable web script show Git status and recent commits instead. Preview
is observability only and never changes lifecycle state.

The real Codex smoke test is separate from the standard suite and may consume ChatGPT quota:

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

Planning artifacts follow `interrogation → spec → tickets`. Every revision is durable, and
the ticket DAG is created only after the proposed plan is confirmed and revalidated for
cycles. A pinned MIT-licensed snapshot of `mattpocock/skills` is copied into each project's
untracked `.raycoder/skills` directory. Engram is optional; install it separately and run
`engram setup codex` to expose durable memory over MCP.

## Release candidate workflow

Create the immutable local candidate and validate both the executable and full installed
V1 flow before publishing:

```bash
pnpm release:artifact
pnpm package:npx-smoke
pnpm dogfood:v1
```

`release:publish:rc` publishes that tarball under npm's `next` tag. After the exact RC
artifact is accepted, `release:promote` moves npm's `latest` tag to that same immutable
version. npm versions cannot be renamed, so this promotes `1.0.0-rc.2` to the stable channel
without rebuilding it; a separately named `1.0.0` would necessarily be a different package
artifact.

## License

AGPL-3.0-only.
