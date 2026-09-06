import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ProviderPreflight,
  StartSessionInput,
} from "../src/agent-adapter.js";
import { DependencyCycleError } from "../src/domain.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import {
  PlanningBusyError,
  PlanningCancelledError,
  PlanningPipeline,
  PlanningResumeUnsupportedError,
} from "../src/planning-pipeline.js";
import { TicketRepository } from "../src/ticket-repository.js";

class ResumablePlanningAdapter implements AgentAdapter {
  public readonly starts: StartSessionInput[] = [];

  public async capabilities(): Promise<AdapterCapabilities> {
    return {
      provider: "resumable",
      cancellation: true,
      resumableSessions: true,
      nativeSkills: false,
      sandboxModes: ["read-only", "workspace-write"],
      models: [{ id: "test", efforts: null }],
    };
  }

  public async preflight(): Promise<ProviderPreflight> {
    return { provider: "resumable", executable: true, diagnostics: [] };
  }

  public async startSession(input: StartSessionInput): Promise<AgentSession> {
    this.starts.push(input);
    const id = `adapter-${this.starts.length}`;
    return { id, provider: "resumable", providerSessionId: `provider-${this.starts.length}` };
  }

  public async *send(_session: AgentSession, prompt: string): AsyncIterable<AgentEvent> {
    const timestamp = new Date().toISOString();
    yield { type: "assistant_message", timestamp, text: `continued: ${prompt}` };
    yield { type: "completed", timestamp, success: true, summary: "complete" };
  }

  public async cancel(): Promise<void> {}
}

class BlockingPlanningAdapter extends ResumablePlanningAdapter {
  #cancelled = false;
  #release: (() => void) | null = null;

  public override async *send(): AsyncIterable<AgentEvent> {
    const timestamp = new Date().toISOString();
    yield { type: "assistant_message", timestamp, text: "working" };
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    yield { type: "completed", timestamp: new Date().toISOString(), success: !this.#cancelled, summary: "stopped" };
  }

  public override async cancel(): Promise<void> {
    this.#cancelled = true;
    this.#release?.();
  }
}

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
    pipeline.approve(ticketPlan.id);
    expect(pipeline.confirmTickets(ticketPlan.id).tickets.map((ticket) => ticket.status)).toEqual(["READY", "QUEUED"]);
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
    const spec = await pipeline.generate("spec", "Write the spec", interrogation.id);

