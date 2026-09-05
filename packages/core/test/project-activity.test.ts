import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { PlanningPipeline } from "../src/planning-pipeline.js";
import { ProjectActivityService } from "../src/project-activity.js";
import { TicketRepository } from "../src/ticket-repository.js";
import { createTicket } from "../src/domain.js";

describe("ProjectActivityService", () => {
  it("projects durable planning errors and resolves the original after a linked retry", async () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter({ failAtTurn: 0 }), process.cwd());
    const failed = await pipeline.prepareMessage("Trigger a quota-shaped failure");
    await pipeline.runSession(failed.id).catch(() => undefined);
    repository.updatePlanningSession(failed.id, {
      errorCode: "quota_exhausted",
      errorDetail: "You've hit your usage limit",
    });
    const service = new ProjectActivityService(repository);
    expect(service.summary()).toMatchObject({ count: 1, highestSeverity: "error", latestCode: "quota_exhausted" });
    expect(service.list().items[0]).toMatchObject({
      source: "planning",
      severity: "error",
      action: "retry_planning",
      resolved: false,
    });

    const retry = await pipeline.prepareRetry(failed.id);
    expect(new ProjectActivityService(repository).summary().count).toBe(1);
    expect(new ProjectActivityService(repository).list().items.find((item) => item.sessionId === failed.id)?.resolved).toBe(false);
    await pipeline.cancel(retry.id);
    expect(new ProjectActivityService(repository).summary().count).toBe(0);
    expect(new ProjectActivityService(repository).list().items.find((item) => item.sessionId === failed.id)?.resolved).toBe(true);
    repository.close();
  });

  it("projects failed verification as durable ticket attention and resolves it after a new pass", () => {
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({
      id: "verified-activity", title: "Verify activity", description: "test", baseBranch: "main", hasPredecessors: false,
    }));
    const failed = repository.createWorkspaceVerificationAttempt({
      id: "verification-failed", ticketId: "verified-activity", purpose: "dispatch", status: "FAILED",
      strategy: "go", fingerprint: "failed", plan: {}, workspace: process.cwd(), targetCommit: "one",
      integrationAttemptId: null, resumedFromAttemptId: null, approval: null,
    });
    repository.updateWorkspaceVerificationAttempt(failed.id, {
      diagnosticCode: "verification.failed", diagnosticDetail: "go test failed", completedAt: new Date().toISOString(),
    });
    expect(new ProjectActivityService(repository).list().items[0]).toMatchObject({
      source: "verification", severity: "error", code: "verification.failed", resolved: false,
    });

    const passed = repository.createWorkspaceVerificationAttempt({
      id: "verification-passed", ticketId: "verified-activity", purpose: "dispatch", status: "PASSED",
      strategy: "go", fingerprint: "passed", plan: {}, workspace: process.cwd(), targetCommit: "two",
      integrationAttemptId: null, resumedFromAttemptId: failed.id, approval: null,
    });
    repository.updateWorkspaceVerificationAttempt(passed.id, { completedAt: new Date().toISOString() });
    const activity = new ProjectActivityService(repository);
    expect(activity.summary().count).toBe(0);
    expect(activity.list().items.find((item) => item.id === `verification:${failed.id}`)?.resolved).toBe(true);
    repository.close();
  });

  it("projects only the current Auto pause as unresolved attention", () => {
    const repository = new TicketRepository(":memory:");
    const run = repository.createAutoRun({ id: "auto-activity", dirtyPolicy: "cancel" });
    repository.updateAutoRun(run.id, {
      status: "PAUSED",
      reasonCode: "quota_exhausted",
      reasonDetail: "Usage is unavailable.",
    }, { type: "PAUSED", reasonCode: "quota_exhausted", detail: "Usage is unavailable." });
    const paused = new ProjectActivityService(repository);
    expect(paused.summary()).toMatchObject({ count: 1, highestSeverity: "warning", latestCode: "quota_exhausted" });
    expect(paused.list().items[0]).toMatchObject({ source: "auto", action: "open_auto", resolved: false });

    repository.updateAutoRun(run.id, { status: "RUNNING", reasonCode: null, reasonDetail: null }, {
      type: "RESUMED",
      reasonCode: "user_resumed",
    });
    expect(new ProjectActivityService(repository).summary().count).toBe(0);
    expect(new ProjectActivityService(repository).list().items.find((item) => item.status === "PAUSED")?.resolved).toBe(true);
    repository.close();
  });
});
