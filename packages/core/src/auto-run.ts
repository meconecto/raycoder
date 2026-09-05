import { randomUUID } from "node:crypto";
import { isReady, type Ticket } from "./domain.js";
import type { Scheduler, SchedulerRunOptions } from "./scheduler.js";
import type { AutoRun, AutoRunEvent, TicketRepository } from "./ticket-repository.js";

export interface AutoRunSnapshot {
  readonly enabled: boolean;
  readonly run: AutoRun | null;
  readonly events: readonly AutoRunEvent[];
  readonly queue: readonly Ticket[];
}

export class AutoRunError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AutoRunError";
    this.code = code;
  }
}

export class AutoRunService {
  readonly #repository: TicketRepository;
  readonly #scheduler: Pick<Scheduler, "pendingCount" | "enqueue">;
  #driver: Promise<void> | null = null;

  public constructor(repository: TicketRepository, scheduler: Pick<Scheduler, "pendingCount" | "enqueue">) {
    this.#repository = repository;
    this.#scheduler = scheduler;
  }

  public recoverInterrupted(): AutoRun | null {
    return this.#repository.recoverAutoRun();
  }

  public prepareForClose(): AutoRun | null {
    const active = this.#repository.activeAutoRun();
    if (active?.status !== "RUNNING") return null;
    return this.#pause(active, "restart_required", "The runtime closed while Auto was running. Resume explicitly after reopening.");
  }

  public snapshot(): AutoRunSnapshot {
    const run = this.#repository.latestAutoRun();
    return {
      enabled: this.#repository.autoRunEnabled(),
      run,
      events: run === null ? [] : this.#repository.autoRunEvents(run.id),
      queue: this.#eligibleTickets(),
    };
  }

  public start(options: Pick<SchedulerRunOptions, "dirtyPolicy">): AutoRun {
    if (this.#repository.activeAutoRun() !== null) {
      throw new AutoRunError("auto.already_active", "Pause, resume or stop the current Auto run before starting another one");
    }
    if (this.#scheduler.pendingCount !== 0) {
      throw new AutoRunError("auto.operation_busy", "Wait for the current project operation before starting Auto");
    }
    return this.#repository.createAutoRun({ id: randomUUID(), dirtyPolicy: options.dirtyPolicy });
  }