    const thread = repository.latestPlanningThread();
    expect(thread).not.toBeNull();
    const messages = repository.planningMessages(thread?.id ?? "missing");
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    const specSession = repository.listPlanningSessions().find((session) => session.stage === "spec");
    expect(specSession).toBeDefined();
    expect(repository.planningEvents(specSession?.id ?? "missing").some((event) => (
      event.payload.type === "assistant_message"
      && event.payload.text.includes("Deterministic specification")
    ))).toBe(true);
    expect(repository.getPlanningArtifact(interrogation.id).content).toMatchObject({ markdown: expect.stringContaining("Fake turn 1") });
    expect(repository.listPlanningArtifacts()).toHaveLength(3);
    expect(repository.getPlanningArtifact(spec.predecessorArtifactId ?? "missing")).toMatchObject({
      kind: "interrogation",
      status: "approved",
    });
    repository.close();
  });

  it("persists the conversation, normalized events and artifact sources across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-planning-"));
    const path = join(directory, "raycoder.db");
    try {
      const first = new TicketRepository(path);
      const pipeline = new PlanningPipeline(first, new FakeAgentAdapter(), process.cwd());
      const conversation = await pipeline.prepareMessage("Build a durable planner");
      await pipeline.runSession(conversation.id);
      const specSession = await pipeline.prepareGeneration("spec");
      const generated = await pipeline.runSession(specSession.id);
      const artifactId = generated.artifact?.id;
      expect(artifactId).toBeDefined();
      first.close();

      const second = new TicketRepository(path);
      expect(second.listPlanningSessions().map((session) => session.status)).toEqual(["completed", "completed"]);
      expect(second.planningEvents(conversation.id).map((event) => event.type)).toEqual(["assistant_message", "completed"]);
      const artifact = second.getPlanningArtifact(artifactId ?? "missing");
      expect(artifact.sourceSessionId).toBe(specSession.id);
      expect(artifact.sourceMessageIds).toHaveLength(1);
      expect(second.getPlanningArtifact(artifact.predecessorArtifactId ?? "missing").sourceMessageIds).toHaveLength(2);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates planning state between project repositories", async () => {
    const first = new TicketRepository(":memory:");
    const second = new TicketRepository(":memory:");
    const firstPipeline = new PlanningPipeline(first, new FakeAgentAdapter(), process.cwd());
    const session = await firstPipeline.prepareMessage("Only project one");
    await firstPipeline.runSession(session.id);
    expect(first.planningMessages(session.threadId)).toHaveLength(2);
    expect(second.latestPlanningThread()).toBeNull();
    first.close();
    second.close();
  });

  it("persists provider failures without fabricating an artifact", async () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter({ failAtTurn: 0 }), process.cwd());
    const session = await pipeline.prepareMessage("Fail deterministically");
    await expect(pipeline.runSession(session.id)).rejects.toThrow("Scripted fake failure");
    expect(repository.getPlanningSession(session.id)).toMatchObject({
      status: "error",
      errorCode: "fake.failure",
      errorDetail: "Scripted fake failure",
    });
    expect(repository.planningEvents(session.id).map((event) => event.type)).toEqual(["assistant_message", "error"]);
    expect(repository.listPlanningArtifacts()).toEqual([]);
    repository.close();
  });

  it("retries a failed request without duplicating the user message", async () => {
    const repository = new TicketRepository(":memory:");
    const adapter = new FakeAgentAdapter({ failAtTurn: 0 });
    const pipeline = new PlanningPipeline(repository, adapter, process.cwd());
    const failed = await pipeline.prepareMessage("Keep this request once");
    await expect(pipeline.runSession(failed.id)).rejects.toThrow("Scripted fake failure");

    const retry = await pipeline.prepareRetry(failed.id);
    expect(retry).toMatchObject({
      status: "idle",
      retryOfSessionId: failed.id,
      resumedFromSessionId: null,
      request: failed.request,
    });
    expect(repository.planningMessages(failed.threadId).filter((message) => message.role === "user"))
      .toMatchObject([{ content: "Keep this request once", sessionId: failed.id }]);
    await pipeline.cancel(retry.id);
    await expect(pipeline.prepareRetry(retry.id)).rejects.toThrow(/not error/u);
    repository.close();
  });

  it("allows only one pending or running planning operation per project", async () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter(), process.cwd());
    const first = await pipeline.prepareMessage("First operation");
    await expect(pipeline.prepareMessage("Second operation")).rejects.toBeInstanceOf(PlanningBusyError);
    await pipeline.cancel(first.id);
    const second = await pipeline.prepareMessage("Second operation");
    expect(second.status).toBe("idle");
    repository.close();
  });

  it("interrupts orphaned work and resumes only through a capable adapter", async () => {
    const unsupportedRepository = new TicketRepository(":memory:");
    const unsupported = new PlanningPipeline(unsupportedRepository, new FakeAgentAdapter(), process.cwd());
    const unsupportedSession = await unsupported.prepareMessage("Interrupted");
    unsupportedRepository.updatePlanningSession(unsupportedSession.id, {
      status: "running",
      providerSessionId: "opaque-fake",
    });
    unsupported.recoverInterruptedSessions();
    await expect(unsupported.prepareResume(unsupportedSession.id)).rejects.toBeInstanceOf(PlanningResumeUnsupportedError);
    expect(unsupportedRepository.planningMessages(unsupportedSession.threadId)).toHaveLength(1);
    unsupportedRepository.close();

    const repository = new TicketRepository(":memory:");
    const adapter = new ResumablePlanningAdapter();
    const pipeline = new PlanningPipeline(repository, adapter, process.cwd());
    const original = await pipeline.prepareMessage("Resume me");
    repository.updatePlanningSession(original.id, { status: "running", providerSessionId: "opaque-provider-id" });
    expect(pipeline.recoverInterruptedSessions()).toMatchObject([{ id: original.id, status: "interrupted" }]);
    const resumed = await pipeline.prepareResume(original.id);
    expect(resumed.resumedFromSessionId).toBe(original.id);
    await pipeline.runSession(resumed.id);
    expect(adapter.starts.at(-1)?.resumeProviderSessionId).toBe("opaque-provider-id");
    expect(adapter.starts.at(-1)?.sandboxMode).toBe("read-only");
    expect(repository.getPlanningSession(resumed.id).status).toBe("completed");
    repository.close();
  });

  it("cancels an active generation and keeps its partial transcript and events", async () => {
    const repository = new TicketRepository(":memory:");
    const adapter = new BlockingPlanningAdapter();
    const pipeline = new PlanningPipeline(repository, adapter, process.cwd());
    const session = await pipeline.prepareMessage("Wait for cancellation");
    const run = pipeline.runSession(session.id);
    await vi.waitFor(() => expect(repository.getPlanningSession(session.id).status).toBe("running"));
    await pipeline.cancel(session.id);
    await expect(run).rejects.toBeInstanceOf(PlanningCancelledError);
    expect(repository.getPlanningSession(session.id).status).toBe("cancelled");
    expect(repository.planningMessages(session.threadId).map((message) => message.content)).toContain("working");
    expect(repository.planningEvents(session.id).map((event) => event.type)).toContain("assistant_message");
    repository.close();
  });

  it("allows safe DAG replacement and aborts replacement after planned work starts", () => {
    const repository = new TicketRepository(":memory:");
    const pipeline = new PlanningPipeline(repository, new FakeAgentAdapter(), process.cwd(), "main");
    const interrogation = pipeline.approve(pipeline.recordInterrogation("agreed").id);
    const spec = pipeline.approve(pipeline.recordSpec("spec", interrogation.id).id);
    const first = pipeline.proposeTickets([
      { id: "old-parent", title: "Old parent", description: "old plan", predecessorIds: [] },
      { id: "old-child", title: "Old child", description: "old dependent", predecessorIds: ["old-parent"] },
    ], spec.id);
    pipeline.approve(first.id);
    const firstConfirmation = pipeline.confirmTickets(first.id).confirmation;
    const second = pipeline.proposeTickets([
      { id: "old-parent", title: "Updated parent", description: "updated plan", predecessorIds: [] },
      { id: "old-child", title: "Updated child", description: "updated dependent", predecessorIds: ["old-parent"] },
    ], spec.id, first.id);
    pipeline.approve(second.id);
    const secondConfirmation = pipeline.confirmTickets(second.id).confirmation;
    expect(secondConfirmation.replacedArtifactId).toBe(firstConfirmation.artifactId);
    expect(repository.list().map((ticket) => ticket.id).sort()).toEqual(["old-child", "old-parent"]);
    expect(pipeline.confirmTickets(second.id).confirmation.id).toBe(secondConfirmation.id);

    repository.transition("old-parent", "RUNNING", "started");
    const third = pipeline.proposeTickets([
      { id: "future", title: "Future", description: "future plan", predecessorIds: [] },
    ], spec.id, second.id);
    pipeline.approve(third.id);
    expect(() => pipeline.confirmTickets(third.id)).toThrow(/started and cannot be replaced/u);
    expect(repository.list().map((ticket) => ticket.id).sort()).toEqual(["old-child", "old-parent"]);
    expect(repository.latestPlanningDagConfirmation()?.artifactId).toBe(second.id);
    repository.close();
  });
});
