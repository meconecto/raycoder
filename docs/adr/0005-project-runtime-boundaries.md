# ADR 0005: One serialized runtime per project

## Status

Accepted.

## Context

raycoder must coordinate multiple repositories without allowing two lifecycle operations to race inside one repository. Provider sessions, process liveness and Git observations also need separate durable records so none is mistaken for proof of another.

## Decision

A global `ProjectRegistry` records canonical repository paths and stable project ids. Opening a project creates one `ProjectRuntime` with its own SQLite connection, dispatcher, integration service and `Scheduler`. A scheduler serializes all mutations for its project, while independent runtimes may execute concurrently.

The dispatcher uses separate implementation and review sessions. Reviewers emit a structured approved/changes-requested decision; a requested change keeps the existing ticket worktree and a retry starts or resumes an implementation session there. Agent sessions, process observations, Git observations and review decisions live in separate tables.

Only core services perform lifecycle transitions. The project-scoped HTTP API delegates to `TicketActions` and the scheduler.

## Consequences

Concurrency is explicit at the project boundary and deterministic within a project. A restart can compare durable intent with provider and Git evidence without conflating them. Removing a project from the registry never removes its repository, branch, worktree or project database.
