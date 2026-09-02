import type { DirtyWorkspacePolicy } from "./git-workspace.js";
import type { ProjectOperationResult, ProjectOrchestrator } from "./project-orchestrator.js";
import type { TicketRepository } from "./ticket-repository.js";

export interface SchedulerRunOptions {
  readonly dirtyPolicy: DirtyWorkspacePolicy;
  readonly model?: string;
  readonly effort?: string;
}

export class Scheduler {
  readonly #repository: TicketRepository;
  readonly #orchestrator: ProjectOrchestrator;
  readonly #projectRoot: string;
  #tail: Promise<void> = Promise.resolve();
  #activeTicketId: string | null = null;
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
