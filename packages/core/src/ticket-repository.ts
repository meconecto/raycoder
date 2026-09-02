import Database from "better-sqlite3";
import {
  assertAcyclic,
  blockTicket,
  desiredPendingStatus,
  replaceTicketDependencies,
  resolveBlockedTicket,
  transitionTicket,
  UnknownTicketError,
  type DependencyEdge,
  type IntegrationAttemptStatus,
  type IntegrationMode,
  type OperationalStatus,
  type Ticket,
  type TicketStatus,
  type VerificationStatus,
} from "./domain.js";
import { migrate } from "./migrations.js";

interface TicketRow {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  blocked_from: OperationalStatus | null;
  branch: string | null;
  base_branch: string;
  base_commit: string | null;
  workspace: string | null;
  created_at: string;
  updated_at: string;
}

interface IntegrationAttemptRow {
  id: string;
  ticket_id: string;
  mode: IntegrationMode;
  status: IntegrationAttemptStatus;
  original_base_commit: string;
  observed_base_head: string | null;
  ticket_head: string | null;
  target_commit: string | null;
  reconciliation_workspace: string | null;
  base_moved: number;
  verification_status: VerificationStatus | null;
  verification_commands_json: string;
  verification_output: string | null;
  diagnostic_code: string | null;
  diagnostic_detail: string | null;
  confirmed_at: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TicketHistoryEntry {
  readonly id: number;
  readonly ticketId: string;
  readonly fromStatus: TicketStatus | null;
  readonly toStatus: TicketStatus;
  readonly reason: string;
  readonly createdAt: string;
}

export interface GitMetadata {
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly workspace: string;
}

export interface PersistedAgentSession {
  readonly id: string;
  readonly ticketId: string;
  readonly provider: string;
  readonly providerSessionId: string | null;
  readonly status: string;
  readonly role?: "implementation" | "review" | "planning";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewDecision {
  readonly id: number;
  readonly ticketId: string;
  readonly sessionId: string;
  readonly reviewerProvider: string;
  readonly verdict: "approved" | "changes_requested";
  readonly summary: string;
  readonly findings: readonly string[];
  readonly createdAt: string;
}

export interface GitObservation {
  readonly id: number;
  readonly ticketId: string;
  readonly workspace: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly isClean: boolean | null;
  readonly source: string;
  readonly createdAt: string;
}

export interface AgentProcessObservation {
  readonly id: number;
  readonly sessionId: string;
  readonly processAlive: boolean;
  readonly source: string;
  readonly detail: string;
  readonly createdAt: string;
}

export type PlanningArtifactKind = "interrogation" | "spec" | "tickets";
export type PlanningArtifactStatus = "draft" | "approved" | "superseded";

export interface PlanningArtifact {
  readonly id: string;
  readonly kind: PlanningArtifactKind;
  readonly revision: number;
  readonly content: unknown;
  readonly predecessorArtifactId: string | null;
  readonly status: PlanningArtifactStatus;
  readonly createdAt: string;
  readonly approvedAt: string | null;
}

interface PlanningArtifactRow {
  id: string;
  kind: PlanningArtifactKind;
  revision: number;
  content_json: string;
  predecessor_artifact_id: string | null;
  status: PlanningArtifactStatus;
  created_at: string;
  approved_at: string | null;
}

export interface PlanningThread {
  readonly id: string;
  readonly provider: string;
  readonly providerSessionId: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanningMessage {
  readonly id: number;
  readonly threadId: string;
  readonly sequence: number;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt: string;
}

interface ReviewDecisionRow {
  id: number;
  ticket_id: string;
  session_id: string;
  reviewer_provider: string;
  verdict: "approved" | "changes_requested";
  summary: string;
  findings_json: string;
  created_at: string;
}

export interface IntegrationAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly mode: IntegrationMode;
  readonly status: IntegrationAttemptStatus;
  readonly originalBaseCommit: string;
  readonly observedBaseHead: string | null;
  readonly ticketHead: string | null;
  readonly targetCommit: string | null;
  readonly reconciliationWorkspace: string | null;
  readonly baseMoved: boolean;
  readonly verificationStatus: VerificationStatus | null;
  readonly verificationCommands: readonly string[];
  readonly verificationOutput: string | null;
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
  readonly confirmedAt: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateIntegrationAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly mode: IntegrationMode;
  readonly originalBaseCommit: string;
  readonly ticketHead: string;
  readonly now?: string;
}

export interface IntegrationAttemptUpdate {
  readonly status?: IntegrationAttemptStatus;
  readonly observedBaseHead?: string;
  readonly ticketHead?: string;
  readonly targetCommit?: string;
  readonly reconciliationWorkspace?: string;
  readonly baseMoved?: boolean;
  readonly verificationStatus?: VerificationStatus;
  readonly verificationCommands?: readonly string[];
  readonly verificationOutput?: string;
  readonly diagnosticCode?: string;
  readonly diagnosticDetail?: string;
  readonly confirmedAt?: string;
  readonly completedAt?: string;
}

export class TicketRepository {
  readonly #database: Database.Database;

