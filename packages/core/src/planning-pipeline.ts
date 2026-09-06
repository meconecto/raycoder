import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentSession } from "./agent-adapter.js";
import { assertAcyclic, createTicket } from "./domain.js";
import type {
  PlanningArtifact,
  PlanningArtifactKind,
  PlanningMessage,
  PlanningSession,
  PlanningSessionStage,
  PlanningThread,
  TicketRepository,
} from "./ticket-repository.js";
import { sanitizeOutput } from "./workspace-preparation.js";

export interface PlannedTicket {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly predecessorIds: readonly string[];
}

export interface SpecContent {
  readonly title: string;
  readonly summary: string;
  readonly goals: readonly string[];
  readonly nonGoals: readonly string[];
  readonly requirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
}

type PlanningRequest =
  | { readonly kind: "message"; readonly content: string; readonly resumeProviderSessionId?: string }
  | { readonly kind: "spec"; readonly predecessorArtifactId: string; readonly resumeProviderSessionId?: string }
  | { readonly kind: "tickets"; readonly predecessorArtifactId: string; readonly resumeProviderSessionId?: string };

export interface PlanningRunResult {
  readonly session: PlanningSession;
  readonly artifact: PlanningArtifact | null;
}

export class PlanningBusyError extends Error {
  public constructor() {
    super("Another planning operation is already pending or running");
    this.name = "PlanningBusyError";
  }
}

export class PlanningInvalidStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlanningInvalidStateError";
  }
}

export class PlanningResumeUnsupportedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlanningResumeUnsupportedError";
  }
}

export class PlanningGenerationError extends Error {
  public readonly providerCode: string | null;

  public constructor(message: string, providerCode: string | null = null) {
    super(message);
    this.name = "PlanningGenerationError";
    this.providerCode = providerCode;
  }
}

export class PlanningCancelledError extends Error {
  public constructor() {
    super("The planning operation was cancelled");
    this.name = "PlanningCancelledError";
  }
}

export class PlanningPipeline {
  readonly #repository: TicketRepository;
  readonly #adapter: AgentAdapter;
  readonly #projectRoot: string;
  readonly #baseBranch: string;
  #active: { readonly planningSessionId: string; readonly adapterSession: AgentSession } | null = null;

  public constructor(repository: TicketRepository, adapter: AgentAdapter, projectRoot: string, baseBranch = "main") {
    this.#repository = repository;
    this.#adapter = adapter;
    this.#projectRoot = projectRoot;
    this.#baseBranch = baseBranch;
  }

  public ensureThread(provider = "unknown"): PlanningThread {
    const current = this.#repository.latestPlanningThread();
    if (current !== null) return current;
    const now = new Date().toISOString();
    return this.#repository.upsertPlanningThread({
      id: randomUUID(),
      provider,
      providerSessionId: null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
  }

  public recoverInterruptedSessions(): PlanningSession[] {
    this.ensureThread();
    return this.#repository.interruptPlanningSessions();
  }

