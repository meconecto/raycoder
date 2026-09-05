import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { PlanningPipeline } from "../src/planning-pipeline.js";
import { ProjectActivityService } from "../src/project-activity.js";
import { TicketRepository } from "../src/ticket-repository.js";

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
});