  public constructor(path: string) {
    this.#database = new Database(path);
    migrate(this.#database);
  }

  public close(): void {
    this.#database.close();
  }

  public create(ticket: Ticket, predecessorIds: readonly string[] = []): Ticket {
    const existingTickets = this.list();
    assertAcyclic(
      [...existingTickets.map((candidate) => candidate.id), ticket.id],
      [
        ...this.dependencies(),
        ...[...new Set(predecessorIds)].map((predecessorId) => ({ ticketId: ticket.id, predecessorId })),
      ],
    );
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare(`INSERT INTO tickets (
          id, title, description, status, blocked_from, branch, base_branch, base_commit, workspace, created_at, updated_at
        ) VALUES (@id, @title, @description, @status, @blockedFrom, @branch, @baseBranch, @baseCommit, @workspace, @createdAt, @updatedAt)`)
        .run(ticket);

      const insertEdge = this.#database.prepare(
        "INSERT INTO ticket_dependencies (ticket_id, predecessor_id) VALUES (?, ?)",
      );
      for (const predecessorId of new Set(predecessorIds)) insertEdge.run(ticket.id, predecessorId);
      this.#recordHistory(ticket.id, null, ticket.status, "created", ticket.createdAt);
    });
    transaction();
    return this.get(ticket.id);
  }