  public recordInterrogation(markdown: string): PlanningArtifact {
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "interrogation",
      content: { markdown },
      authorRole: "user",
      authorId: "local-user",
    });
  }

  public recordSpec(markdown: string, interrogationArtifactId: string): PlanningArtifact {
    return this.editSpec({
      title: "Specification",
      summary: markdown,
      goals: [],
      nonGoals: [],
      requirements: [],
      acceptanceCriteria: [],
      constraints: [],
    }, interrogationArtifactId);
  }

  public editSpec(content: SpecContent, predecessorArtifactId: string, replacesArtifactId?: string): PlanningArtifact {
    this.#assertApprovedPredecessor(predecessorArtifactId, "interrogation");
    if (replacesArtifactId !== undefined) this.#assertReplacement(replacesArtifactId, "spec");
    const normalized = readSpecContent(content);
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "spec",
      content: normalized,
      predecessorArtifactId,
      ...(replacesArtifactId === undefined ? {} : { replacesArtifactId }),
      authorRole: "user",
      authorId: "local-user",
    });
  }

  public proposeTickets(
    tickets: readonly PlannedTicket[],
    specArtifactId: string,
    replacesArtifactId?: string,
  ): PlanningArtifact {
    this.#assertApprovedPredecessor(specArtifactId, "spec");
    if (replacesArtifactId !== undefined) this.#assertReplacement(replacesArtifactId, "tickets");
    const normalized = readTicketPlan({ tickets });
    validateTicketPlanCandidate(this.#repository, normalized);
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "tickets",
      content: { tickets: normalized },
      predecessorArtifactId: specArtifactId,
      ...(replacesArtifactId === undefined ? {} : { replacesArtifactId }),
      authorRole: "user",
      authorId: "local-user",
    });
  }

  public approve(artifactId: string): PlanningArtifact {
    const artifact = this.#repository.getPlanningArtifact(artifactId);
    if (artifact.status !== "draft") {
      throw new PlanningInvalidStateError(`Planning artifact ${artifactId} is ${artifact.status}, not draft`);
    }
    return this.#repository.approvePlanningArtifact(artifactId);
  }

  public confirmTickets(artifactId: string): ReturnType<TicketRepository["confirmPlanningDag"]> {
    const artifact = this.#repository.getPlanningArtifact(artifactId);
    if (artifact.kind !== "tickets" || artifact.status !== "approved") {
      throw new PlanningInvalidStateError(`Planning artifact ${artifactId} is not an approved ticket plan`);
    }
    const tickets = readTicketPlan(artifact.content);
    validateTicketPlanForReplacement(this.#repository, tickets);
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
    return this.#repository.confirmPlanningDag({
      confirmationId: randomUUID(),
      artifactId,
      entries,
    });
  }

  public async prepareMessage(content: string): Promise<PlanningSession> {
    const trimmed = content.trim();
    if (trimmed.length === 0) throw new PlanningInvalidStateError("Planning messages cannot be empty");
    this.#assertNoPendingOperation();
    const capabilities = await this.#adapter.capabilities();
    this.#assertNoPendingOperation();
    const thread = this.#ensureProviderThread(capabilities.provider);
    const previous = this.#repository.listPlanningSessions(thread.id)
      .filter((session) => session.stage === "conversation" && session.status === "completed")
      .at(-1);
    const request: PlanningRequest = {
      kind: "message",
      content: trimmed,
      ...(capabilities.resumableSessions && previous?.providerSessionId !== null && previous?.providerSessionId !== undefined
        ? { resumeProviderSessionId: previous.providerSessionId }
        : {}),
    };
    const session = this.#repository.createPlanningSession({
      id: randomUUID(),
      threadId: thread.id,
      provider: capabilities.provider,
      stage: "conversation",
      request,
    });
    this.#repository.appendPlanningMessage(thread.id, "user", trimmed, new Date().toISOString(), session.id);
    return session;
  }

  public async prepareGeneration(
    stage: Exclude<PlanningSessionStage, "conversation">,
    predecessorArtifactId?: string,
  ): Promise<PlanningSession> {
    this.#assertNoPendingOperation();
    const capabilities = await this.#adapter.capabilities();
    this.#assertNoPendingOperation();
    const thread = this.#ensureProviderThread(capabilities.provider);
    const predecessor = stage === "spec"
      ? this.#conversationSnapshot(thread)
      : this.#approvedSpec(predecessorArtifactId);
    const request: PlanningRequest = { kind: stage, predecessorArtifactId: predecessor.id };
    const session = this.#repository.createPlanningSession({
      id: randomUUID(),
      threadId: thread.id,
      provider: capabilities.provider,
      stage,
      request,
    });
    this.#repository.appendPlanningMessage(
      thread.id,
      "system",
      stage === "spec" ? "Generate a SPEC revision from the approved conversation snapshot." : "Generate a ticket-plan revision from the approved SPEC.",
      new Date().toISOString(),
      session.id,
    );
    return session;
  }

  public async prepareResume(interruptedSessionId: string): Promise<PlanningSession> {
    this.#assertNoPendingOperation();
    const interrupted = this.#repository.getPlanningSession(interruptedSessionId);
    if (interrupted.status !== "interrupted") {
      throw new PlanningInvalidStateError(`Planning session ${interrupted.id} is ${interrupted.status}, not interrupted`);
    }
    const capabilities = await this.#adapter.capabilities();
    this.#assertNoPendingOperation();
    if (!capabilities.resumableSessions || interrupted.providerSessionId === null) {
      throw new PlanningResumeUnsupportedError(
        `${capabilities.provider} cannot resume this interrupted planning session; cancel it and start a new operation`,
      );
    }
    const request = readPlanningRequest(interrupted.request);
    const resumedRequest = { ...request, resumeProviderSessionId: interrupted.providerSessionId };
    const session = this.#repository.createPlanningSession({
      id: randomUUID(),
      threadId: interrupted.threadId,
      provider: capabilities.provider,
      stage: interrupted.stage,
      request: resumedRequest,
      resumedFromSessionId: interrupted.id,
    });
    this.#repository.appendPlanningMessage(
      interrupted.threadId,
      "system",
      `Resume interrupted ${interrupted.stage} session ${interrupted.id}.`,
      new Date().toISOString(),
      session.id,
    );
    return session;
  }

  public async prepareRetry(failedSessionId: string): Promise<PlanningSession> {
    this.#assertNoPendingOperation();
    const failed = this.#repository.getPlanningSession(failedSessionId);
    if (failed.status !== "error") {
      throw new PlanningInvalidStateError(`Planning session ${failed.id} is ${failed.status}, not error`);
    }
    const capabilities = await this.#adapter.capabilities();
    this.#assertNoPendingOperation();
    const thread = this.#ensureProviderThread(capabilities.provider);
    if (thread.id !== failed.threadId) {
      throw new PlanningInvalidStateError("The failed planning session belongs to a different thread");
    }
    return this.#repository.createPlanningSession({
      id: randomUUID(),
      threadId: failed.threadId,
      provider: capabilities.provider,
      stage: failed.stage,
      request: readPlanningRequest(failed.request),
      retryOfSessionId: failed.id,
    });
  }

  public async runSession(sessionId: string): Promise<PlanningRunResult> {
    let persisted = this.#repository.getPlanningSession(sessionId);
    if (persisted.status === "cancelled") return { session: persisted, artifact: null };
    if (persisted.status !== "idle") {
      throw new PlanningInvalidStateError(`Planning session ${sessionId} is ${persisted.status}, not idle`);
    }
    const request = readPlanningRequest(persisted.request);
    const thread = this.#repository.getPlanningThread(persisted.threadId);
    let adapterSession: AgentSession | null = null;
    try {
      adapterSession = await this.#adapter.startSession({
        workspace: this.#projectRoot,
        purpose: "planning",
        sandboxMode: "read-only",
        ...(request.resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId: request.resumeProviderSessionId }),
      });
      persisted = this.#repository.updatePlanningSession(sessionId, {
        adapterSessionId: adapterSession.id,
        providerSessionId: adapterSession.providerSessionId ?? null,
        status: "running",
        errorCode: null,
        errorDetail: null,
        completedAt: null,
      });
      this.#repository.upsertPlanningThread({
        ...thread,
        provider: adapterSession.provider,
        providerSessionId: adapterSession.providerSessionId ?? thread.providerSessionId,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      this.#active = { planningSessionId: sessionId, adapterSession };
      const assistantMessages: PlanningMessage[] = [];
      let completed = false;
      for await (const event of this.#adapter.send(adapterSession, this.#promptFor(persisted, request))) {
        const durableEvent = event.type === "error" || event.type === "warning"
          ? { ...event, message: sanitizeOutput(event.message) }
          : event;
        this.#repository.appendPlanningEvent(sessionId, durableEvent);
        if (event.type === "assistant_message") {
          assistantMessages.push(this.#repository.appendPlanningMessage(
            thread.id,
            "assistant",
            event.text,
            event.timestamp,
            sessionId,
          ));
        }
        if (event.type === "error") throw new PlanningGenerationError(event.message, event.code ?? null);
        if (event.type === "completed") completed = event.success;
        if (this.#repository.getPlanningSession(sessionId).status === "cancelled") throw new PlanningCancelledError();
      }
      if (!completed) throw new PlanningGenerationError(`Planning stage ${persisted.stage} did not complete successfully`);
      const artifact = this.#artifactFromAssistant(persisted, request, assistantMessages);
      const completedAt = new Date().toISOString();
      const session = this.#repository.updatePlanningSession(sessionId, { status: "completed", completedAt });
      this.#repository.upsertPlanningThread({
        ...thread,
        provider: adapterSession.provider,
        providerSessionId: adapterSession.providerSessionId ?? thread.providerSessionId,
        status: "idle",
        updatedAt: completedAt,
      });
      return { session, artifact };
    } catch (error) {
      const current = this.#repository.getPlanningSession(sessionId);
      if (current.status === "cancelled" || error instanceof PlanningCancelledError) {
        const completedAt = new Date().toISOString();
        if (current.status !== "cancelled") {
          this.#repository.updatePlanningSession(sessionId, { status: "cancelled", completedAt });
        }
        this.#repository.upsertPlanningThread({ ...thread, status: "idle", updatedAt: completedAt });
        throw new PlanningCancelledError();
      }
      const detail = sanitizeOutput(error instanceof Error ? error.message : String(error));
      const code = error instanceof PlanningGenerationError && error.providerCode !== null
        ? error.providerCode
        : "planning.generation_failed";
      const completedAt = new Date().toISOString();
      this.#repository.updatePlanningSession(sessionId, {
        status: "error",
        errorCode: code,
        errorDetail: detail,
        completedAt,
      });
      this.#repository.upsertPlanningThread({ ...thread, status: "error", updatedAt: completedAt });
      throw error;
    } finally {
      if (this.#active?.planningSessionId === sessionId) this.#active = null;
    }
  }

  public async cancel(sessionId: string): Promise<PlanningSession> {
    const session = this.#repository.getPlanningSession(sessionId);
    if (["completed", "cancelled", "error"].includes(session.status)) return session;
    if (session.status === "running") {
      if (this.#active?.planningSessionId !== sessionId) {
        throw new PlanningInvalidStateError("The provider process is no longer controlled by this runtime; recover the session first");
      }
      const capabilities = await this.#adapter.capabilities();
      if (!capabilities.cancellation) throw new PlanningInvalidStateError(`${capabilities.provider} does not support cancellation`);
      await this.#adapter.cancel(this.#active.adapterSession);
    }
    const now = new Date().toISOString();
    const cancelled = this.#repository.updatePlanningSession(sessionId, {
      status: "cancelled",
      errorCode: null,
      errorDetail: null,
      completedAt: now,
    });
    const thread = this.#repository.getPlanningThread(session.threadId);
    this.#repository.upsertPlanningThread({ ...thread, status: "idle", updatedAt: now });
    return cancelled;
  }

  public async generate(
    kind: Exclude<PlanningArtifactKind, "tickets">,
    instruction: string,
    predecessorArtifactId?: string,
  ): Promise<PlanningArtifact> {
    if (kind === "interrogation") {
      const session = await this.prepareMessage(instruction);
      await this.runSession(session.id);
      const messages = this.#repository.planningMessages(session.threadId).filter((message) => message.sessionId === session.id);
      return this.#repository.createPlanningArtifact({
        id: randomUUID(),
        kind: "interrogation",
        content: { markdown: messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n\n") },
        authorRole: "assistant",
        authorId: session.provider,
        sourceSessionId: session.id,
        sourceMessageIds: messages.map((message) => message.id),
      });
    }
    const session = await this.prepareGeneration("spec", predecessorArtifactId);
    const result = await this.runSession(session.id);
    if (result.artifact === null) throw new PlanningGenerationError("SPEC generation produced no artifact");
    return result.artifact;
  }

  #assertNoPendingOperation(): void {
    if (this.#repository.listPlanningSessions().some((session) => session.status === "idle" || session.status === "running")) {
      throw new PlanningBusyError();
    }
  }

  #ensureProviderThread(provider: string): PlanningThread {
    const thread = this.ensureThread(provider);
    if (thread.provider === provider) return thread;
    return this.#repository.upsertPlanningThread({ ...thread, provider, updatedAt: new Date().toISOString() });
  }

  #conversationSnapshot(thread: PlanningThread): PlanningArtifact {
    const sessions = new Map(this.#repository.listPlanningSessions(thread.id).map((session) => [session.id, session]));
    const messages = this.#repository.planningMessages(thread.id).filter((message) => (
      message.sessionId !== null && sessions.get(message.sessionId)?.stage === "conversation"
    ));
    if (messages.length === 0) throw new PlanningInvalidStateError("Start the planning conversation before generating a SPEC");
    const previous = this.#repository.listPlanningArtifacts("interrogation").at(-1);
    const draft = this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind: "interrogation",
      content: {
        messages: messages.map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })),
      },
      ...(previous === undefined ? {} : { replacesArtifactId: previous.id }),
      authorRole: "system",
      authorId: "raycoder",
      sourceMessageIds: messages.map((message) => message.id),
    });
    return this.#repository.approvePlanningArtifact(draft.id);
  }

  #approvedSpec(requestedId?: string): PlanningArtifact {
    const spec = requestedId === undefined
      ? this.#repository.latestApprovedPlanningArtifact("spec")
      : this.#repository.getPlanningArtifact(requestedId);
    if (spec === null || spec.kind !== "spec" || spec.status !== "approved") {
      throw new PlanningInvalidStateError("Approve a SPEC revision before generating tickets");
    }
    return spec;
  }

  #promptFor(session: PlanningSession, request: PlanningRequest): string {
    if (session.resumedFromSessionId !== null) {
      return `Continue the interrupted ${session.stage} operation. Complete the requested response without repeating prior commentary.`;
    }
    if (request.kind === "message") {
      return [
        "Use the grill-with-docs planning approach. Ask focused questions or summarize decisions; do not create or modify tickets.",
        request.content,
      ].join("\n\n");
    }
    const predecessor = this.#repository.getPlanningArtifact(request.predecessorArtifactId);
    const context = JSON.stringify(predecessor.content);
    if (request.kind === "spec") {
      return [
        "Planning stage: spec.",
        "Use only this approved predecessor artifact as explicit context:",
        context,
        "Return only a JSON object with string fields title and summary, plus string arrays goals, nonGoals, requirements, acceptanceCriteria and constraints.",
      ].join("\n\n");
    }
    return [
      "Planning stage: tickets.",
      "Use only this approved predecessor artifact as explicit context:",
      context,
      "Return only a JSON object with a tickets array. Each ticket must contain id, title, description and predecessorIds.",
    ].join("\n\n");
  }

  #artifactFromAssistant(
    session: PlanningSession,
    request: PlanningRequest,
    messages: readonly PlanningMessage[],
  ): PlanningArtifact | null {
    if (request.kind === "message") return null;
    const output = messages.map((message) => message.content).join("");
    const content = parseJsonOutput(output);
    const kind = request.kind;
    const previous = this.#repository.listPlanningArtifacts(kind).at(-1);
    let normalized: SpecContent | { readonly tickets: readonly PlannedTicket[] };
    if (kind === "spec") {
      normalized = readSpecContent(content);
    } else {
      const tickets = readTicketPlan(content);
      validateTicketPlanCandidate(this.#repository, tickets);
      normalized = { tickets };
    }
    return this.#repository.createPlanningArtifact({
      id: randomUUID(),
      kind,
      content: normalized,
      predecessorArtifactId: request.predecessorArtifactId,
      ...(previous === undefined ? {} : { replacesArtifactId: previous.id }),
      authorRole: "assistant",
      authorId: session.provider,
      sourceSessionId: session.id,
      sourceMessageIds: messages.map((message) => message.id),
    });
  }

  #assertApprovedPredecessor(id: string, kind: PlanningArtifactKind): void {
    const artifact = this.#repository.getPlanningArtifact(id);
    if (artifact.kind !== kind || artifact.status !== "approved") {
      throw new PlanningInvalidStateError(`Expected an approved ${kind} artifact, found ${artifact.kind}/${artifact.status}`);
    }
  }

  #assertReplacement(id: string, kind: PlanningArtifactKind): void {
    const artifact = this.#repository.getPlanningArtifact(id);
    if (artifact.kind !== kind) {
      throw new PlanningInvalidStateError(`Expected a ${kind} revision to replace, found ${artifact.kind}`);
    }
  }
}

