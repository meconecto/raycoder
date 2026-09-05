import type { Dispatcher, DispatchRequest } from "./dispatcher.js";
import type { IntegrationOutcome, IntegrationService } from "./integration-service.js";
import type { Ticket } from "./domain.js";
import type { TicketRepository } from "./ticket-repository.js";
import type { WorkspacePreparationApproval, WorkspacePreparationService } from "./workspace-preparation.js";
import type { WorkspaceVerificationApproval, WorkspaceVerificationService } from "./workspace-verification.js";

export interface ProjectOperationResult {
  readonly ticket: Ticket;
  readonly integration: IntegrationOutcome | null;
}

export type ProjectDispatchRequest = DispatchRequest & {
  readonly preparationApproval?: WorkspacePreparationApproval;
  readonly verificationApproval?: WorkspaceVerificationApproval;
};

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
  readonly #preparation: WorkspacePreparationService | null;
  readonly #verification: WorkspaceVerificationService | null;
  #operationActive = false;

  public constructor(
    repository: TicketRepository,
    dispatcher: Dispatcher,
    integration: IntegrationService,
    preparation: WorkspacePreparationService | null = null,
    verification: WorkspaceVerificationService | null = null,
  ) {
    this.#repository = repository;
    this.#dispatcher = dispatcher;
    this.#integration = integration;
    this.#preparation = preparation;
    this.#verification = verification;
  }

  public get integrationMode() {
    return this.#integration.mode;
  }

  public async dispatch(request: ProjectDispatchRequest): Promise<ProjectOperationResult> {
    return this.#exclusive(async () => {
      if (this.#repository.listIntegrationAttempts().some((attempt) => attempt.status === "AWAITING_CONFIRMATION")) {
        throw new IntegrationConfirmationPendingError();
      }
      const ticket = this.#repository.get(request.ticketId);
      if (
        this.#verification !== null
        && request.verificationApproval !== undefined
        && ticket.workspace !== null
        && ticket.baseCommit !== null
      ) {
        await this.#verification.authorize({
          ticketId: ticket.id,
          workspace: ticket.workspace,
          targetCommit: ticket.baseCommit,
          approval: request.verificationApproval,
        });
      }
      const prepared = this.#preparation === null ? null : await this.#preparation.prepareTicket({
        ticketId: request.ticketId,
        projectRoot: request.projectRoot,
        dirtyPolicy: request.dirtyPolicy,
        ...(request.preparationApproval === undefined ? {} : { approval: request.preparationApproval }),
      });
      const dispatched = await this.#dispatcher.dispatch({
        ...request,
        ...(prepared === null ? {} : {
          preparationSummary: prepared.status === "NOT_APPLICABLE"
            ? "no built-in or explicit preparation was applicable"
            : `${prepared.strategy} (${prepared.fingerprint.slice(0, 12)})`,
        }),
      });
      if (dispatched.status !== "READY_TO_MERGE") return { ticket: dispatched, integration: null };
      const integration = await this.#integration.prepare(
        dispatched.id,
        request.preparationApproval,
        request.verificationApproval,
      );
      return { ticket: integration.ticket, integration };
    });
  }

  public async confirm(attemptId: string, ticketId?: string): Promise<IntegrationOutcome> {
    return this.#exclusive(() => this.#integration.confirm(attemptId, ticketId));
  }

  public async retryIntegration(
    ticketId: string,
    preparationApproval?: WorkspacePreparationApproval,
    verificationApproval?: WorkspaceVerificationApproval,
  ): Promise<IntegrationOutcome> {
    return this.#exclusive(() => this.#integration.retry(ticketId, preparationApproval, verificationApproval));
  }

  public async cancel(ticketId: string): Promise<Ticket> {
    if (await this.#preparation?.cancel(ticketId) === true) return this.#repository.get(ticketId);
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