  public createMany(entries: readonly { ticket: Ticket; predecessorIds: readonly string[] }[]): Ticket[] {
    if (entries.length === 0) return [];
    const existing = this.list();
    const newIds = entries.map((entry) => entry.ticket.id);
    if (new Set(newIds).size !== newIds.length || newIds.some((id) => existing.some((ticket) => ticket.id === id))) {
      throw new Error("Ticket plan contains duplicate or existing ticket ids");
    }
    const allIds = [...existing.map((ticket) => ticket.id), ...newIds];
    const newEdges = entries.flatMap((entry) => [...new Set(entry.predecessorIds)].map((predecessorId) => ({
      ticketId: entry.ticket.id,
      predecessorId,
    })));
    assertAcyclic(allIds, [...this.dependencies(), ...newEdges]);
    const transaction = this.#database.transaction(() => {
      const insertTicket = this.#database.prepare(`INSERT INTO tickets (
        id, title, description, status, blocked_from, branch, base_branch, base_commit, workspace, created_at, updated_at
      ) VALUES (@id, @title, @description, @status, @blockedFrom, @branch, @baseBranch, @baseCommit, @workspace, @createdAt, @updatedAt)`);
      const insertEdge = this.#database.prepare("INSERT INTO ticket_dependencies (ticket_id, predecessor_id) VALUES (?, ?)");
      for (const entry of entries) {
        insertTicket.run(entry.ticket);
        for (const predecessorId of new Set(entry.predecessorIds)) insertEdge.run(entry.ticket.id, predecessorId);
        this.#recordHistory(entry.ticket.id, null, entry.ticket.status, "created_from_confirmed_plan", entry.ticket.createdAt);
      }
    });
    transaction();
    return entries.map((entry) => this.get(entry.ticket.id));
  }

  public get(id: string): Ticket {
    const row = this.#database.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;
    if (row === undefined) throw new UnknownTicketError(id);
    return fromRow(row);
  }

  public list(): Ticket[] {
    return (this.#database.prepare("SELECT * FROM tickets ORDER BY created_at, id").all() as TicketRow[]).map(fromRow);
  }

  public listByStatus(statuses: readonly TicketStatus[]): Ticket[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return (
      this.#database.prepare(`SELECT * FROM tickets WHERE status IN (${placeholders}) ORDER BY created_at, id`).all(...statuses) as TicketRow[]
    ).map(fromRow);
  }

  public history(ticketId: string): TicketHistoryEntry[] {
    return this.#database
      .prepare(`SELECT id, ticket_id AS ticketId, from_status AS fromStatus, to_status AS toStatus,
        reason, created_at AS createdAt FROM ticket_history WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as TicketHistoryEntry[];
  }

  public transition(id: string, to: TicketStatus, reason: string, now = new Date().toISOString()): Ticket {
    const current = this.get(id);
    const next = transitionTicket(current, to, now);
    this.#persistTransition(current, next, reason);
    return next;
  }

  public block(id: string, reason: string, now = new Date().toISOString()): Ticket {
    const current = this.get(id);
    const next = blockTicket(current, now);
    this.#persistTransition(current, next, reason);
    return next;
  }

  public resolveBlocked(id: string, reason: string, target?: OperationalStatus, now = new Date().toISOString()): Ticket {
    const current = this.get(id);
    const next = resolveBlockedTicket(current, target, now);
    this.#persistTransition(current, next, reason);
    return next;
  }

  public setGitMetadata(id: string, metadata: GitMetadata, now = new Date().toISOString()): Ticket {
    this.get(id);
    this.#database
      .prepare(`UPDATE tickets SET branch = @branch, base_branch = @baseBranch, base_commit = @baseCommit,
        workspace = @workspace, updated_at = @now WHERE id = @id`)
      .run({ id, ...metadata, now });
    return this.get(id);
  }

  public dependencies(): DependencyEdge[] {
    return this.#database
      .prepare("SELECT ticket_id AS ticketId, predecessor_id AS predecessorId FROM ticket_dependencies ORDER BY ticket_id, predecessor_id")
      .all() as DependencyEdge[];
  }

  public replaceDependencies(ticketId: string, predecessorIds: readonly string[]): Ticket {
    const tickets = this.list();
    const ticket = tickets.find((candidate) => candidate.id === ticketId);
    if (ticket === undefined) throw new UnknownTicketError(ticketId);
    if (ticket.status !== "QUEUED" && ticket.status !== "READY") {
      throw new Error(`Dependencies can only change while pending; ${ticketId} is ${ticket.status}`);
    }

    const nextEdges = replaceTicketDependencies(
      tickets.map((candidate) => candidate.id),
      this.dependencies(),
      ticketId,
      predecessorIds,
    );

    const transaction = this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM ticket_dependencies WHERE ticket_id = ?").run(ticketId);
      const insert = this.#database.prepare(
        "INSERT INTO ticket_dependencies (ticket_id, predecessor_id) VALUES (?, ?)",
      );
      for (const edge of nextEdges.filter((candidate) => candidate.ticketId === ticketId)) {
        insert.run(edge.ticketId, edge.predecessorId);
      }
    });
    transaction();
    return this.reconcileReadiness(ticketId);
  }

  public reconcileReadiness(id: string): Ticket {
    const ticket = this.get(id);
    if (ticket.status !== "QUEUED" && ticket.status !== "READY") return ticket;
    const desired = desiredPendingStatus(ticket, this.list(), this.dependencies());
    if (desired === ticket.status) return ticket;
    return this.transition(id, desired, "dependencies_reconciled");
  }

  public createAgentSession(session: PersistedAgentSession): void {
    this.#database.prepare(`INSERT INTO agent_sessions (
      id, ticket_id, provider, provider_session_id, status, created_at, updated_at, role
    ) VALUES (@id, @ticketId, @provider, @providerSessionId, @status, @createdAt, @updatedAt, @role)`).run({
      ...session,
      role: session.role ?? "implementation",
    });
  }

  public listAgentSessions(ticketId: string): PersistedAgentSession[] {
    return this.#database.prepare(`SELECT id, ticket_id AS ticketId, provider,
      provider_session_id AS providerSessionId, status, role, created_at AS createdAt,
      updated_at AS updatedAt FROM agent_sessions WHERE ticket_id = ? ORDER BY created_at, rowid`)
      .all(ticketId) as PersistedAgentSession[];
  }

  public latestAgentSession(ticketId: string, role?: "implementation" | "review" | "planning"): PersistedAgentSession | null {
    const row = role === undefined
      ? this.#database.prepare(`SELECT id, ticket_id AS ticketId, provider,
          provider_session_id AS providerSessionId, status, role, created_at AS createdAt,
          updated_at AS updatedAt FROM agent_sessions WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get(ticketId)
      : this.#database.prepare(`SELECT id, ticket_id AS ticketId, provider,
          provider_session_id AS providerSessionId, status, role, created_at AS createdAt,
          updated_at AS updatedAt FROM agent_sessions WHERE ticket_id = ? AND role = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get(ticketId, role);
    return (row as PersistedAgentSession | undefined) ?? null;
  }

  public updateAgentSession(id: string, values: { providerSessionId?: string; status?: string }, now = new Date().toISOString()): void {
    const current = this.#database
      .prepare("SELECT provider_session_id AS providerSessionId, status FROM agent_sessions WHERE id = ?")
      .get(id) as { providerSessionId: string | null; status: string } | undefined;
    if (current === undefined) throw new Error(`Unknown agent session: ${id}`);
    this.#database
      .prepare("UPDATE agent_sessions SET provider_session_id = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(values.providerSessionId ?? current.providerSessionId, values.status ?? current.status, now, id);
  }

  public appendAgentEvent(sessionId: string, sequence: number, event: { type: string }, now = new Date().toISOString()): void {
    this.#database
      .prepare(`INSERT INTO agent_events (session_id, sequence, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, sequence, event.type, JSON.stringify(event), now);
  }

  public agentEvents(sessionId: string): unknown[] {
    return (this.#database
      .prepare("SELECT payload_json FROM agent_events WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as { payload_json: string }[]).map((row) => JSON.parse(row.payload_json) as unknown);
  }

  public recordProcessObservation(input: {
    sessionId: string;
    processAlive: boolean;
    source: string;
    detail: string;
    createdAt?: string;
  }): void {
    this.#database.prepare(`INSERT INTO agent_process_observations
      (session_id, process_alive, source, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.sessionId, input.processAlive ? 1 : 0, input.source, input.detail, input.createdAt ?? new Date().toISOString());
  }

  public processObservations(sessionId: string): AgentProcessObservation[] {
    const rows = this.#database.prepare(`SELECT id, session_id AS sessionId, process_alive AS processAlive,
      source, detail, created_at AS createdAt FROM agent_process_observations WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as (Omit<AgentProcessObservation, "processAlive"> & { processAlive: number })[];
    return rows.map((row) => ({ ...row, processAlive: row.processAlive === 1 }));
  }

  public recordGitObservation(input: {
    ticketId: string;
    workspace: string;
    head: string | null;
    branch: string | null;
    isClean: boolean | null;
    source: string;
    createdAt?: string;
  }): void {
    this.get(input.ticketId);
    this.#database.prepare(`INSERT INTO git_observations
      (ticket_id, workspace, head, branch, is_clean, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.ticketId,
        input.workspace,
        input.head,
        input.branch,
        input.isClean === null ? null : input.isClean ? 1 : 0,
        input.source,
        input.createdAt ?? new Date().toISOString(),
      );
  }

  public gitObservations(ticketId: string): GitObservation[] {
    const rows = this.#database.prepare(`SELECT id, ticket_id AS ticketId, workspace, head, branch,
      is_clean AS isClean, source, created_at AS createdAt FROM git_observations WHERE ticket_id = ? ORDER BY id`)
      .all(ticketId) as (Omit<GitObservation, "isClean"> & { isClean: number | null })[];
    return rows.map((row) => ({ ...row, isClean: row.isClean === null ? null : row.isClean === 1 }));
  }

  public recordReviewDecision(input: Omit<ReviewDecision, "id" | "createdAt"> & { createdAt?: string }): ReviewDecision {
    this.get(input.ticketId);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.#database.prepare(`INSERT INTO review_decisions
      (ticket_id, session_id, reviewer_provider, verdict, summary, findings_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        input.ticketId,
        input.sessionId,
        input.reviewerProvider,
        input.verdict,
        input.summary,
        JSON.stringify(input.findings),
        createdAt,
      );
    return this.reviewDecisions(input.ticketId).find((decision) => decision.id === Number(result.lastInsertRowid)) as ReviewDecision;
  }

  public reviewDecisions(ticketId: string): ReviewDecision[] {
    return (this.#database.prepare("SELECT * FROM review_decisions WHERE ticket_id = ? ORDER BY id").all(ticketId) as ReviewDecisionRow[])
      .map((row) => ({
        id: row.id,
        ticketId: row.ticket_id,
        sessionId: row.session_id,
        reviewerProvider: row.reviewer_provider,
        verdict: row.verdict,
        summary: row.summary,
        findings: parseStringArray(row.findings_json, `review decision ${row.id}`),
        createdAt: row.created_at,
      }));
  }

  public createPlanningArtifact(input: {
    id: string;
    kind: PlanningArtifactKind;
    content: unknown;
    predecessorArtifactId?: string;
    createdAt?: string;
  }): PlanningArtifact {
    if (input.predecessorArtifactId !== undefined) this.getPlanningArtifact(input.predecessorArtifactId);
    const row = this.#database.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM planning_artifacts WHERE kind = ?")
      .get(input.kind) as { revision: number };
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#database.prepare(`INSERT INTO planning_artifacts
      (id, kind, revision, content_json, predecessor_artifact_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?)`)
      .run(
        input.id,
        input.kind,
        row.revision + 1,
        JSON.stringify(input.content),
        input.predecessorArtifactId ?? null,
        createdAt,
      );
    return this.getPlanningArtifact(input.id);
  }

  public getPlanningArtifact(id: string): PlanningArtifact {
    const row = this.#database.prepare("SELECT * FROM planning_artifacts WHERE id = ?").get(id) as PlanningArtifactRow | undefined;
    if (row === undefined) throw new Error(`Unknown planning artifact: ${id}`);
    return planningArtifactFromRow(row);
  }

  public listPlanningArtifacts(kind?: PlanningArtifactKind): PlanningArtifact[] {
    const rows = kind === undefined
      ? this.#database.prepare("SELECT * FROM planning_artifacts ORDER BY created_at, rowid").all()
      : this.#database.prepare("SELECT * FROM planning_artifacts WHERE kind = ? ORDER BY revision").all(kind);
    return (rows as PlanningArtifactRow[]).map(planningArtifactFromRow);
  }

  public approvePlanningArtifact(id: string, now = new Date().toISOString()): PlanningArtifact {
    const artifact = this.getPlanningArtifact(id);
    if (artifact.status !== "draft") throw new Error(`Planning artifact ${id} is ${artifact.status}, not draft`);
    const transaction = this.#database.transaction(() => {
      this.#database.prepare("UPDATE planning_artifacts SET status = 'superseded' WHERE kind = ? AND status = 'approved'")
        .run(artifact.kind);
      this.#database.prepare("UPDATE planning_artifacts SET status = 'approved', approved_at = ? WHERE id = ?")
        .run(now, id);
    });
    transaction();
    return this.getPlanningArtifact(id);
  }

  public upsertPlanningThread(input: PlanningThread): PlanningThread {
    this.#database.prepare(`INSERT INTO planning_threads
      (id, provider, provider_session_id, status, created_at, updated_at)
      VALUES (@id, @provider, @providerSessionId, @status, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET provider_session_id = excluded.provider_session_id,
      status = excluded.status, updated_at = excluded.updated_at`).run(input);
    return this.getPlanningThread(input.id);
  }

  public getPlanningThread(id: string): PlanningThread {
    const row = this.#database.prepare(`SELECT id, provider, provider_session_id AS providerSessionId,
      status, created_at AS createdAt, updated_at AS updatedAt FROM planning_threads WHERE id = ?`).get(id) as PlanningThread | undefined;
    if (row === undefined) throw new Error(`Unknown planning thread: ${id}`);
    return row;
  }

  public latestPlanningThread(): PlanningThread | null {
    const row = this.#database.prepare(`SELECT id, provider, provider_session_id AS providerSessionId,
      status, created_at AS createdAt, updated_at AS updatedAt FROM planning_threads ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get() as PlanningThread | undefined;
    return row ?? null;
  }

  public appendPlanningMessage(
    threadId: string,
    role: PlanningMessage["role"],
    content: string,
    createdAt = new Date().toISOString(),
  ): PlanningMessage {
    this.getPlanningThread(threadId);
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM planning_messages WHERE thread_id = ?")
        .get(threadId) as { sequence: number };
      const result = this.#database.prepare(`INSERT INTO planning_messages
        (thread_id, sequence, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(threadId, row.sequence, role, content, createdAt);
      return Number(result.lastInsertRowid);
    });
    const id = transaction();
    return this.planningMessages(threadId).find((message) => message.id === id) as PlanningMessage;
  }

  public planningMessages(threadId: string): PlanningMessage[] {
    return this.#database.prepare(`SELECT id, thread_id AS threadId, sequence, role, content,
      created_at AS createdAt FROM planning_messages WHERE thread_id = ? ORDER BY sequence`)
      .all(threadId) as PlanningMessage[];
  }

  public setProjectSetting(key: string, value: unknown, now = new Date().toISOString()): void {
    this.#database.prepare(`INSERT INTO project_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(value), now);
  }

  public projectSettings(): Readonly<Record<string, unknown>> {
    const rows = this.#database.prepare("SELECT key, value_json FROM project_settings ORDER BY key").all() as {
      key: string;
      value_json: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
  }

  public createIntegrationAttempt(input: CreateIntegrationAttempt): IntegrationAttempt {
    const ticket = this.get(input.ticketId);
    if (ticket.status !== "READY_TO_MERGE") {
      throw new Error(`Ticket ${ticket.id} is ${ticket.status}, not READY_TO_MERGE`);
    }
    const now = input.now ?? new Date().toISOString();
    this.#database.prepare(`INSERT INTO integration_attempts (
      id, ticket_id, mode, status, original_base_commit, ticket_head, started_at, updated_at
    ) VALUES (?, ?, ?, 'PREPARING', ?, ?, ?, ?)`).run(
      input.id,
      input.ticketId,
      input.mode,
      input.originalBaseCommit,
      input.ticketHead,
      now,
      now,
    );
    return this.getIntegrationAttempt(input.id);
  }

  public getIntegrationAttempt(id: string): IntegrationAttempt {
    const row = this.#database.prepare("SELECT * FROM integration_attempts WHERE id = ?").get(id) as
      | IntegrationAttemptRow
      | undefined;
    if (row === undefined) throw new Error(`Unknown integration attempt: ${id}`);
    return integrationAttemptFromRow(row);
  }

  public listIntegrationAttempts(ticketId?: string): IntegrationAttempt[] {
    const rows = ticketId === undefined
      ? this.#database.prepare("SELECT * FROM integration_attempts ORDER BY started_at, id").all()
      : this.#database.prepare(
          "SELECT * FROM integration_attempts WHERE ticket_id = ? ORDER BY started_at, id",
        ).all(ticketId);
    return (rows as IntegrationAttemptRow[]).map(integrationAttemptFromRow);
  }

  public latestIntegrationAttempt(ticketId: string): IntegrationAttempt | null {
    const row = this.#database.prepare(
      "SELECT * FROM integration_attempts WHERE ticket_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get(ticketId) as IntegrationAttemptRow | undefined;
    return row === undefined ? null : integrationAttemptFromRow(row);
  }

  public updateIntegrationAttempt(
    id: string,
    patch: IntegrationAttemptUpdate,
    now = new Date().toISOString(),
  ): IntegrationAttempt {
    const current = this.getIntegrationAttempt(id);
    this.#database.prepare(`UPDATE integration_attempts SET
      status = @status,
      observed_base_head = @observedBaseHead,
      ticket_head = @ticketHead,
      target_commit = @targetCommit,
      reconciliation_workspace = @reconciliationWorkspace,
      base_moved = @baseMoved,
      verification_status = @verificationStatus,
      verification_commands_json = @verificationCommandsJson,
      verification_output = @verificationOutput,
      diagnostic_code = @diagnosticCode,
      diagnostic_detail = @diagnosticDetail,
      confirmed_at = @confirmedAt,
      updated_at = @updatedAt,
      completed_at = @completedAt
      WHERE id = @id`).run({
        id,
        status: patch.status ?? current.status,
        observedBaseHead: patch.observedBaseHead ?? current.observedBaseHead,
        ticketHead: patch.ticketHead ?? current.ticketHead,
        targetCommit: patch.targetCommit ?? current.targetCommit,
        reconciliationWorkspace: patch.reconciliationWorkspace ?? current.reconciliationWorkspace,
        baseMoved: (patch.baseMoved ?? current.baseMoved) ? 1 : 0,
        verificationStatus: patch.verificationStatus ?? current.verificationStatus,
        verificationCommandsJson: JSON.stringify(patch.verificationCommands ?? current.verificationCommands),
        verificationOutput: patch.verificationOutput ?? current.verificationOutput,
        diagnosticCode: patch.diagnosticCode ?? current.diagnosticCode,
        diagnosticDetail: patch.diagnosticDetail ?? current.diagnosticDetail,
        confirmedAt: patch.confirmedAt ?? current.confirmedAt,
        updatedAt: now,
        completedAt: patch.completedAt ?? current.completedAt,
      });
    return this.getIntegrationAttempt(id);
  }

  public blockIntegration(
    attemptId: string,
    diagnosticCode: string,
    diagnosticDetail: string,
    now = new Date().toISOString(),
  ): Ticket {
    const attempt = this.getIntegrationAttempt(attemptId);
    const current = this.get(attempt.ticketId);
    const next = blockTicket(current, now);
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare("UPDATE tickets SET status = ?, blocked_from = ?, updated_at = ? WHERE id = ?")
        .run(next.status, next.blockedFrom, next.updatedAt, next.id);
      this.#recordHistory(next.id, current.status, next.status, diagnosticCode, now);
      this.#database.prepare(`UPDATE integration_attempts SET status = 'BLOCKED', diagnostic_code = ?,
        diagnostic_detail = ?, updated_at = ?, completed_at = ? WHERE id = ?`)
        .run(diagnosticCode, diagnosticDetail, now, now, attemptId);
    });
    transaction();
    return this.get(attempt.ticketId);
  }

  public completeIntegration(attemptId: string, now = new Date().toISOString()): Ticket {
    const attempt = this.getIntegrationAttempt(attemptId);
    if (attempt.status !== "APPLYING") throw new Error(`Integration attempt ${attemptId} is ${attempt.status}, not APPLYING`);
    const current = this.get(attempt.ticketId);
    if (current.status !== "READY_TO_MERGE") {
      throw new Error(`Ticket ${current.id} is ${current.status}, not READY_TO_MERGE`);
    }
    const transaction = this.#database.transaction(() => {
      this.#writeIntegratedTicket(current, "git_integration_completed", now);
      this.#database.prepare(`UPDATE integration_attempts SET status = 'INTEGRATED', diagnostic_code = NULL,
        diagnostic_detail = NULL, updated_at = ?, completed_at = ? WHERE id = ?`).run(now, now, attemptId);
      this.#promoteReadyTickets(now);
    });
    transaction();
    return this.get(attempt.ticketId);
  }

  public recoverCompletedIntegration(attemptId: string, now = new Date().toISOString()): Ticket {
    const attempt = this.getIntegrationAttempt(attemptId);
    if (attempt.status !== "APPLYING" && attempt.status !== "INTEGRATED") {
      throw new Error(`Integration attempt ${attemptId} cannot be recovered from ${attempt.status}`);
    }
    const current = this.get(attempt.ticketId);
    if (current.status !== "INTERRUPTED") {
      throw new Error(`Ticket ${current.id} is ${current.status}, not INTERRUPTED`);
    }
    const transaction = this.#database.transaction(() => {
      this.#writeIntegratedTicket(current, "bootstrap_git_integration_recovered", now);
      this.#database.prepare(`UPDATE integration_attempts SET status = 'INTEGRATED', diagnostic_code = NULL,
        diagnostic_detail = NULL, updated_at = ?, completed_at = ? WHERE id = ?`).run(now, now, attemptId);
      this.#promoteReadyTickets(now);
    });
    transaction();
    return this.get(attempt.ticketId);
  }

  public interruptIntegrationAttempt(attemptId: string, now = new Date().toISOString()): IntegrationAttempt {
    const attempt = this.getIntegrationAttempt(attemptId);
    if (attempt.status === "INTEGRATED" || attempt.status === "BLOCKED" || attempt.status === "INTERRUPTED") {
      return attempt;
    }
    return this.updateIntegrationAttempt(attemptId, {
      status: "INTERRUPTED",
      diagnosticCode: "bootstrap_uncontrolled_shutdown",
      diagnosticDetail: "The integration did not have sufficient Git evidence to be completed during recovery.",
      completedAt: now,
    }, now);
  }

  public appliedMigrations(): { version: number; name: string }[] {
    return this.#database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
  }

  #persistTransition(current: Ticket, next: Ticket, reason: string): void {
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare("UPDATE tickets SET status = ?, blocked_from = ?, updated_at = ? WHERE id = ?")
        .run(next.status, next.blockedFrom, next.updatedAt, next.id);
      this.#recordHistory(next.id, current.status, next.status, reason, next.updatedAt);
    });
    transaction();
  }

  #writeIntegratedTicket(current: Ticket, reason: string, now: string): void {
    this.#database
      .prepare("UPDATE tickets SET status = 'DONE', blocked_from = NULL, updated_at = ? WHERE id = ?")
      .run(now, current.id);
    this.#recordHistory(current.id, current.status, "DONE", reason, now);
  }

  #promoteReadyTickets(now: string): void {
    const rows = this.#database.prepare(`SELECT t.* FROM tickets t
      WHERE t.status = 'QUEUED'
      AND NOT EXISTS (
        SELECT 1 FROM ticket_dependencies d
        JOIN tickets predecessor ON predecessor.id = d.predecessor_id
        WHERE d.ticket_id = t.id AND predecessor.status <> 'DONE'
      )
      ORDER BY t.created_at, t.id`).all() as TicketRow[];
    for (const row of rows) {
      this.#database
        .prepare("UPDATE tickets SET status = 'READY', blocked_from = NULL, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.#recordHistory(row.id, "QUEUED", "READY", "dependencies_reconciled_after_integration", now);
    }
  }

  #recordHistory(
    ticketId: string,
    fromStatus: TicketStatus | null,
    toStatus: TicketStatus,
    reason: string,
    createdAt: string,
  ): void {
    this.#database
      .prepare(`INSERT INTO ticket_history (ticket_id, from_status, to_status, reason, created_at)
        VALUES (?, ?, ?, ?, ?)`)
      .run(ticketId, fromStatus, toStatus, reason, createdAt);
  }
}

function fromRow(row: TicketRow): Ticket {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    blockedFrom: row.blocked_from,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function integrationAttemptFromRow(row: IntegrationAttemptRow): IntegrationAttempt {
  const commands: unknown = JSON.parse(row.verification_commands_json);
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
    throw new Error(`Invalid verification command journal for integration attempt ${row.id}`);
  }
  return {
    id: row.id,
    ticketId: row.ticket_id,
    mode: row.mode,
    status: row.status,
    originalBaseCommit: row.original_base_commit,
    observedBaseHead: row.observed_base_head,
    ticketHead: row.ticket_head,
    targetCommit: row.target_commit,
    reconciliationWorkspace: row.reconciliation_workspace,
    baseMoved: row.base_moved === 1,
    verificationStatus: row.verification_status,
    verificationCommands: commands as string[],
    verificationOutput: row.verification_output,
    diagnosticCode: row.diagnostic_code,
    diagnosticDetail: row.diagnostic_detail,
    confirmedAt: row.confirmed_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function parseStringArray(json: string, label: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid string array persisted for ${label}`);
  }
  return value as string[];
}

function planningArtifactFromRow(row: PlanningArtifactRow): PlanningArtifact {
  return {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    content: JSON.parse(row.content_json) as unknown,
    predecessorArtifactId: row.predecessor_artifact_id,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}
