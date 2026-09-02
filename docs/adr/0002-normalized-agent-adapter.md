# ADR 0002: Normalize provider adapters at an async event boundary

- Status: accepted
- Date: 2026-09-02

## Context

Provider SDKs expose different session objects, capabilities, cancellation behavior, and event schemas. Allowing those types into orchestration or UI code would couple the engine to the first provider.

## Decision

`AgentAdapter` exposes `capabilities`, `preflight`, `startSession`, `send`, and `cancel`. Sessions are opaque provider-neutral identifiers. `send` returns an `AsyncIterable` of the normalized event union required by the brief. Provider-native SDK access is wrapped behind a smaller injectable client boundary so translation and cancellation can be tested without credentials.

Adapters never receive a ticket repository and never mutate lifecycle state. The dispatcher is the sole interpreter of normalized completion/error events for normal execution.

## Consequences

The core remains stable as providers change, and tests can replay fixtures. Provider-specific richness not represented by the protocol must be mapped to metadata or warnings until the contract is deliberately extended.
