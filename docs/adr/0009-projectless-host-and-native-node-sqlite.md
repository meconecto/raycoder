# ADR 0009: Projectless host, single instance, and Node SQLite

## Status

Accepted for `1.0.0-rc.3`.

## Context

The RC2 executable constructed a project runtime before serving HTTP. It therefore could not start from an arbitrary directory, show onboarding without a repository, or remain useful when no provider was executable. Its SQLite dependency also required an install-time native binding, which current one-shot npm execution can leave unavailable.

## Decision

- A process-level application host owns preflight, the global registry, project runtimes, memory, instance identity and shutdown.
- The host starts with zero projects. A runtime is constructed only when a registered project is opened.
- One nonce-protected global instance is reused by compatible CLI invocations. Different versions never replace or terminate each other.
- Project and global registries use the Node 24 `node:sqlite` synchronous API behind a small local transaction adapter. The durable schema and migration history remain unchanged.
- Browser assets are packaged static ESM files and served only through an explicit route allowlist.
- Project deletion is previewed as a short-lived fingerprinted cleanup plan; unsafe Git state is preserved by default.

## Consequences

Node 24 becomes a hard runtime requirement and removes the native addon installation step from `npx raycoder`. Existing SQLite databases remain readable because the file format and migrations are unchanged. The process can host independent project runtimes without creating project-local metadata in its invocation directory. Cleanup and instance ownership add stateful protocols that require nonce, root-containment and stale-state tests.
