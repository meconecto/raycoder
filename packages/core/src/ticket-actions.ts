import { randomUUID } from "node:crypto";
import { createTicket, type Ticket } from "./domain.js";
import type { DirtyWorkspacePolicy } from "./git-workspace.js";
import type { IntegrationOutcome } from "./integration-service.js";
import type { ProjectOrchestrator } from "./project-orchestrator.js";
import type { Scheduler } from "./scheduler.js";
import type { TicketRepository } from "./ticket-repository.js";
import type { WorkspacePreparationApproval } from "./workspace-preparation.js";

export class TicketActions {
  readonly #repository: TicketRepository;
  readonly #orchestrator: ProjectOrchestrator;
  readonly #scheduler: Scheduler;
  readonly #baseBranch: string;
  readonly #projectRoot: string;

  public constructor(
    repository: TicketRepository,
    orchestrator: ProjectOrchestrator,
    scheduler: Scheduler,
    baseBranch: string,
    projectRoot: string,
  ) {
    this.#repository = repository;
    this.#orchestrator = orchestrator;
    this.#scheduler = scheduler;
    this.#baseBranch = baseBranch;
    this.#projectRoot = projectRoot;
  }

  public create(input: {
    id?: string;
    title: string;
    description: string;
    predecessorIds?: readonly string[];
  }): Ticket {
    const predecessorIds = input.predecessorIds ?? [];
    return this.#repository.create(createTicket({
      id: input.id ?? randomUUID(),
      title: input.title,
      description: input.description,
      baseBranch: this.#baseBranch,
      hasPredecessors: predecessorIds.length > 0,
    }), predecessorIds);
  }

  public replaceDependencies(ticketId: string, predecessorIds: readonly string[]): Ticket {
    return this.#repository.replaceDependencies(ticketId, predecessorIds);
  }

  public requestChanges(ticketId: string, reason = "review_changes_requested"): Ticket {
    return this.#repository.transition(ticketId, "CHANGES_REQUESTED", reason);
  }

  public retry(
    ticketId: string,
    dirtyPolicy: DirtyWorkspacePolicy = "cancel",
    preparationApproval?: WorkspacePreparationApproval,
  ) {
    return this.#scheduler.serialize(async () => {
      const ticket = this.#repository.get(ticketId);
      if (ticket.status === "BLOCKED" && ticket.blockedFrom === "READY_TO_MERGE") {
        return await this.#orchestrator.retryIntegration(ticketId, preparationApproval);
      }
      let dispatchStatus = ticket.status;
      if (ticket.status === "BLOCKED") {
        const resolved = this.#repository.resolveBlocked(
          ticketId,
          "user_resolved_block",
          ticket.blockedFrom === "REVIEW" ? "CHANGES_REQUESTED" : undefined,
        );
        if (resolved.status === "QUEUED") throw new Error(`Ticket ${ticketId} is still waiting for dependencies`);
        dispatchStatus = resolved.status;
      } else if (ticket.status === "FAILED" || ticket.status === "INTERRUPTED") {
        dispatchStatus = this.#repository.transition(
          ticketId,
          ticket.workspace === null ? "READY" : "RUNNING",
          "user_retry",
        ).status;
      }
      if (dispatchStatus !== "READY" && dispatchStatus !== "RUNNING" && dispatchStatus !== "CHANGES_REQUESTED") {
        throw new Error(`Ticket ${ticketId} cannot be retried from ${dispatchStatus}`);
      }
      return await this.#orchestrator.dispatch({
        ticketId,
        projectRoot: this.#projectRoot,
        dirtyPolicy,
        ...(preparationApproval === undefined ? {} : { preparationApproval }),
      });
    });
  }

  public confirm(attemptId: string, ticketId?: string): Promise<IntegrationOutcome> {
    return this.#scheduler.serialize(() => this.#orchestrator.confirm(attemptId, ticketId));
  }

  public async cancel(ticketId: string): Promise<Ticket> {
    this.#repository.get(ticketId);
    if (this.#scheduler.activeTicketId === ticketId) return await this.#orchestrator.cancel(ticketId);
    return this.#repository.transition(ticketId, "CANCELLED", "user_cancelled");
  }
}
