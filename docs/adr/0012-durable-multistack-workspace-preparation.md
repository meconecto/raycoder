# ADR 0012: Durable multistack workspace preparation

## Status

Accepted for the next unreleased milestone.

## Context

Ticket worktrees intentionally start from committed Git state and therefore do not contain local
dependency directories. Leaving installation to the implementation agent makes a fresh workspace
unreliable when its provider sandbox has no network access. Running package managers directly on
the host without consent would execute dependency or project code outside that sandbox.

## Decision

- The project scheduler runs a durable preparation phase before the dispatcher starts an
  implementation session. Ticket lifecycle remains unchanged and does not enter `RUNNING` until
  preparation succeeds.
- A project-scoped approval is bound to a fingerprint of the ordered plan, platform, tool versions,
  manifests, lockfiles and explicit scripts. Changed input requires renewed approval.
- Built-in root strategies cover Node lockfiles, uv, Poetry, Pipenv, Cargo and Go modules. Mixed or
  nested repositories use explicitly ordered units. Bash and PowerShell scripts are never inferred;
  they must be tracked, repo-contained and configured explicitly.
- Commands are spawned as an executable plus literal arguments without a shell. Successful exit
  and an unchanged tracked Git tree are both required. Logs are bounded and sanitized before being
  persisted.
- Preparation attempts and recovery are journaled independently from agent sessions. Failed,
  cancelled and interrupted workspaces are preserved. Persisted state never proves external
  process liveness.
- Manual ticket execution remains the default. An opt-in sequential Auto mode is a desired future
  feature and is not implemented by this decision.

## Consequences

Fresh ticket workspaces become usable before an agent receives control, while network and install
scripts remain an explicit user decision. Reconciliation verification can use the same preparation
policy instead of installing dependencies implicitly. Supporting another ecosystem requires a new
strategy or an explicit project unit, not provider-specific logic.
