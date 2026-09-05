import { describe, expect, it } from "vitest";
import { AutoRunError, AutoRunService } from "../src/auto-run.js";
import { createTicket } from "../src/domain.js";
import type { ProjectOperationResult } from "../src/project-orchestrator.js";
import type { SchedulerRunOptions } from "../src/scheduler.js";
import { TicketRepository } from "../src/ticket-repository.js";

function addTicket(repository: TicketRepository, id: string, predecessorIds: readonly string[] = []): void {
  repository.create(createTicket({
    id,
    title: id,
    description: `Implement ${id}`,
    baseBranch: "main",
    hasPredecessors: predecessorIds.length > 0,
    now: `2026-09-05T00:00:0${repository.list().length}.000Z`,
  }), predecessorIds);
}

function completeTicket(repository: TicketRepository, ticketId: string): ProjectOperationResult {
  repository.transition(ticketId, "RUNNING", "auto_test");
  repository.transition(ticketId, "REVIEW", "auto_test");
  repository.transition(ticketId, "READY_TO_MERGE", "auto_test");
  const attemptId = `integration-${ticketId}`;
  repository.createIntegrationAttempt({
    id: attemptId,
    ticketId,
    mode: "auto",
    originalBaseCommit: "base",
    ticketHead: "head",
  });
  repository.updateIntegrationAttempt(attemptId, {
    status: "APPLYING",
    observedBaseHead: "base",
    targetCommit: "head",
    verificationStatus: "SKIPPED",
  });
  return { ticket: repository.completeIntegration(attemptId), integration: null };
}

class AutoSchedulerStub {
  public pendingCount = 0;
  public readonly calls: { ticketId: string; options: SchedulerRunOptions }[] = [];
  public failure: unknown = null;

  public constructor(private readonly repository: TicketRepository) {}

  public async enqueue(ticketId: string, options: SchedulerRunOptions): Promise<ProjectOperationResult> {
    this.calls.push({ ticketId, options });
    if (this.failure !== null) throw this.failure;
    return completeTicket(this.repository, ticketId);
  }
}

