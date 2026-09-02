import type { Dispatcher, DispatchRequest } from "./dispatcher.js";
import type { IntegrationOutcome, IntegrationService } from "./integration-service.js";
import type { Ticket } from "./domain.js";
import type { TicketRepository } from "./ticket-repository.js";

export interface ProjectOperationResult {
  readonly ticket: Ticket;
  readonly integration: IntegrationOutcome | null;
}

export class ProjectOperationBusyError extends Error {
  public constructor() {
    super("This project already has an active dispatch or integration operation");
    this.name = "ProjectOperationBusyError";
  }
}

export class IntegrationConfirmationPendingError extends Error {
  public constructor() {
    super("Confirm or resolve the pending integration before dispatching another ticket in this project");
    this.name = "IntegrationConfirmationPendingError";
  }
}

export class ProjectOrchestrator {
  readonly #repository: TicketRepository;
  readonly #dispatcher: Dispatcher;
  readonly #integration: IntegrationService;
  #operationActive = false;

  public constructor(repository: TicketRepository, dispatcher: Dispatcher, integration: IntegrationService) {
    this.#repository = repository;
    this.#dispatcher = dispatcher;
    this.#integration = integration;
  }

  public get integrationMode() {
    return this.#integration.mode;
  }

  public async dispatch(request: DispatchRequest): Promise<ProjectOperationResult> {
    return this.#exclusive(async () => {
      if (this.#repository.listIntegrationAttempts().some((attempt) => attempt.status === "AWAITING_CONFIRMATION")) {
        throw new IntegrationConfirmationPendingError();
      }
      const dispatched = await this.#dispatcher.dispatch(request);
      if (dispatched.status !== "READY_TO_MERGE") return { ticket: dispatched, integration: null };
      const integration = await this.#integration.prepare(dispatched.id);
      return { ticket: integration.ticket, integration };
    });
  }

  public async confirm(attemptId: string, ticketId?: string): Promise<IntegrationOutcome> {
    return this.#exclusive(() => this.#integration.confirm(attemptId, ticketId));
  }

  public async retryIntegration(ticketId: string): Promise<IntegrationOutcome> {
    return this.#exclusive(() => this.#integration.retry(ticketId));
  }

  public async cancel(ticketId: string): Promise<Ticket> {
    return this.#dispatcher.cancel(ticketId);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operationActive) throw new ProjectOperationBusyError();
    this.#operationActive = true;
    try {
      return await operation();
    } finally {
      this.#operationActive = false;
    }
  }
}
