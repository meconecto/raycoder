# ADR 0008: Least-privilege Git metadata access for ticket agents

## Status

Accepted for V1.

## Context

A ticket workspace is a linked Git worktree. Its visible files live below
`.raycoder/workspaces/<ticket>`, but Git keeps the worktree index, object database and branch
references in the canonical repository's external `.git` directory. A Codex thread confined
to the workspace can edit project files but cannot create the commit required by the ticket
lifecycle.

Granting the complete common `.git` directory as an additional writable root would also let
an implementation agent modify the base branch or unrelated refs. Disabling the sandbox
would be broader still.

## Decision

Before starting an implementation thread, core resolves and validates the ticket worktree's
current symbolic branch. It gives the adapter four additional writable directories:

- the worktree-specific Git directory containing its index and HEAD;
- the common object database;
- the parent directory of the ticket branch ref; and
- the parent directory of the ticket branch reflog.

Every common path is checked to remain inside Git's reported common metadata directory. The
Codex adapter maps this list to SDK `additionalDirectories` while retaining
`workspace-write`, disabled network access and `never` approval. Independent review and
planning threads run with `read-only` sandbox mode and receive no Git metadata write access.

## Consequences

- An implementation agent can create normal commits in its linked ticket worktree.
- The sandbox does not receive write access to the base ref, refs outside the `raycoder`
  namespace, repository configuration or the complete common Git directory. Git's shared object
  database necessarily remains writable so the ticket can create commit objects.
- Git metadata layout is discovered through Git rather than inferred from `.git` file
  contents, so linked worktrees and platform-specific paths remain supported.
- A detached or unexpectedly switched ticket workspace fails before the provider session
  starts.
