# ADR 0007: Workspace-aware preview and immutable release candidate

## Status

Accepted for V1.

## Context

The V1 browser experience must expose planning, execution and operational history without
becoming another lifecycle authority. It also needs to preview the exact code a user is
reviewing: an active ticket lives in an isolated worktree, while the default project view
represents the canonical base checkout. Projects without a visual process still need useful
observability.

The release must be tested as the package users install, including the bundled core, pinned
skills and native SQLite dependency. Testing source modules directly cannot detect missing
package files or workspace-only dependencies. npm package versions are immutable, so an RC
cannot later be renamed to `1.0.0` while preserving byte identity.

## Decision

`PreviewManager` belongs to core and selects either the requested active ticket workspace or
the project base. A Node project with a `dev` or `start` script may be started explicitly on a
local port; otherwise preview returns Git status and recent commits. The API requests preview
operations and the UI renders their output. Preview results never cause ticket transitions,
verification success or integration.

The single `raycoder` npm package exposes both the CLI and the bundled provider-neutral
runtime. Release validation packs and installs `1.0.0-rc.1`, imports that installed runtime,
and drives two dependent tickets through restart and `DONE` in a separate clone. The RC is
published under `next`; stable promotion changes the `latest` dist-tag to the already tested
RC version instead of rebuilding. A later exact `1.0.0` version, if desired, must be produced
and tested as a distinct immutable artifact.

## Consequences

- UI and preview remain read-only observers of persisted lifecycle and Git state.
- Active-ticket previews cannot accidentally show the user's base checkout.
- Non-visual projects remain inspectable without framework-specific assumptions.
- Package tests catch missing runtime exports, assets and accidental private workspace
  dependencies.
- Stable-channel promotion preserves the exact tested tarball, although its semantic version
  retains the RC suffix.
