import { describe, expect, it } from "vitest";
import { DependencyCycleError } from "../src/domain.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { PlanningPipeline } from "../src/planning-pipeline.js";
import { TicketRepository } from "../src/ticket-repository.js";

describe("PlanningPipeline", () => {
  it("versions approved artifacts and mutates the DAG only after ticket confirmation", () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter(), process.cwd(), "main");
    const interrogation = pipeline.recordInterrogation("Aligned idea");
    expect(interrogation).toMatchObject({ kind: "interrogation", revision: 1, status: "draft" });
    expect(() => pipeline.recordSpec("Too early", interrogation.id)).toThrow(/approved/u);
    pipeline.approve(interrogation.id);
    const spec = pipeline.recordSpec("# Spec", interrogation.id);
    pipeline.approve(spec.id);
    const ticketPlan = pipeline.proposeTickets([
      { id: "one", title: "One", description: "first", predecessorIds: [] },
      { id: "two", title: "Two", description: "second", predecessorIds: ["one"] },
    ], spec.id);

    expect(repository.list()).toEqual([]);
    expect(pipeline.confirmTickets(ticketPlan.id).map((ticket) => ticket.status)).toEqual(["READY", "QUEUED"]);
    expect(repository.dependencies()).toEqual([{ ticketId: "two", predecessorId: "one" }]);
    expect(repository.getPlanningArtifact(ticketPlan.id).status).toBe("approved");
    repository.close();
  });

  it("rejects a cyclic ticket proposal before persistence", () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter(), process.cwd());
    const interrogation = pipeline.approve(pipeline.recordInterrogation("idea").id);
    const spec = pipeline.approve(pipeline.recordSpec("spec", interrogation.id).id);
    expect(() => pipeline.proposeTickets([
      { id: "one", title: "One", description: "first", predecessorIds: ["two"] },
      { id: "two", title: "Two", description: "second", predecessorIds: ["one"] },
    ], spec.id)).toThrow(DependencyCycleError);
    expect(repository.listPlanningArtifacts("tickets")).toEqual([]);
    repository.close();
  });

  it("keeps one planning thread and transfers only the approved predecessor artifact", async () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter(), process.cwd());
    const interrogation = await pipeline.generate("interrogation", "Interrogate this idea");
    pipeline.approve(interrogation.id);
    await pipeline.generate("spec", "Write the spec", interrogation.id);

    const thread = repository.latestPlanningThread();
    expect(thread).not.toBeNull();
    const messages = repository.planningMessages(thread?.id ?? "missing");
    expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(messages.at(-2)?.content).toContain("Use only this approved predecessor artifact");
    expect(messages.at(-2)?.content).toContain("Fake turn 1");
    expect(repository.listPlanningArtifacts()).toHaveLength(2);
    repository.close();
  });
});
