# ADR 0006: Versioned planning, pinned skills and optional memory

## Status

Accepted.

## Context

Planning must survive restarts without smuggling an entire conversation into ticket execution. The workflow also depends on external engineering skills and optional Engram memory, both of which can change independently of raycoder.

## Decision

Interrogation, spec and ticket plans are immutable, revisioned SQLite artifacts connected by explicit predecessor ids. Each generated stage receives only the approved predecessor artifact. A ticket plan is validated for cycles when proposed and again when the user confirms it; only confirmation creates the durable ticket DAG.

One planning thread is persisted separately from the one implementation/review thread pair per ticket. Provider, model and effort settings are five explicit stage rows, validated against adapter `capabilities()`, with a global default and one project override.

The complete `skills/engineering` tree from `mattpocock/skills` is vendored at commit `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76` under its MIT license. Opening a project copies it to untracked `.raycoder/skills` only when absent. Restoration is explicit and replaces the full local copy.

Engram remains optional and owns its default global database. raycoder only performs a read-only executable/config preflight, exposes the stdio `engram mcp` connection and attaches a stable project identity to memory context. Running `engram setup codex` requires explicit confirmation.

## Consequences

Planning and execution have inspectable, restart-safe handoff boundaries. Skill behavior is reproducible for a release, while project-local customization is not overwritten silently. Missing Engram produces an actionable warning but does not block offline planning or project management.