describe("AutoRunService", () => {
  it("stays manual until Start, then drains eligible tickets sequentially in stable order", async () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "first");
    addTicket(repository, "second", ["first"]);
    const scheduler = new AutoSchedulerStub(repository);
    const auto = new AutoRunService(repository, scheduler);

    expect(auto.snapshot()).toMatchObject({ enabled: false, run: null, queue: [{ id: "first" }] });
    expect(scheduler.calls).toEqual([]);
    const run = auto.start({ dirtyPolicy: "cancel" });
    expect(repository.autoRunEnabled()).toBe(true);
    expect(scheduler.calls).toEqual([]);

    await auto.run(run.id);

    expect(scheduler.calls.map((call) => call.ticketId)).toEqual(["first", "second"]);
    expect(repository.list().map((ticket) => ticket.status)).toEqual(["DONE", "DONE"]);
    expect(repository.getAutoRun(run.id)).toMatchObject({ status: "COMPLETED", reasonCode: "queue_completed" });
    expect(repository.autoRunEnabled()).toBe(false);
    expect(repository.autoRunEvents(run.id).map((event) => event.type)).toEqual([
      "STARTED",
      "TICKET_STARTED", "TICKET_FINISHED",
      "TICKET_STARTED", "TICKET_FINISHED",
      "COMPLETED",
    ]);
    repository.close();
  });

  it("pauses on an approval error and resumes explicitly with the supplied approval", async () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "approval");
    const scheduler = new AutoSchedulerStub(repository);
    const auto = new AutoRunService(repository, scheduler);
    const run = auto.start({ dirtyPolicy: "committed-head" });
    scheduler.failure = Object.assign(new Error("Approval required"), { code: "preparation.approval_required" });

    await auto.run(run.id);
    expect(repository.getAutoRun(run.id)).toMatchObject({
      status: "PAUSED",
      currentTicketId: "approval",
      reasonCode: "preparation.approval_required",
    });
    scheduler.failure = null;
    auto.resume(run.id);
    await auto.run(run.id, {
      preparationApproval: {
        fingerprint: "fingerprint",
        allowNetwork: true,
        allowInstallScripts: false,
        rememberForProject: true,
      },
    });

    expect(repository.get("approval").status).toBe("DONE");
    expect(repository.getAutoRun(run.id).status).toBe("COMPLETED");
    expect(scheduler.calls.at(-1)?.options.preparationApproval?.fingerprint).toBe("fingerprint");
    repository.close();
  });

  it("requires explicit resume after recovery and never creates a second active run", () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "recover");
    const auto = new AutoRunService(repository, new AutoSchedulerStub(repository));
    const run = auto.start({ dirtyPolicy: "cancel" });

    expect(() => auto.start({ dirtyPolicy: "cancel" })).toThrow(AutoRunError);
    const recovered = new AutoRunService(repository, new AutoSchedulerStub(repository)).recoverInterrupted();
    expect(recovered).toMatchObject({ id: run.id, status: "PAUSED", reasonCode: "restart_required" });
    expect(repository.autoRunEnabled()).toBe(true);
    expect(repository.autoRunEvents(run.id).at(-1)).toMatchObject({ type: "PAUSED", reasonCode: "restart_required" });
    repository.close();
  });

  it("pauses instead of skipping a pre-existing ticket that needs attention", async () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "failed");
    repository.transition("failed", "RUNNING", "test");
    repository.transition("failed", "FAILED", "quota_exhausted");
    addTicket(repository, "ready");
    const scheduler = new AutoSchedulerStub(repository);
    const auto = new AutoRunService(repository, scheduler);
    const run = auto.start({ dirtyPolicy: "cancel" });

    await auto.run(run.id);

    expect(repository.get("ready").status).toBe("DONE");
    expect(repository.getAutoRun(run.id)).toMatchObject({ status: "PAUSED", reasonCode: "quota_exhausted" });
    repository.close();
  });

  it("stops cooperatively without cancelling an active ticket", async () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "active");
    addTicket(repository, "later");
    let release: ((result: ProjectOperationResult) => void) | undefined;
    const scheduler = {
      pendingCount: 0,
      enqueue: async (ticketId: string): Promise<ProjectOperationResult> => await new Promise((resolve) => {
        release = () => resolve(completeTicket(repository, ticketId));
      }),
    };
    const auto = new AutoRunService(repository, scheduler);
    const run = auto.start({ dirtyPolicy: "cancel" });
    const driving = auto.run(run.id);
    await Promise.resolve();
    expect(repository.getAutoRun(run.id).currentTicketId).toBe("active");

    auto.stop(run.id);
    release?.({ ticket: repository.get("active"), integration: null });
    await driving;

    expect(repository.getAutoRun(run.id).status).toBe("STOPPED");
    expect(repository.get("active").status).toBe("DONE");
    expect(repository.get("later").status).toBe("READY");
    repository.close();
  });

  it("pauses for integration confirmation instead of dispatching another ticket", async () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "confirm");
    addTicket(repository, "later");
    const scheduler = {
      pendingCount: 0,
      enqueue: async (ticketId: string): Promise<ProjectOperationResult> => {
        repository.transition(ticketId, "RUNNING", "auto_test");
        repository.transition(ticketId, "REVIEW", "auto_test");
        const ticket = repository.transition(ticketId, "READY_TO_MERGE", "auto_test");
        return { ticket, integration: { kind: "awaiting_confirmation" } as ProjectOperationResult["integration"] };
      },
    };
    const auto = new AutoRunService(repository, scheduler);
    const run = auto.start({ dirtyPolicy: "cancel" });

    await auto.run(run.id);

    expect(repository.getAutoRun(run.id)).toMatchObject({
      status: "PAUSED",
      reasonCode: "integration_confirmation_required",
    });
    expect(repository.get("later").status).toBe("READY");
    repository.close();
  });

  it("pauses on configuration or manual intervention and keeps explicit control", () => {
    const repository = new TicketRepository(":memory:");
    addTicket(repository, "configured");
    const auto = new AutoRunService(repository, new AutoSchedulerStub(repository));
    const run = auto.start({ dirtyPolicy: "cancel" });

    expect(auto.pauseForIntervention("configuration_changed")).toMatchObject({
      status: "PAUSED",
      reasonCode: "configuration_changed",
    });
    auto.resume(run.id);
    expect(auto.pauseForIntervention("manual_intervention")).toMatchObject({
      status: "PAUSED",
      reasonCode: "manual_intervention",
    });
    expect(repository.get("configured").status).toBe("READY");
    repository.close();
  });
});
