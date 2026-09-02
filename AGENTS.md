# Working on raycoder

## Architecture

- `packages/core`: domain state machine, DAG and planning artifacts, SQLite repositories and migrations, Git worktrees, provider-neutral adapters, dispatcher, journaled integration, project runtimes, skills, optional memory, recovery, and preflight.
- `apps/server`: the `raycoder` CLI, local HTTP API, browser UI, packaged runtime export, and the explicit real-Codex smoke command.
- `docs/adr`: architectural decisions with meaningful change cost.

The core owns lifecycle transitions. Adapters only manage provider sessions and emit normalized events. The UI only invokes the API and renders persisted state. Each open project owns an independent `ProjectRuntime`; its scheduler is sequential, while different projects may execute in parallel.

SQLite is the durable source for ticket state and history, but it is never proof that an external process still exists. Git state and provider process liveness are reconciled separately. A ticket workspace is a Git worktree created from the current head of its canonical base branch when dispatch begins. Integration is journaled before the canonical base is advanced; only the integration repository operation may persist `DONE`.

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm package:smoke
pnpm package:npx-smoke
pnpm dogfood:v1
pnpm dev:fixture
pnpm release:artifact
pnpm dev -- /path/to/project
pnpm smoke:codex
```

The standard test suite must remain offline, deterministic, credential-free, and quota-free. `smoke:codex` is the only real-provider check and must use its disposable fixture.

## Hard boundaries

- Treat `docs/brief.md` as the product contract. Do not edit it to fit an implementation.
- Do not bypass the integration journal or fabricate `DONE` with a generic lifecycle transition.
- Do not let adapters or UI code choose or persist ticket lifecycle transitions.
- Do not let `READY_TO_MERGE` satisfy a dependency; only `DONE` does.
- Reject dependency cycles in the domain before persistence.
- Do not edit a user's tracked files or `.gitignore` outside explicit ticket workspaces/integration. Use `.git/info/exclude` for `.raycoder/` metadata.
- Do not delete failed/interrupted workspaces or branches automatically.
- Do not add future provider adapters or provider-specific probes prematurely.
- Do not bypass a project's scheduler for dispatch, review, integration or ticket recovery actions.
- Do not create or alter the executable ticket DAG from an unconfirmed planning artifact.
- Do not overwrite project-local skills except through the explicit full-restore action.

## Definition of done

Before handing work off, run install (when dependencies changed), build, typecheck, lint, and all standard tests. Verify that no standard test contacts a provider or needs credentials. For lifecycle changes, cover invalid transitions and recovery. For Git changes, use disposable fixture repositories and assert physical workspace isolation, ancestry, and commit placement.
