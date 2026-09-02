import type { Ticket } from "./domain.js";
import type { IntegrationRecoveryEvidence } from "./integration-service.js";
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
  readonly #integrationEvidence: IntegrationRecoveryEvidence | null;

  public constructor(
    repository: TicketRepository,
    processes: ProviderProcessReconciler = new NoopProcessReconciler(),
    integrationEvidence: IntegrationRecoveryEvidence | null = null,
  ) {
    this.#repository = repository;
    this.#processes = processes;
    this.#integrationEvidence = integrationEvidence;
  }

  public async recoverUncontrolledShutdown(): Promise<RecoveryResult[]> {
    const uncertain = this.#repository.listByStatus(["RUNNING", "REVIEW", "READY_TO_MERGE"]);
    const results: RecoveryResult[] = [];
    for (const ticket of uncertain) {
      const process = await this.#processes.inspect(ticket);
      let recoveredTicket = this.#repository.transition(
        ticket.id,
        "INTERRUPTED",
        "bootstrap_uncontrolled_shutdown",
      );
      if (ticket.status === "READY_TO_MERGE") {
        const attempt = this.#repository.latestIntegrationAttempt(ticket.id);
        const canInspect = attempt !== null
          && (attempt.status === "APPLYING" || attempt.status === "INTEGRATED")
          && this.#integrationEvidence !== null;
        let integrated = false;
        if (canInspect) {
          try {
            integrated = await this.#integrationEvidence?.isTargetIntegrated(ticket, attempt) ?? false;
          } catch {
            integrated = false;
          }
        }
        if (attempt !== null && integrated) {
          recoveredTicket = this.#repository.recoverCompletedIntegration(attempt.id);
        } else if (attempt !== null) {
          this.#repository.interruptIntegrationAttempt(attempt.id);
        }
      }
      results.push({ ticket: recoveredTicket, process });
    }
    return results;
  }
}
