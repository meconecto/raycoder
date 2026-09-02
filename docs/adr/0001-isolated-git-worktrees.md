# ADR 0001: Isolate tickets with Git worktrees

- Status: accepted
- Date: 2026-09-02

## Context

Every ticket needs a physically separate working directory and branch created from the current head of its canonical base branch. A branch without another working directory is insufficient. Copies and local clones also provide isolation but duplicate more data and complicate object/branch synchronization.

## Decision

Create a linked Git worktree beneath the project's untracked `.raycoder/workspaces/` directory with `git worktree add -b <ticket-branch> <path> <base-commit>`. Resolve and persist the base branch head immediately before the ticket enters `RUNNING`. Refuse a dirty main checkout unless the caller explicitly selects the conservative `committed-head` policy.

Keep worktrees and branches after failures or interruptions. Session 1 never integrates or deletes them.

## Consequences

Worktrees share the repository's object database, are fast, and preserve exact ancestry. Git enforces branch checkout constraints, so branch names must be unique. Cleanup will need an explicit workflow later. Metadata is excluded locally through `.git/info/exclude`, never by editing the user's `.gitignore`.