  public resume(runId?: string): AutoRun {
    const active = this.#requireActive(runId);
    if (active.status !== "PAUSED") {
      throw new AutoRunError("auto.invalid_state", `Auto run ${active.id} cannot resume from ${active.status}`);
    }
    if (this.#scheduler.pendingCount !== 0 && active.currentTicketId === null) {
      throw new AutoRunError("auto.operation_busy", "Wait for the current project operation before resuming Auto");
    }
    return this.#repository.updateAutoRun(active.id, {
      status: "RUNNING",
      reasonCode: null,
      reasonDetail: null,
    }, {
      type: "RESUMED",
      reasonCode: "user_resumed",
    });
  }

  public pause(runId?: string): AutoRun {
    const active = this.#requireActive(runId);
    if (active.status === "PAUSED") return active;
    return this.#pause(active, "user_paused", "Auto was paused by the user.");
  }

  public pauseWithReason(runId: string, reasonCode: string, detail: string): AutoRun {
    return this.#pause(this.#repository.getAutoRun(runId), reasonCode, detail);
  }

  public stop(runId?: string): AutoRun {
    const active = this.#requireActive(runId);
    return this.#repository.updateAutoRun(active.id, {
      status: "STOPPED",
      reasonCode: "user_stopped",
      reasonDetail: active.currentTicketId === null
        ? "Auto was stopped by the user."
        : "Auto will not start another ticket after the current operation finishes.",
    }, {
      type: "STOPPED",
      ticketId: active.currentTicketId,
      reasonCode: "user_stopped",
    });
  }

  public pauseForIntervention(reasonCode: "manual_intervention" | "configuration_changed" | "dag_replaced"): AutoRun | null {
    const active = this.#repository.activeAutoRun();
    if (active === null) return null;
    const detail = reasonCode === "manual_intervention"
      ? "A manual ticket action paused Auto."
      : reasonCode === "configuration_changed"
        ? "Operational configuration changed; review it before resuming Auto."
        : "The executable DAG changed; review the queue before resuming Auto.";
    if (active.status === "RUNNING") return this.#pause(active, reasonCode, detail);
    return this.#repository.updateAutoRun(active.id, {
      reasonCode,
      reasonDetail: detail,
    }, {
      type: "PAUSED",
      ticketId: active.currentTicketId,
      reasonCode,
      detail,
    });
  }

  public run(runId: string, options: Omit<SchedulerRunOptions, "dirtyPolicy"> = {}): Promise<void> {
    if (this.#driver !== null) {
      const activeDriver = this.#driver;
      return activeDriver.then(async () => {
        if (this.#repository.getAutoRun(runId).status === "RUNNING") {
          await this.run(runId, options);
        }
      });
    }
    this.#driver = this.#drive(runId, options).finally(() => {
      this.#driver = null;
    });
    return this.#driver;
  }

  public waitForIdle(): Promise<void> {
    return this.#driver ?? Promise.resolve();
  }

  async #drive(runId: string, options: Omit<SchedulerRunOptions, "dirtyPolicy">): Promise<void> {
    while (true) {
      const run = this.#repository.getAutoRun(runId);
      if (run.status !== "RUNNING") return;
      const eligible = this.#eligibleTickets();
      const next = run.currentTicketId === null
        ? eligible[0]
        : eligible.find((ticket) => ticket.id === run.currentTicketId) ?? eligible[0];
      if (next === undefined) {
        this.#finishWithoutEligibleTicket(run);
        return;
      }
      this.#repository.updateAutoRun(run.id, {
        currentTicketId: next.id,
        reasonCode: null,
        reasonDetail: null,
      }, {
        type: "TICKET_STARTED",
        ticketId: next.id,
      });
      try {
        const result = await this.#scheduler.enqueue(next.id, {
          dirtyPolicy: run.dirtyPolicy,
          ...options,
        });
        const current = this.#repository.getAutoRun(run.id);
        this.#repository.updateAutoRun(run.id, { currentTicketId: null }, {
          type: "TICKET_FINISHED",
          ticketId: next.id,
          reasonCode: `ticket.${result.ticket.status.toLowerCase()}`,
          detail: result.integration?.kind ?? null,
        });
        if (current.status === "STOPPED") return;
        if (result.integration?.kind === "awaiting_confirmation") {
          this.#pauseCurrent(run.id, "integration_confirmation_required", "Confirm the pending integration before resuming Auto.");
          return;
        }
        if (result.ticket.status !== "DONE") {
          const durableReason = this.#repository.history(result.ticket.id).at(-1)?.reason;
          this.#pauseCurrent(
            run.id,
            durableReason ?? `ticket_${result.ticket.status.toLowerCase()}`,
            `Ticket ${result.ticket.id} finished in ${result.ticket.status}; Auto did not skip it.`,
          );
          return;
        }
        if (this.#repository.getAutoRun(run.id).status !== "RUNNING") return;
      } catch (error) {
        const current = this.#repository.getAutoRun(run.id);
        if (current.status === "STOPPED") return;
        const code = autoErrorCode(error);
        const detail = safeErrorDetail(error);
        this.#repository.updateAutoRun(run.id, {
          status: "PAUSED",
          currentTicketId: next.id,
          reasonCode: code,
          reasonDetail: detail,
        }, {
          type: "PAUSED",
          ticketId: next.id,
          reasonCode: code,
          detail,
        });
        return;
      }
    }
  }

  #finishWithoutEligibleTicket(run: AutoRun): void {
    const tickets = this.#repository.list();
    const attention = tickets.find((ticket) => ["BLOCKED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(ticket.status));
    if (attention !== undefined) {
      const durableReason = this.#repository.history(attention.id).at(-1)?.reason;
      this.#pause(run, durableReason ?? `ticket_${attention.status.toLowerCase()}`, `Ticket ${attention.id} requires attention.`);
      return;
    }
    const pending = tickets.find((ticket) => ["QUEUED", "RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"].includes(ticket.status));
    if (pending !== undefined) {
      const code = pending.status === "QUEUED" ? "dependencies_pending" : "operation_pending";
      this.#pause(run, code, `Ticket ${pending.id} remains in ${pending.status}.`);
      return;
    }
    this.#repository.updateAutoRun(run.id, {
      status: "COMPLETED",
      currentTicketId: null,
      reasonCode: "queue_completed",
      reasonDetail: "No executable or pending tickets remain.",
    }, {
      type: "COMPLETED",
      reasonCode: "queue_completed",
    });
  }

  #eligibleTickets(): Ticket[] {
    const tickets = this.#repository.list();
    const dependencies = this.#repository.dependencies();
    return tickets.filter((ticket) => ticket.status === "READY" && isReady(ticket.id, tickets, dependencies));
  }

  #pauseCurrent(runId: string, reasonCode: string, detail: string): AutoRun {
    return this.#pause(this.#repository.getAutoRun(runId), reasonCode, detail);
  }

  #pause(run: AutoRun, reasonCode: string, detail: string): AutoRun {
    if (run.status === "STOPPED" || run.status === "COMPLETED") return run;
    return this.#repository.updateAutoRun(run.id, {
      status: "PAUSED",
      reasonCode,
      reasonDetail: detail,
    }, {
      type: "PAUSED",
      ticketId: run.currentTicketId,
      reasonCode,
      detail,
    });
  }

  #requireActive(runId?: string): AutoRun {
    const active = this.#repository.activeAutoRun();
    if (active === null || (runId !== undefined && active.id !== runId)) {
      throw new AutoRunError("auto.not_active", "No matching Auto run is active for this project");
    }
    return active;
  }
}

function autoErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  const name = error instanceof Error ? error.name : "unknown";
  if (name === "ProjectOperationBusyError") return "auto.operation_busy";
  if (name === "IntegrationConfirmationPendingError") return "integration_confirmation_required";
  return "auto.operation_failed";
}

function safeErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [...detail].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("").slice(0, 2_000);
}
