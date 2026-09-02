# ADR 0003: Version SQLite with ordered embedded migrations

- Status: accepted
- Date: 2026-09-02

## Context

Ticket state, history, Git metadata, sessions, events, and DAG edges must survive restarts. Ad-hoc `CREATE TABLE IF NOT EXISTS` statements cannot express ordered upgrades or reliably identify schema versions.

## Decision

The core owns an ordered migration registry. A bootstrap transaction creates only `schema_migrations`, then applies each pending numbered migration exactly once and records its version and name. Runtime repositories assume the migrated schema and contain no schema creation statements.

SQLite foreign keys are enabled and mutations that couple current state with history use transactions. DAG acyclicity is enforced in domain logic before writing edges; database constraints preserve identity and referential integrity.

## Consequences

Schema evolution is explicit and testable against both empty and previously migrated databases. Embedded SQL keeps the published `npx` package self-contained; changing to external migration files later would require packaging and path-resolution work but not a data-model rewrite.