function validateTicketPlan(
  repository: TicketRepository,
  tickets: readonly PlannedTicket[],
  replacedIds: ReadonlySet<string> = new Set(),
): void {
  const existing = repository.list().filter((ticket) => !replacedIds.has(ticket.id));
  const plannedIds = tickets.map((ticket) => ticket.id);
  if (new Set(plannedIds).size !== plannedIds.length) throw new PlanningInvalidStateError("Ticket plan contains duplicate ids");
  if (plannedIds.some((id) => existing.some((ticket) => ticket.id === id))) {
    throw new PlanningInvalidStateError("Ticket plan contains an id that already exists");
  }
  assertAcyclic(
    [...existing.map((ticket) => ticket.id), ...plannedIds],
    [
      ...repository.dependencies().filter(
        (edge) => !replacedIds.has(edge.ticketId) && !replacedIds.has(edge.predecessorId),
      ),
      ...tickets.flatMap((ticket) => ticket.predecessorIds.map((predecessorId) => ({
        ticketId: ticket.id,
        predecessorId,
      }))),
    ],
  );
}

function validateTicketPlanCandidate(repository: TicketRepository, tickets: readonly PlannedTicket[]): void {
  const previous = repository.latestPlanningDagConfirmation();
  if (previous === null) {
    validateTicketPlan(repository, tickets);
    return;
  }
  const replacedIds = new Set(
    readTicketPlan(repository.getPlanningArtifact(previous.artifactId).content).map((ticket) => ticket.id),
  );
  validateTicketPlan(repository, tickets, replacedIds);
}

