# raycoder

raycoder is a local, browser-based orchestrator for coding agents. Its engine gives every ticket an isolated Git workspace, records lifecycle and dependency history in SQLite, integrates reviewed work against the current base branch, and recovers conservatively after crashes.

The `1.0.0-rc.8` candidate adds an actionable bilingual UI, durable workspace preparation and multistack verification, conversational planning, confirmed DAG creation, and an atomic user-local installer with update, rollback, and conservative uninstall.

## Install and run

raycoder is distributed as one npm package and requires Node.js 24 LTS or newer. The
recommended setup installs a stable user-local launcher without administrator privileges or
`npm -g`:

```bash
npx raycoder@latest install
raycoder
raycoder /path/to/project --port 4317 --no-open
raycoder doctor /path/to/project
```

Use `npx raycoder@<exact-version> install` for a prerelease or reproducible installation, and
add `--no-shortcut` if no Start menu, `~/Applications`, or Linux desktop entry should be
created. The public launcher stays in `~/.raycoder/bin`; internally, `raycoder update` keeps
the active and previous versions, and `raycoder rollback` swaps them atomically. Run
`raycoder uninstall` to review the exact removal inventory and confirm it. Configuration,
the project registry, project metadata, and credentials are preserved.

The zero-install form remains available:

```bash
npx raycoder@next
npx raycoder@next /path/to/project
```

Git is required when a project is opened or created, but the selector can start without it.

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
pnpm installer:smoke
pnpm dogfood:v1
pnpm dogfood:rc4
pnpm dogfood:preparation
pnpm dogfood:verification
pnpm dev -- /path/to/a/git/repository
```

## Workspace preparation

Before an agent starts, raycoder prepares that ticket's isolated worktree. A single,
unambiguous root stack is detected automatically (Node lockfiles, uv, Poetry, Pipenv, Cargo,
or Go); mixed repositories use ordered units configured in Settings. Explicit Bash and
PowerShell steps must be tracked files inside the repository, and arguments are passed
literally without shell interpolation.

The first run shows the exact units, commands, paths, tool versions, possible network use,
and install-script risk. Approval is stored only for that project and fingerprint. Changes to
the strategy, unit order, platform, executable/version, manifests, locks, scripts, or script
policy require approval again. Failed or interrupted preparation is durable, blocks the ticket
without deleting its worktree, and can be inspected and retried. Unknown stacks continue with
`NOT_APPLICABLE`; recognizable stacks without a valid lock are blocked with a diagnostic.

After the agent commits its implementation and before review, raycoder runs an independent,
durable verification plan. Node uses the project's `verify` script or its declared
`typecheck`/`lint`/`test`/`build` scripts; uv, Poetry, Pipenv, Rust and Go use their locked,
read-only conventions. Mixed repositories and Bash/PowerShell verification use the same ordered,
contained configuration model. Verification output is sanitized and bounded, tracked-file
changes fail the gate, and a changed command, tool, manifest, lock or script requires fresh
approval. If the canonical base moved, the reconciliation worktree is subject to the same gate.

Manual **Run** per ticket remains the default. A sequential Auto mode is an explicit future
follow-up: it will be opt-in and pause for approvals, blockers, failures, or human intervention.
No Auto controls are enabled in this release.

Integration is automatic by default. To require approval before changing a base branch:

```bash
pnpm dev -- config set integration-mode confirm
pnpm dev -- config show
```

For UI work, `pnpm dev:fixture` starts a disposable repository at
`http://127.0.0.1:4399`. The application includes a durable planning conversation, structured
SPEC and ticket editors, revision approval, DAG confirmation, project navigation, tickets,
the read-only DAG, history, sessions, settings and preview. Preview uses the
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
capabilities and lifecycle actions. Planning generation creates a durable session and returns
HTTP 202; clients poll the planning snapshot for persisted events, completion or errors.
Workspace preparation and verification are exposed through project configuration/approval
endpoints and per-ticket durable attempt histories; ticket actions accept their independently
fingerprinted approvals when needed.
Mutations are serialized per project; different projects
can run concurrently. The legacy single-project diagnostic endpoints remain available for
the initial screen.

Planning follows `conversation → approved snapshot → SPEC → tickets`. Every session, message,
provider event and artifact revision is durable and traceable. Generated stages receive only
the approved predecessor artifact. The ticket DAG is created only after a specific approved
plan is confirmed and revalidated for references, cycles and safe replacement. A pinned
MIT-licensed snapshot of `mattpocock/skills` is copied into each project's
untracked `.raycoder/skills` directory. Engram is optional; install it separately and run
`engram setup codex` to expose durable memory over MCP.

## Release pipeline

Maintainers should follow the [release runbook](docs/releasing.md) for the complete RC,
Trusted Publisher, artifact verification, recovery, and stable-promotion process.

## License

AGPL-3.0-only.
