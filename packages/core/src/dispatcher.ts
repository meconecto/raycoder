import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentSession } from "./agent-adapter.js";
import type { DirtyWorkspacePolicy, GitWorkspaceManager } from "./git-workspace.js";
import type { Ticket } from "./domain.js";
import type { TicketRepository } from "./ticket-repository.js";

export interface DispatchRequest {
  readonly ticketId: string;
  readonly projectRoot: string;
  readonly dirtyPolicy: DirtyWorkspacePolicy;
  readonly model?: string;
  readonly effort?: string;
}

interface ActiveDispatch {
  readonly ticketId: string;
  readonly session: AgentSession;
}

interface StageResult {
  readonly success: boolean;
  readonly recoverableError: boolean;
  readonly errorCode?: string;
}

export class DispatcherBusyError extends Error {
  public constructor() {
    super("This project's dispatcher already has an active ticket");
    this.name = "DispatcherBusyError";
  }
}

export class Dispatcher {
  readonly #repository: TicketRepository;
  readonly #workspaces: GitWorkspaceManager;
  readonly #adapter: AgentAdapter;
  #active: ActiveDispatch | null = null;

  public constructor(
    repository: TicketRepository,
    workspaces: GitWorkspaceManager,
    adapter: AgentAdapter,
  ) {
    this.#repository = repository;
    this.#workspaces = workspaces;
    this.#adapter = adapter;
  }

  public async dispatch(request: DispatchRequest): Promise<Ticket> {
    if (this.#active !== null) throw new DispatcherBusyError();
    const ticket = this.#repository.get(request.ticketId);
    if (ticket.status !== "READY") throw new Error(`Ticket ${ticket.id} is ${ticket.status}, not READY`);

    const metadata = await this.#workspaces.create({
      projectRoot: request.projectRoot,
      ticketId: ticket.id,
      baseBranch: ticket.baseBranch,
      dirtyPolicy: request.dirtyPolicy,
    });
    this.#repository.setGitMetadata(ticket.id, metadata);
    this.#repository.transition(ticket.id, "RUNNING", "workspace_created_from_base_head");

    let session: AgentSession;
    try {
      session = await this.#adapter.startSession({
        workspace: metadata.workspace,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      });
    } catch (error) {
      this.#repository.transition(ticket.id, "FAILED", "agent_session_start_failed");
      throw error;
    }

    this.#active = { ticketId: ticket.id, session };
    const persistedSessionId = randomUUID();
    const now = new Date().toISOString();
    this.#repository.createAgentSession({
      id: persistedSessionId,
      ticketId: ticket.id,
      provider: session.provider,
      providerSessionId: session.providerSessionId ?? null,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    let sequence = 0;
    try {
      const implementation = await this.#runStage(
        session,
        implementationPrompt(ticket),
        persistedSessionId,
        sequence,
      );
      sequence = implementation.nextSequence;
      if (session.providerSessionId !== undefined) {
        this.#repository.updateAgentSession(persistedSessionId, { providerSessionId: session.providerSessionId });
      }
      if (!implementation.result.success) {
        return this.#finishError(ticket.id, implementation.result, persistedSessionId);
      }

      if (!(await this.#workspaces.hasCommitSince(metadata.workspace, metadata.baseCommit))) {
        this.#repository.updateAgentSession(persistedSessionId, { status: "failed" });
        return this.#repository.transition(ticket.id, "FAILED", "agent_completed_without_commit");
      }

      this.#repository.transition(ticket.id, "REVIEW", "implementation_committed");
      const review = await this.#runStage(session, reviewPrompt(ticket), persistedSessionId, sequence);
      if (!review.result.success) {
        return this.#finishError(ticket.id, review.result, persistedSessionId);
      }

      this.#repository.updateAgentSession(persistedSessionId, { status: "completed" });
      return this.#repository.transition(ticket.id, "READY_TO_MERGE", "review_approved");
    } catch (error) {
      const current = this.#repository.get(ticket.id);
      this.#repository.updateAgentSession(persistedSessionId, { status: "failed" });
      if (current.status === "RUNNING" || current.status === "REVIEW") {
        this.#repository.transition(ticket.id, "FAILED", "agent_adapter_exception");
      }
      throw error;
    } finally {
      this.#active = null;
    }
  }

  public async cancel(ticketId: string): Promise<Ticket> {
    if (this.#active === null || this.#active.ticketId !== ticketId) {
      throw new Error(`Ticket ${ticketId} is not active in this dispatcher`);
    }
    await this.#adapter.cancel(this.#active.session);
    return this.#repository.transition(ticketId, "CANCELLED", "user_cancelled");
  }

  async #runStage(
    session: AgentSession,
    prompt: string,
    persistedSessionId: string,
    initialSequence: number,
  ): Promise<{ result: StageResult; nextSequence: number }> {
    let sequence = initialSequence;
    let completed = false;
    let success = false;
    let recoverableError = false;
    let errorCode: string | undefined;

    for await (const event of this.#adapter.send(session, prompt)) {
      this.#repository.appendAgentEvent(persistedSessionId, sequence, event);
      sequence += 1;
      if (event.type === "error") {
        recoverableError ||= event.recoverable;
        errorCode = event.code;
      }
      if (event.type === "completed") {
        completed = true;
        success = event.success;
      }
    }

    return {
      result: {
        success: completed && success,
        recoverableError,
        ...(errorCode === undefined ? {} : { errorCode }),
      },
      nextSequence: sequence,
    };
  }

  #finishError(ticketId: string, result: StageResult, sessionId: string): Ticket {
    const current = this.#repository.get(ticketId);
    if (current.status === "CANCELLED") return current;
    if (result.recoverableError || result.errorCode === "quota_exhausted") {
      this.#repository.updateAgentSession(sessionId, { status: "blocked" });
      return this.#repository.block(ticketId, result.errorCode ?? "agent_recoverable_error");
    }
    this.#repository.updateAgentSession(sessionId, { status: "failed" });
    return this.#repository.transition(ticketId, "FAILED", result.errorCode ?? "agent_failed");
  }
}

function implementationPrompt(ticket: Ticket): string {
  return [
    "Implement this ticket in the current isolated Git workspace.",
    "Keep all writes inside the workspace. Verify the change and create at least one descriptive Git commit before finishing.",
    `Title: ${ticket.title}`,
    `Description: ${ticket.description}`,
  ].join("\n\n");
}

function reviewPrompt(ticket: Ticket): string {
  return [
    `Review the committed implementation of ticket ${ticket.id}.`,
    "Inspect the diff and run any applicable focused verification. If you find an issue, fix it and commit the fix.",
    "Finish successfully only when the branch is ready for integration. Do not merge it into the base branch.",
  ].join("\n\n");
}
