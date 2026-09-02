import type { Ticket } from "./domain.js";
import type { TicketRepository } from "./ticket-repository.js";

export interface ProcessObservation {
  readonly provider: string;
  readonly processAlive: boolean;
  readonly detail: string;
}

export interface ProviderProcessReconciler {
  inspect(ticket: Ticket): Promise<ProcessObservation | null>;
}

export class NoopProcessReconciler implements ProviderProcessReconciler {
  public async inspect(): Promise<null> {
    return null;
  }
}

export interface RecoveryResult {
  readonly ticket: Ticket;
  readonly process: ProcessObservation | null;
}

export class RecoveryService {
  readonly #repository: TicketRepository;
  readonly #processes: ProviderProcessReconciler;

  public constructor(repository: TicketRepository, processes: ProviderProcessReconciler = new NoopProcessReconciler()) {
    this.#repository = repository;
    this.#processes = processes;
  }

  public async recoverUncontrolledShutdown(): Promise<RecoveryResult[]> {
    const uncertain = this.#repository.listByStatus(["RUNNING", "REVIEW", "READY_TO_MERGE"]);
    const results: RecoveryResult[] = [];
    for (const ticket of uncertain) {
      const process = await this.#processes.inspect(ticket);
      const interrupted = this.#repository.transition(
        ticket.id,
        "INTERRUPTED",
        "bootstrap_uncontrolled_shutdown",
      );
      results.push({ ticket: interrupted, process });
    }
    return results;
  }
}