function validateTicketPlanForReplacement(
  repository: TicketRepository,
  tickets: readonly PlannedTicket[],
): void {
  const previous = repository.latestPlanningDagConfirmation();
  if (previous === null) {
    validateTicketPlan(repository, tickets);
    return;
  }
  const previousIds = new Set(readTicketPlan(repository.getPlanningArtifact(previous.artifactId).content).map((ticket) => ticket.id));
  validateTicketPlan(repository, tickets, previousIds);
}

export function readTicketPlan(content: unknown): PlannedTicket[] {
  if (typeof content !== "object" || content === null) throw new PlanningInvalidStateError("Invalid ticket plan artifact");
  const tickets = (content as Record<string, unknown>).tickets;
  if (!Array.isArray(tickets)) throw new PlanningInvalidStateError("Ticket plan artifact has no tickets array");
  return tickets.map((value) => {
    if (typeof value !== "object" || value === null) throw new PlanningInvalidStateError("Invalid planned ticket");
    const ticket = value as Record<string, unknown>;
    if (
      typeof ticket.id !== "string"
      || ticket.id.trim().length === 0
      || typeof ticket.title !== "string"
      || ticket.title.trim().length === 0
      || typeof ticket.description !== "string"
      || !Array.isArray(ticket.predecessorIds)
      || !ticket.predecessorIds.every((id) => typeof id === "string")
    ) throw new PlanningInvalidStateError("Invalid planned ticket fields");
    return {
      id: ticket.id.trim(),
      title: ticket.title.trim(),
      description: ticket.description.trim(),
      predecessorIds: [...new Set(ticket.predecessorIds as string[])],
    };
  });
}

