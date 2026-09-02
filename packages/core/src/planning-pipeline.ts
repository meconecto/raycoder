import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentSession } from "./agent-adapter.js";
import { assertAcyclic, createTicket } from "./domain.js";
import type {
  PlanningArtifact,
  PlanningArtifactKind,
  PlanningThread,
  TicketRepository,
} from "./ticket-repository.js";

export interface PlannedTicket {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly predecessorIds: readonly string[];
}

export class PlanningPipeline {
  readonly #repository: TicketRepository;
  readonly #adapter: AgentAdapter;
  readonly #projectRoot: string;
  readonly #baseBranch: string;
  #session: AgentSession | null = null;

  public constructor(repository: TicketRepository, adapter: AgentAdapter, projectRoot: string, baseBranch = "main") {
    this.#repository = repository;
    this.#adapter = adapter;
    this.#projectRoot = projectRoot;
    this.#baseBranch = baseBranch;
  }

  public recordInterrogation(markdown: string): PlanningArtifact {
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "interrogation",
      content: { markdown },
    });
  }

  public recordSpec(markdown: string, interrogationArtifactId: string): PlanningArtifact {
    this.#assertApprovedPredecessor(interrogationArtifactId, "interrogation");
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "spec",
      content: { markdown },
      predecessorArtifactId: interrogationArtifactId,
    });
  }

  public proposeTickets(tickets: readonly PlannedTicket[], specArtifactId: string): PlanningArtifact {
    this.#assertApprovedPredecessor(specArtifactId, "spec");
    validateTicketPlan(this.#repository, tickets);
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "tickets",
      content: { tickets },
      predecessorArtifactId: specArtifactId,
    });
  }

  public approve(artifactId: string): PlanningArtifact {
    return this.#repository.approvePlanningArtifact(artifactId);
  }

  public confirmTickets(artifactId: string): ReturnType<TicketRepository["createMany"]> {
    const artifact = this.#repository.getPlanningArtifact(artifactId);
    if (artifact.kind !== "tickets" || artifact.status !== "draft") {
      throw new Error(`Planning artifact ${artifactId} is not a draft ticket plan`);
    }
    const tickets = readTicketPlan(artifact.content);
    validateTicketPlan(this.#repository, tickets);
    const entries = tickets.map((planned) => ({
      ticket: createTicket({
        id: planned.id,
        title: planned.title,
        description: planned.description,
        baseBranch: this.#baseBranch,
        hasPredecessors: planned.predecessorIds.length > 0,
      }),
      predecessorIds: planned.predecessorIds,
    }));
    const created = this.#repository.createMany(entries);
    this.#repository.approvePlanningArtifact(artifactId);
    return created;
  }

  public async generate(
    kind: Exclude<PlanningArtifactKind, "tickets">,
    instruction: string,
    predecessorArtifactId?: string,
  ): Promise<PlanningArtifact> {
    const predecessor = predecessorArtifactId === undefined
      ? null
      : this.#repository.getPlanningArtifact(predecessorArtifactId);
    if (predecessor !== null && predecessor.status !== "approved") {
      throw new Error(`Planning predecessor ${predecessor.id} must be approved`);
    }
    const { thread, session } = await this.#planningSession();
    const prompt = [
      `Planning stage: ${kind}.`,
      instruction,
      predecessor === null ? "No predecessor artifact." : `Use only this approved predecessor artifact as transferred context:\n${JSON.stringify(predecessor.content)}`,
    ].join("\n\n");
    this.#repository.appendPlanningMessage(thread.id, "user", prompt);
    const messages: string[] = [];
    let completed = false;
    for await (const event of this.#adapter.send(session, prompt)) {
      if (event.type === "assistant_message") {
        messages.push(event.text);
        this.#repository.appendPlanningMessage(thread.id, "assistant", event.text, event.timestamp);
      }
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "completed") completed = event.success;
    }
    if (!completed) throw new Error(`Planning stage ${kind} did not complete successfully`);
    this.#repository.upsertPlanningThread({
      ...thread,
      providerSessionId: session.providerSessionId ?? thread.providerSessionId,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind,
      content: { markdown: messages.join("\n\n") },
      ...(predecessor === null ? {} : { predecessorArtifactId: predecessor.id }),
    });
  }

  async #planningSession(): Promise<{ thread: PlanningThread; session: AgentSession }> {
    const current = this.#repository.latestPlanningThread();
    if (this.#session !== null && current !== null) return { thread: current, session: this.#session };
    const capabilities = await this.#adapter.capabilities();
    const session = await this.#adapter.startSession({
      workspace: this.#projectRoot,
      purpose: "planning",
      ...(capabilities.resumableSessions && current?.providerSessionId !== null && current?.providerSessionId !== undefined
        ? { resumeProviderSessionId: current.providerSessionId }
        : {}),
    });
    const now = new Date().toISOString();
    const thread = this.#repository.upsertPlanningThread({
      id: current?.id ?? randomUUID(),
      provider: session.provider,
      providerSessionId: session.providerSessionId ?? current?.providerSessionId ?? null,
      status: "active",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    this.#session = session;
    return { thread, session };
  }

  #assertApprovedPredecessor(id: string, kind: PlanningArtifactKind): void {
    const artifact = this.#repository.getPlanningArtifact(id);
    if (artifact.kind !== kind || artifact.status !== "approved") {
      throw new Error(`Expected an approved ${kind} artifact, found ${artifact.kind}/${artifact.status}`);
    }
  }

}

function validateTicketPlan(repository: TicketRepository, tickets: readonly PlannedTicket[]): void {
  const existing = repository.list();
  const plannedIds = tickets.map((ticket) => ticket.id);
  if (new Set(plannedIds).size !== plannedIds.length) throw new Error("Ticket plan contains duplicate ids");
  assertAcyclic(
    [...existing.map((ticket) => ticket.id), ...plannedIds],
    [
      ...repository.dependencies(),
      ...tickets.flatMap((ticket) => ticket.predecessorIds.map((predecessorId) => ({
        ticketId: ticket.id,
        predecessorId,
      }))),
    ],
  );
}

function readTicketPlan(content: unknown): PlannedTicket[] {
  if (typeof content !== "object" || content === null) throw new Error("Invalid ticket plan artifact");
  const tickets = (content as Record<string, unknown>).tickets;
  if (!Array.isArray(tickets)) throw new Error("Ticket plan artifact has no tickets array");
  return tickets.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("Invalid planned ticket");
    const ticket = value as Record<string, unknown>;
    if (
      typeof ticket.id !== "string"
      || typeof ticket.title !== "string"
      || typeof ticket.description !== "string"
      || !Array.isArray(ticket.predecessorIds)
      || !ticket.predecessorIds.every((id) => typeof id === "string")
    ) throw new Error("Invalid planned ticket fields");
    return {
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      predecessorIds: ticket.predecessorIds as string[],
    };
  });
}
