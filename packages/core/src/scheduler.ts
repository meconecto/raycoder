import type { DirtyWorkspacePolicy } from "./git-workspace.js";
import type { ProjectOperationResult, ProjectOrchestrator } from "./project-orchestrator.js";
import type { TicketRepository } from "./ticket-repository.js";
import type { WorkspacePreparationApproval } from "./workspace-preparation.js";
import type { WorkspaceVerificationApproval } from "./workspace-verification.js";

export interface SchedulerRunOptions {
  readonly dirtyPolicy: DirtyWorkspacePolicy;
  readonly model?: string;
  readonly effort?: string;
  readonly preparationApproval?: WorkspacePreparationApproval;
  readonly verificationApproval?: WorkspaceVerificationApproval;
}

export class Scheduler {
  readonly #repository: TicketRepository;
  readonly #orchestrator: ProjectOrchestrator;
  readonly #projectRoot: string;
  #tail: Promise<void> = Promise.resolve();
  #activeTicketId: string | null = null;
  #activePlanningSessionId: string | null = null;
  #pending = 0;

  public constructor(repository: TicketRepository, orchestrator: ProjectOrchestrator, projectRoot: string) {
    this.#repository = repository;
    this.#orchestrator = orchestrator;
    this.#projectRoot = projectRoot;
  }

  public get activeTicketId(): string | null {
    return this.#activeTicketId;
  }

  public get pendingCount(): number {
    return this.#pending;
  }

  public get activePlanningSessionId(): string | null {
    return this.#activePlanningSessionId;
  }

  public enqueue(ticketId: string, options: SchedulerRunOptions): Promise<ProjectOperationResult> {
    return this.serialize(async () => {
      this.#activeTicketId = ticketId;
      try {
        return await this.#orchestrator.dispatch({
          ticketId,
          projectRoot: this.#projectRoot,
          dirtyPolicy: options.dirtyPolicy,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          ...(options.preparationApproval === undefined ? {} : { preparationApproval: options.preparationApproval }),
          ...(options.verificationApproval === undefined ? {} : { verificationApproval: options.verificationApproval }),
        });
      } finally {
        this.#activeTicketId = null;
      }
    });
  }

  public async runUntilIdle(options: SchedulerRunOptions): Promise<ProjectOperationResult[]> {
    const results: ProjectOperationResult[] = [];
    while (true) {
      const next = this.#repository.listByStatus(["READY"])[0];
      if (next === undefined) return results;
      const result = await this.enqueue(next.id, options);
      results.push(result);
      if (result.integration?.kind === "awaiting_confirmation") return results;
    }
  }

  public schedulePlanning<T>(planningSessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.#activePlanningSessionId = planningSessionId;
      try {
        return await operation();
      } finally {
        this.#activePlanningSessionId = null;
      }
    });
  }

  public async controlPlanning<T>(operation: () => Promise<T>): Promise<T> {
    return await operation();
  }

  public serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#pending -= 1;
    });
  }
}
