# raycoder

raycoder is a local, browser-based orchestrator for coding agents. Its engine gives every ticket an isolated Git workspace, records lifecycle and dependency history in SQLite, integrates reviewed work against the current base branch, and recovers conservatively after crashes.

The `1.0.0-rc.3` candidate adds a projectless application host, single-instance startup from any directory, inspected project onboarding, provider-independent UI startup, safe cleanup, and a static browser UI to the complete V1 workflow.

## Install and run

raycoder is distributed as one npm package and requires Node.js 24 LTS or newer. Git is
required when a project is opened or created, but the selector can start without it:

```bash
npx raycoder@next
npx raycoder@next /path/to/project --port 4317 --no-open
npx raycoder@next doctor /path/to/project
npx raycoder@next cleanup --global
```

`raycoder doctor` checks Node, the bundled Codex runtime, ChatGPT authentication and the
optional Engram MCP setup, and an optional target path without creating project metadata. With
no path, `npx raycoder` opens the project selector. The UI remains available when no provider
can execute agents; execution controls show the actionable preflight diagnosis instead.

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
pnpm test:e2e
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

Project metadata lives in `.raycoder/` and is excluded through the repository-local Git exclude file. Global configuration, project registry and the active-instance descriptor live in `~/.raycoder/`. Both locations are removed only through previewed, explicitly confirmed cleanup operations.

## Local API

Projects are inspected before mutation, catalogued globally and opened as independent runtimes. The API is rooted at
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
version. npm versions cannot be renamed, so this promotes `1.0.0-rc.3` to the stable channel
without rebuilding it; a separately named `1.0.0` would necessarily be a different package
artifact.

Promotion is deliberately local and interactive. Confirm that `apps/server/package.json`
still names the accepted, already-published RC, then validate the npm session without exposing
credentials:

```bash
npm whoami
# If the session is missing or expired:
npm login --auth-type=web
pnpm release:promote
pnpm release:verify-tags
```

Do not print npm configuration, inspect authentication files, pass a token on the command
line, or copy a token into the repository or CI. npm owns the local web-login session;
raycoder never reads or stores its credential. `release:promote` first requires `next` to
point at the manifest version, moves `latest`, and then compares both channels' version,
integrity and shasum. `release:verify-tags` repeats the final comparison without mutating npm.

## License

AGPL-3.0-only.