export function readSpecContent(content: unknown): SpecContent {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new PlanningInvalidStateError("Invalid SPEC content");
  }
  const value = content as Record<string, unknown>;
  if (typeof value.title !== "string" || value.title.trim().length === 0 || typeof value.summary !== "string") {
    throw new PlanningInvalidStateError("SPEC title and summary must be strings");
  }
  const arrayFields = ["goals", "nonGoals", "requirements", "acceptanceCriteria", "constraints"] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === "string")) {
      throw new PlanningInvalidStateError(`SPEC ${field} must be a string array`);
    }
  }
  return {
    title: value.title.trim(),
    summary: value.summary.trim(),
    goals: normalizeStringArray(value.goals as string[]),
    nonGoals: normalizeStringArray(value.nonGoals as string[]),
    requirements: normalizeStringArray(value.requirements as string[]),
    acceptanceCriteria: normalizeStringArray(value.acceptanceCriteria as string[]),
    constraints: normalizeStringArray(value.constraints as string[]),
  };
}

function normalizeStringArray(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new PlanningGenerationError("The provider did not return valid structured planning output");
  }
}

function readPlanningRequest(value: unknown): PlanningRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanningInvalidStateError("Invalid persisted planning request");
  }
  const request = value as Record<string, unknown>;
  const resumeProviderSessionId = typeof request.resumeProviderSessionId === "string"
    ? request.resumeProviderSessionId
    : undefined;
  if (request.kind === "message" && typeof request.content === "string") {
    return { kind: "message", content: request.content, ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }) };
  }
  if ((request.kind === "spec" || request.kind === "tickets") && typeof request.predecessorArtifactId === "string") {
    return {
      kind: request.kind,
      predecessorArtifactId: request.predecessorArtifactId,
      ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }),
    };
  }
  throw new PlanningInvalidStateError("Invalid persisted planning request fields");
}
