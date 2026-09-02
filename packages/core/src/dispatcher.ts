import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentSession } from "./agent-adapter.js";
import type { DirtyWorkspacePolicy, GitWorkspaceManager } from "./git-workspace.js";
import type { Ticket } from "./domain.js";
import type { GitMetadata, TicketRepository } from "./ticket-repository.js";

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
  readonly reviewDecision?: StructuredReviewDecision;
}

interface StructuredReviewDecision {
  readonly verdict: "approved" | "changes_requested";
  readonly summary: string;
  readonly findings: readonly string[];
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
  readonly #reviewAdapter: AgentAdapter;
  #active: ActiveDispatch | null = null;

  public constructor(
    repository: TicketRepository,
    workspaces: GitWorkspaceManager,
    adapter: AgentAdapter,
    reviewAdapter: AgentAdapter = adapter,
  ) {
    this.#repository = repository;
    this.#workspaces = workspaces;
    this.#adapter = adapter;
    this.#reviewAdapter = reviewAdapter;
  }

  public async dispatch(request: DispatchRequest): Promise<Ticket> {
    if (this.#active !== null) throw new DispatcherBusyError();
    const ticket = this.#repository.get(request.ticketId);
    if (ticket.status !== "READY" && ticket.status !== "RUNNING" && ticket.status !== "CHANGES_REQUESTED") {
      throw new Error(`Ticket ${ticket.id} is ${ticket.status}, not dispatchable`);
    }

    let metadata: GitMetadata;
    if (ticket.workspace !== null && ticket.branch !== null && ticket.baseCommit !== null) {
      metadata = {
        workspace: ticket.workspace,
        branch: ticket.branch,
        baseBranch: ticket.baseBranch,
        baseCommit: ticket.baseCommit,
      };
      if (ticket.status !== "RUNNING") this.#repository.transition(ticket.id, "RUNNING", "existing_workspace_resumed");
    } else {
      if (ticket.status !== "READY") throw new Error(`Ticket ${ticket.id} has no resumable workspace`);
      metadata = await this.#workspaces.create({
        projectRoot: request.projectRoot,
        ticketId: ticket.id,
        baseBranch: ticket.baseBranch,
        dirtyPolicy: request.dirtyPolicy,
      });
      this.#repository.setGitMetadata(ticket.id, metadata);
      this.#repository.recordGitObservation({
        ticketId: ticket.id,
        workspace: metadata.workspace,
        head: metadata.baseCommit,
        branch: metadata.branch,
        isClean: true,
        source: "workspace_created",
      });
      this.#repository.transition(ticket.id, "RUNNING", "workspace_created_from_base_head");
    }

    let session: AgentSession;
    try {
      const previous = this.#repository.latestAgentSession(ticket.id, "implementation");
      const capabilities = await this.#adapter.capabilities();
      session = await this.#adapter.startSession({
        workspace: metadata.workspace,
        purpose: "implementation",
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(capabilities.resumableSessions && previous?.providerSessionId !== null && previous?.providerSessionId !== undefined
          ? { resumeProviderSessionId: previous.providerSessionId }
          : {}),
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
      role: "implementation",
      createdAt: now,
      updatedAt: now,
    });

    try {
      const implementation = await this.#runStage(
        session,
        implementationPrompt(ticket),
        persistedSessionId,
        0,
      );
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
      this.#repository.recordGitObservation({
        ticketId: ticket.id,
        workspace: metadata.workspace,
        head: await this.#workspaces.head(metadata.workspace),
        branch: metadata.branch,
        isClean: null,
        source: "implementation_completed",
      });

      this.#repository.updateAgentSession(persistedSessionId, { status: "completed" });
      this.#repository.transition(ticket.id, "REVIEW", "implementation_committed");

      const reviewSession = await this.#reviewAdapter.startSession({
        workspace: metadata.workspace,
        purpose: "review",
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      });
      this.#active = { ticketId: ticket.id, session: reviewSession };
      const reviewSessionId = randomUUID();
      const reviewStartedAt = new Date().toISOString();
      this.#repository.createAgentSession({
        id: reviewSessionId,
        ticketId: ticket.id,
        provider: reviewSession.provider,
        providerSessionId: reviewSession.providerSessionId ?? null,
        status: "running",
        role: "review",
        createdAt: reviewStartedAt,
        updatedAt: reviewStartedAt,
      });
      const review = await this.#runStage(reviewSession, reviewPrompt(ticket), reviewSessionId, 0, this.#reviewAdapter);
      if (!review.result.success) {
        return this.#finishError(ticket.id, review.result, reviewSessionId);
      }

      const decision = review.result.reviewDecision ?? {
        verdict: "approved" as const,
        summary: "Reviewer completed successfully without structured findings",
        findings: [],
      };
      this.#repository.recordReviewDecision({
        ticketId: ticket.id,
        sessionId: reviewSessionId,
        reviewerProvider: reviewSession.provider,
        ...decision,
      });
      this.#repository.updateAgentSession(reviewSessionId, { status: "completed" });
      if (decision.verdict === "changes_requested") {
        return this.#repository.transition(ticket.id, "CHANGES_REQUESTED", "independent_review_requested_changes");
      }
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
    adapter: AgentAdapter = this.#adapter,
  ): Promise<{ result: StageResult; nextSequence: number }> {
    let sequence = initialSequence;
    let completed = false;
    let success = false;
    let recoverableError = false;
    let errorCode: string | undefined;
    let reviewDecision: StructuredReviewDecision | undefined;
    const assistantMessages: string[] = [];

    for await (const event of adapter.send(session, prompt)) {
      this.#repository.appendAgentEvent(persistedSessionId, sequence, event);
      sequence += 1;
      if (event.type === "error") {
        recoverableError ||= event.recoverable;
        errorCode = event.code;
      }
      if (event.type === "assistant_message") assistantMessages.push(event.text);
      if (event.type === "review_decision") {
        reviewDecision = {
          verdict: event.verdict,
          summary: event.summary,
          findings: event.findings,
        };
      }
      if (event.type === "completed") {
        completed = true;
        success = event.success;
      }
    }

    const parsedReviewDecision = reviewDecision ?? parseReviewDecision(assistantMessages);
    return {
      result: {
        success: completed && success,
        recoverableError,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(parsedReviewDecision === undefined ? {} : { reviewDecision: parsedReviewDecision }),
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
    "Inspect the diff and run applicable focused verification. Do not change files and do not merge into the base branch.",
    "End with exactly one structured decision: <raycoder-review>{\"verdict\":\"approved\",\"summary\":\"...\",\"findings\":[]}</raycoder-review>.",
    "Use verdict changes_requested and list concrete findings when the branch is not ready.",
  ].join("\n\n");
}

function parseReviewDecision(messages: readonly string[]): StructuredReviewDecision | undefined {
  for (const message of [...messages].reverse()) {
    const match = /<raycoder-review>([\s\S]*?)<\/raycoder-review>/u.exec(message);
    if (match?.[1] === undefined) continue;
    try {
      const value: unknown = JSON.parse(match[1]);
      if (typeof value !== "object" || value === null) continue;
      const candidate = value as Record<string, unknown>;
      if (candidate.verdict !== "approved" && candidate.verdict !== "changes_requested") continue;
      if (typeof candidate.summary !== "string" || !Array.isArray(candidate.findings)) continue;
      if (!candidate.findings.every((finding) => typeof finding === "string")) continue;
      return {
        verdict: candidate.verdict,
        summary: candidate.summary,
        findings: candidate.findings as string[],
      };
    } catch {
      continue;
    }
  }
  return undefined;
}
