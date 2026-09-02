# ADR 0004: Journaled Git integration in an isolated worktree

## Status

Accepted.

## Context

A ticket can only become `DONE` after its commit is present on the canonical base branch. The base may have advanced since the ticket workspace was created, and raycoder can stop after Git changes the branch but before SQLite records the transition.

## Decision

Persist an integration attempt before changing Git. If the base is unchanged, fast-forward it to the ticket commit without repeating verification. If it moved, create a detached worktree from the observed base, merge the ticket there, and verify that reconciled result. Persist the resulting target as `APPLYING`, recheck the primary checkout, then advance the base with `git merge --ff-only`.

`DONE` is written only by the integration repository operation. It also promotes newly eligible descendants in the same SQLite transaction. On bootstrap, an `APPLYING` attempt is completed only when Git proves that its target is an ancestor of the current base; otherwise it becomes `INTERRUPTED`.

Confirmation mode approves one attempt and one target. A changed base invalidates that approval. Failed, conflicted, and interrupted worktrees and ticket branches are preserved.

## Consequences

The journal closes the non-atomic Git/SQLite crash window without treating persisted state as process evidence. Reconciliation never rewrites the ticket branch. Temporary successful reconciliation worktrees can be removed after `DONE`; uncertain ones remain available for inspection.
