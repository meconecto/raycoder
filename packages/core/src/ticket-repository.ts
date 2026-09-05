import SqliteDatabase from "./sqlite.js";
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
import type { AgentEvent } from "./agent-adapter.js";

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
  planning_artifact_id: string | null;
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

export type WorkspacePreparationPurpose = "dispatch" | "integration";
export type WorkspacePreparationStatus =
  | "AWAITING_APPROVAL"
  | "QUEUED"
  | "PREPARING"
  | "PREPARED"
  | "NOT_APPLICABLE"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

interface WorkspacePreparationAttemptRow {
  id: string;
  ticket_id: string;
  integration_attempt_id: string | null;
  purpose: WorkspacePreparationPurpose;
  status: WorkspacePreparationStatus;
  strategy: string;
  fingerprint: string;
  plan_json: string;
  approval_json: string | null;
  workspace: string;
  base_commit: string;
  resumed_from_attempt_id: string | null;
  process_json: string | null;
  output: string | null;
  diagnostic_code: string | null;
  diagnostic_detail: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type WorkspaceVerificationPurpose = "dispatch" | "integration";
export type WorkspaceVerificationStatus =
  | "AWAITING_APPROVAL"
  | "QUEUED"
  | "VERIFYING"
  | "PASSED"
  | "FAILED"
  | "UNAVAILABLE"
  | "CANCELLED"
  | "INTERRUPTED";

interface WorkspaceVerificationAttemptRow {
  id: string;
  ticket_id: string;
  integration_attempt_id: string | null;
  purpose: WorkspaceVerificationPurpose;
  status: WorkspaceVerificationStatus;
  strategy: string;
  fingerprint: string;
  plan_json: string;
  approval_json: string | null;
  workspace: string;
  target_commit: string;
  resumed_from_attempt_id: string | null;
  process_json: string | null;
  output: string | null;
  diagnostic_code: string | null;
  diagnostic_detail: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type AutoRunStatus = "RUNNING" | "PAUSED" | "STOPPED" | "COMPLETED";
export type AutoRunEventType =
  | "STARTED"
  | "TICKET_STARTED"
  | "TICKET_FINISHED"
  | "PAUSED"
  | "RESUMED"
  | "STOPPED"
  | "COMPLETED";

interface AutoRunRow {
  id: string;
  status: AutoRunStatus;
  active_slot: number | null;
  dirty_policy: "cancel" | "committed-head";
  current_ticket_id: string | null;
  reason_code: string | null;
  reason_detail: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface AutoRunEventRow {
  id: number;
  run_id: string;
  sequence: number;
  type: AutoRunEventType;
  ticket_id: string | null;
  reason_code: string | null;
  detail: string | null;
  created_at: string;
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
export type PlanningAuthorRole = "user" | "assistant" | "system";
export type PlanningThreadStatus = "idle" | "running" | "interrupted" | "error";
export type PlanningSessionStage = "conversation" | "spec" | "tickets";
export type PlanningSessionStatus = "idle" | "running" | "completed" | "cancelled" | "interrupted" | "error";

export interface PlanningArtifact {
  readonly id: string;
  readonly kind: PlanningArtifactKind;
  readonly revision: number;
  readonly content: unknown;
  readonly predecessorArtifactId: string | null;
  readonly replacesArtifactId: string | null;
  readonly status: PlanningArtifactStatus;
  readonly authorRole: PlanningAuthorRole;
  readonly authorId: string | null;
  readonly sourceSessionId: string | null;
  readonly sourceMessageIds: readonly number[];
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly confirmedAt: string | null;
}

interface PlanningArtifactRow {
  id: string;
  kind: PlanningArtifactKind;
  revision: number;
  content_json: string;
  predecessor_artifact_id: string | null;
  replaces_artifact_id: string | null;
  status: PlanningArtifactStatus;
  author_role: PlanningAuthorRole;
  author_id: string | null;
  source_session_id: string | null;
  created_at: string;
  approved_at: string | null;
  confirmed_at: string | null;
}

export interface PlanningThread {
  readonly id: string;
  readonly provider: string;
  readonly providerSessionId: string | null;
  readonly status: PlanningThreadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanningMessage {
  readonly id: number;
  readonly threadId: string;
  readonly sequence: number;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly sessionId: string | null;
  readonly createdAt: string;
}

export interface PlanningSession {
  readonly id: string;
  readonly threadId: string;
  readonly adapterSessionId: string | null;
  readonly provider: string;
  readonly providerSessionId: string | null;
  readonly stage: PlanningSessionStage;
  readonly request: unknown;
  readonly resumedFromSessionId: string | null;
  readonly retryOfSessionId: string | null;
  readonly status: PlanningSessionStatus;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface PlanningSessionRow {
  id: string;
  thread_id: string;
  adapter_session_id: string | null;
  provider: string;
  provider_session_id: string | null;
  stage: PlanningSessionStage;
  request_json: string;
  resumed_from_session_id: string | null;
  retry_of_session_id: string | null;
  status: PlanningSessionStatus;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PlanningEvent {
  readonly id: number;
  readonly sessionId: string;
  readonly sequence: number;
  readonly type: AgentEvent["type"];
  readonly payload: AgentEvent;
  readonly createdAt: string;
}

interface PlanningEventRow {
  id: number;
  session_id: string;
  sequence: number;
  type: AgentEvent["type"];
  payload_json: string;
  created_at: string;
}

export interface PlanningDagConfirmation {
  readonly id: string;
  readonly artifactId: string;
  readonly replacedArtifactId: string | null;
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

export interface WorkspacePreparationAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly integrationAttemptId: string | null;
  readonly purpose: WorkspacePreparationPurpose;
  readonly status: WorkspacePreparationStatus;
  readonly strategy: string;
  readonly fingerprint: string;
  readonly plan: unknown;
  readonly approval: unknown | null;
  readonly workspace: string;
  readonly baseCommit: string;
  readonly resumedFromAttemptId: string | null;
  readonly process: unknown | null;
  readonly output: string | null;
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateWorkspacePreparationAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly integrationAttemptId?: string | null;
  readonly purpose: WorkspacePreparationPurpose;
  readonly status: WorkspacePreparationStatus;
  readonly strategy: string;
  readonly fingerprint: string;
  readonly plan: unknown;
  readonly approval?: unknown | null;
  readonly workspace: string;
  readonly baseCommit: string;
  readonly resumedFromAttemptId?: string | null;
  readonly now?: string;
}

export interface WorkspaceVerificationAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly integrationAttemptId: string | null;
  readonly purpose: WorkspaceVerificationPurpose;
  readonly status: WorkspaceVerificationStatus;
  readonly strategy: string;
  readonly fingerprint: string;
  readonly plan: unknown;
  readonly approval: unknown | null;
  readonly workspace: string;
  readonly targetCommit: string;
  readonly resumedFromAttemptId: string | null;
  readonly process: unknown | null;
  readonly output: string | null;
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateWorkspaceVerificationAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly integrationAttemptId?: string | null;
  readonly purpose: WorkspaceVerificationPurpose;
  readonly status: WorkspaceVerificationStatus;
  readonly strategy: string;
  readonly fingerprint: string;
  readonly plan: unknown;
  readonly approval?: unknown | null;
  readonly workspace: string;
  readonly targetCommit: string;
  readonly resumedFromAttemptId?: string | null;
  readonly now?: string;
}

export interface AutoRun {
  readonly id: string;
  readonly status: AutoRunStatus;
  readonly dirtyPolicy: "cancel" | "committed-head";
  readonly currentTicketId: string | null;
  readonly reasonCode: string | null;
  readonly reasonDetail: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AutoRunEvent {
  readonly id: number;
  readonly runId: string;
  readonly sequence: number;
  readonly type: AutoRunEventType;
  readonly ticketId: string | null;
  readonly reasonCode: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
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
  readonly #database: SqliteDatabase;

  public constructor(path: string) {
    this.#database = new SqliteDatabase(path);
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

  public ticketPlanningArtifactId(ticketId: string): string | null {
    const row = this.#database.prepare(
      "SELECT planning_artifact_id AS planningArtifactId FROM tickets WHERE id = ?",
    ).get(ticketId) as { planningArtifactId: string | null } | undefined;
    if (row === undefined) throw new UnknownTicketError(ticketId);
    return row.planningArtifactId;
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
    replacesArtifactId?: string;
    authorRole?: PlanningAuthorRole;
    authorId?: string;
    sourceSessionId?: string;
    sourceMessageIds?: readonly number[];
    createdAt?: string;
  }): PlanningArtifact {
    if (input.predecessorArtifactId !== undefined) this.getPlanningArtifact(input.predecessorArtifactId);
    if (input.replacesArtifactId !== undefined) {
      const replaced = this.getPlanningArtifact(input.replacesArtifactId);
      if (replaced.kind !== input.kind) throw new Error(`Cannot replace ${replaced.kind} with ${input.kind}`);
    }
    if (input.sourceSessionId !== undefined) this.getPlanningSession(input.sourceSessionId);
    const sourceMessageIds = [...new Set(input.sourceMessageIds ?? [])];
    for (const messageId of sourceMessageIds) {
      const message = this.#database.prepare("SELECT id FROM planning_messages WHERE id = ?").get(messageId);
      if (message === undefined) throw new Error(`Unknown planning message: ${messageId}`);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM planning_artifacts WHERE kind = ?")
        .get(input.kind) as { revision: number };
      this.#database.prepare(`INSERT INTO planning_artifacts (
        id, kind, revision, content_json, predecessor_artifact_id, replaces_artifact_id,
        status, author_role, author_id, source_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(
        input.id,
        input.kind,
        row.revision + 1,
        JSON.stringify(input.content),
        input.predecessorArtifactId ?? null,
        input.replacesArtifactId ?? null,
        input.authorRole ?? "system",
        input.authorId ?? null,
        input.sourceSessionId ?? null,
        createdAt,
      );
      const insertSource = this.#database.prepare(
        "INSERT INTO planning_artifact_sources (artifact_id, message_id) VALUES (?, ?)",
      );
      for (const messageId of sourceMessageIds) insertSource.run(input.id, messageId);
    });
    transaction();
    return this.getPlanningArtifact(input.id);
  }

  public getPlanningArtifact(id: string): PlanningArtifact {
    const row = this.#database.prepare("SELECT * FROM planning_artifacts WHERE id = ?").get(id) as PlanningArtifactRow | undefined;
    if (row === undefined) throw new Error(`Unknown planning artifact: ${id}`);
    return planningArtifactFromRow(row, this.planningArtifactSourceMessageIds(id));
  }

  public listPlanningArtifacts(kind?: PlanningArtifactKind): PlanningArtifact[] {
    const rows = kind === undefined
      ? this.#database.prepare("SELECT * FROM planning_artifacts ORDER BY created_at, rowid").all()
      : this.#database.prepare("SELECT * FROM planning_artifacts WHERE kind = ? ORDER BY revision").all(kind);
    return (rows as PlanningArtifactRow[]).map((row) => planningArtifactFromRow(
      row,
      this.planningArtifactSourceMessageIds(row.id),
    ));
  }

  public latestApprovedPlanningArtifact(kind: PlanningArtifactKind): PlanningArtifact | null {
    const row = this.#database.prepare(
      "SELECT * FROM planning_artifacts WHERE kind = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1",
    ).get(kind) as PlanningArtifactRow | undefined;
    return row === undefined ? null : planningArtifactFromRow(row, this.planningArtifactSourceMessageIds(row.id));
  }

  public planningArtifactSourceMessageIds(artifactId: string): number[] {
    return (this.#database.prepare(
      "SELECT message_id AS messageId FROM planning_artifact_sources WHERE artifact_id = ? ORDER BY message_id",
    ).all(artifactId) as { messageId: number }[]).map((row) => row.messageId);
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
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, provider_session_id = excluded.provider_session_id,
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
    sessionId: string | null = null,
  ): PlanningMessage {
    this.getPlanningThread(threadId);
    if (sessionId !== null) this.getPlanningSession(sessionId);
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM planning_messages WHERE thread_id = ?")
        .get(threadId) as { sequence: number };
      const result = this.#database.prepare(`INSERT INTO planning_messages
        (thread_id, sequence, role, content, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(threadId, row.sequence, role, content, createdAt, sessionId);
      return Number(result.lastInsertRowid);
    });
    const id = transaction();
    return this.planningMessages(threadId).find((message) => message.id === id) as PlanningMessage;
  }

  public planningMessages(threadId: string): PlanningMessage[] {
    return this.#database.prepare(`SELECT id, thread_id AS threadId, sequence, role, content,
      session_id AS sessionId, created_at AS createdAt FROM planning_messages WHERE thread_id = ? ORDER BY sequence`)
      .all(threadId) as PlanningMessage[];
  }

  public createPlanningSession(input: {
    id: string;
    threadId: string;
    provider: string;
    stage: PlanningSessionStage;
    request: unknown;
    resumedFromSessionId?: string;
    retryOfSessionId?: string;
    createdAt?: string;
  }): PlanningSession {
    this.getPlanningThread(input.threadId);
    if (input.resumedFromSessionId !== undefined) this.getPlanningSession(input.resumedFromSessionId);
    if (input.retryOfSessionId !== undefined) this.getPlanningSession(input.retryOfSessionId);
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#database.prepare(`INSERT INTO planning_sessions (
      id, thread_id, provider, stage, request_json, resumed_from_session_id, retry_of_session_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`).run(
      input.id,
      input.threadId,
      input.provider,
      input.stage,
      JSON.stringify(input.request),
      input.resumedFromSessionId ?? null,
      input.retryOfSessionId ?? null,
      createdAt,
      createdAt,
    );
    return this.getPlanningSession(input.id);
  }

  public getPlanningSession(id: string): PlanningSession {
    const row = this.#database.prepare("SELECT * FROM planning_sessions WHERE id = ?").get(id) as PlanningSessionRow | undefined;
    if (row === undefined) throw new Error(`Unknown planning session: ${id}`);
    return planningSessionFromRow(row);
  }

  public listPlanningSessions(threadId?: string): PlanningSession[] {
    const rows = threadId === undefined
      ? this.#database.prepare("SELECT * FROM planning_sessions ORDER BY created_at, rowid").all()
      : this.#database.prepare("SELECT * FROM planning_sessions WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId);
    return (rows as PlanningSessionRow[]).map(planningSessionFromRow);
  }

  public latestPlanningSession(stage?: PlanningSessionStage): PlanningSession | null {
    const row = stage === undefined
      ? this.#database.prepare("SELECT * FROM planning_sessions ORDER BY created_at DESC, rowid DESC LIMIT 1").get()
      : this.#database.prepare(
          "SELECT * FROM planning_sessions WHERE stage = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ).get(stage);
    return row === undefined ? null : planningSessionFromRow(row as PlanningSessionRow);
  }

  public updatePlanningSession(
    id: string,
    patch: {
      adapterSessionId?: string | null;
      providerSessionId?: string | null;
      status?: PlanningSessionStatus;
      errorCode?: string | null;
      errorDetail?: string | null;
      completedAt?: string | null;
    },
    now = new Date().toISOString(),
  ): PlanningSession {
    const current = this.getPlanningSession(id);
    this.#database.prepare(`UPDATE planning_sessions SET
      adapter_session_id = ?, provider_session_id = ?, status = ?, error_code = ?, error_detail = ?,
      updated_at = ?, completed_at = ? WHERE id = ?`).run(
      patch.adapterSessionId === undefined ? current.adapterSessionId : patch.adapterSessionId,
      patch.providerSessionId === undefined ? current.providerSessionId : patch.providerSessionId,
      patch.status ?? current.status,
      patch.errorCode === undefined ? current.errorCode : patch.errorCode,
      patch.errorDetail === undefined ? current.errorDetail : patch.errorDetail,
      now,
      patch.completedAt === undefined ? current.completedAt : patch.completedAt,
      id,
    );
    return this.getPlanningSession(id);
  }

  public appendPlanningEvent(sessionId: string, event: AgentEvent): PlanningEvent {
    this.getPlanningSession(sessionId);
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM planning_events WHERE session_id = ?",
      ).get(sessionId) as { sequence: number };
      const result = this.#database.prepare(`INSERT INTO planning_events
        (session_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(sessionId, row.sequence, event.type, JSON.stringify(event), event.timestamp);
      return Number(result.lastInsertRowid);
    });
    const id = transaction();
    return this.planningEvents(sessionId).find((event) => event.id === id) as PlanningEvent;
  }

  public planningEvents(sessionId: string): PlanningEvent[] {
    return (this.#database.prepare(
      "SELECT * FROM planning_events WHERE session_id = ? ORDER BY sequence",
    ).all(sessionId) as PlanningEventRow[]).map(planningEventFromRow);
  }

  public interruptPlanningSessions(now = new Date().toISOString()): PlanningSession[] {
    const uncertain = this.listPlanningSessions().filter((session) => session.status === "idle" || session.status === "running");
    if (uncertain.length === 0) return [];
    const transaction = this.#database.transaction(() => {
      for (const session of uncertain) {
        this.#database.prepare(`UPDATE planning_sessions SET status = 'interrupted', error_code = ?,
          error_detail = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
            "planning.bootstrap_interrupted",
            "raycoder restarted before this planning operation reached a durable terminal state.",
            now,
            now,
            session.id,
          );
      }
      const threadIds = new Set(uncertain.map((session) => session.threadId));
      for (const threadId of threadIds) {
        this.#database.prepare("UPDATE planning_threads SET status = 'interrupted', updated_at = ? WHERE id = ?")
          .run(now, threadId);
      }
    });
    transaction();
    return uncertain.map((session) => this.getPlanningSession(session.id));
  }

  public latestPlanningDagConfirmation(): PlanningDagConfirmation | null {
    const row = this.#database.prepare(`SELECT id, artifact_id AS artifactId,
      replaced_artifact_id AS replacedArtifactId, created_at AS createdAt
      FROM planning_dag_confirmations ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as PlanningDagConfirmation | undefined;
    return row ?? null;
  }

  public confirmPlanningDag(input: {
    confirmationId: string;
    artifactId: string;
    entries: readonly { ticket: Ticket; predecessorIds: readonly string[] }[];
    now?: string;
  }): { tickets: Ticket[]; confirmation: PlanningDagConfirmation } {
    const artifact = this.getPlanningArtifact(input.artifactId);
    if (artifact.kind !== "tickets" || artifact.status !== "approved") {
      throw new Error(`Planning artifact ${artifact.id} is not an approved ticket plan`);
    }
    const currentApproved = this.latestApprovedPlanningArtifact("tickets");
    if (currentApproved?.id !== artifact.id) throw new Error(`Planning artifact ${artifact.id} is not the current approved ticket plan`);
    const previous = this.latestPlanningDagConfirmation();
    if (artifact.confirmedAt !== null && previous?.artifactId === artifact.id) {
      const tickets = (this.#database.prepare(
        "SELECT * FROM tickets WHERE planning_artifact_id = ? ORDER BY created_at, id",
      ).all(artifact.id) as TicketRow[]).map(fromRow);
      return { tickets, confirmation: previous };
    }

    const replacedArtifactId = previous?.artifactId ?? null;
    const replacedRows = replacedArtifactId === null
      ? []
      : this.#database.prepare("SELECT * FROM tickets WHERE planning_artifact_id = ? ORDER BY created_at, id")
          .all(replacedArtifactId) as TicketRow[];
    if (replacedRows.some((ticket) => ticket.status !== "READY" && ticket.status !== "QUEUED")) {
      throw new Error("The previously confirmed DAG has started and cannot be replaced");
    }
    const replacedIds = new Set(replacedRows.map((ticket) => ticket.id));
    const existingEdges = this.dependencies();
    if (existingEdges.some((edge) => !replacedIds.has(edge.ticketId) && replacedIds.has(edge.predecessorId))) {
      throw new Error("Tickets outside the previous plan depend on it, so the DAG cannot be replaced");
    }
    const retained = this.list().filter((ticket) => !replacedIds.has(ticket.id));
    const newIds = input.entries.map((entry) => entry.ticket.id);
    if (new Set(newIds).size !== newIds.length || newIds.some((id) => retained.some((ticket) => ticket.id === id))) {
      throw new Error("Ticket plan contains duplicate or existing ticket ids");
    }
    const retainedEdges = existingEdges.filter(
      (edge) => !replacedIds.has(edge.ticketId) && !replacedIds.has(edge.predecessorId),
    );
    const newEdges = input.entries.flatMap((entry) => [...new Set(entry.predecessorIds)].map((predecessorId) => ({
      ticketId: entry.ticket.id,
      predecessorId,
    })));
    assertAcyclic(
      [...retained.map((ticket) => ticket.id), ...newIds],
      [...retainedEdges, ...newEdges],
    );

    const now = input.now ?? new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      if (replacedArtifactId !== null) {
        this.#database.prepare(`DELETE FROM ticket_dependencies WHERE ticket_id IN (
          SELECT id FROM tickets WHERE planning_artifact_id = ?
        )`).run(replacedArtifactId);
        this.#database.prepare("DELETE FROM tickets WHERE planning_artifact_id = ?").run(replacedArtifactId);
      }
      const insertTicket = this.#database.prepare(`INSERT INTO tickets (
        id, title, description, status, blocked_from, branch, base_branch, base_commit, workspace,
        created_at, updated_at, planning_artifact_id
      ) VALUES (@id, @title, @description, @status, @blockedFrom, @branch, @baseBranch, @baseCommit,
        @workspace, @createdAt, @updatedAt, @planningArtifactId)`);
      for (const entry of input.entries) insertTicket.run({ ...entry.ticket, planningArtifactId: artifact.id });
      const insertEdge = this.#database.prepare(
        "INSERT INTO ticket_dependencies (ticket_id, predecessor_id) VALUES (?, ?)",
      );
      for (const edge of newEdges) insertEdge.run(edge.ticketId, edge.predecessorId);
      for (const entry of input.entries) {
        this.#recordHistory(entry.ticket.id, null, entry.ticket.status, "created_from_confirmed_plan", entry.ticket.createdAt);
      }
      this.#database.prepare(`INSERT INTO planning_dag_confirmations
        (id, artifact_id, replaced_artifact_id, created_at) VALUES (?, ?, ?, ?)`)
        .run(input.confirmationId, artifact.id, replacedArtifactId, now);
      this.#database.prepare("UPDATE planning_artifacts SET confirmed_at = ? WHERE id = ?").run(now, artifact.id);
      this.#promoteReadyTickets(now);
    });
    transaction();
    return {
      tickets: input.entries.map((entry) => this.get(entry.ticket.id)),
      confirmation: this.latestPlanningDagConfirmation() as PlanningDagConfirmation,
    };
  }

  public createWorkspacePreparationAttempt(input: CreateWorkspacePreparationAttempt): WorkspacePreparationAttempt {
    this.get(input.ticketId);
    const now = input.now ?? new Date().toISOString();
    this.#database.prepare(`INSERT INTO workspace_preparation_attempts (
      id, ticket_id, integration_attempt_id, purpose, status, strategy, fingerprint, plan_json,
      approval_json, workspace, base_commit, resumed_from_attempt_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.id,
        input.ticketId,
        input.integrationAttemptId ?? null,
        input.purpose,
        input.status,
        input.strategy,
        input.fingerprint,
        JSON.stringify(input.plan),
        input.approval === undefined || input.approval === null ? null : JSON.stringify(input.approval),
        input.workspace,
        input.baseCommit,
        input.resumedFromAttemptId ?? null,
        now,
        now,
      );
    return this.getWorkspacePreparationAttempt(input.id);
  }

  public getWorkspacePreparationAttempt(id: string): WorkspacePreparationAttempt {
    const row = this.#database.prepare("SELECT * FROM workspace_preparation_attempts WHERE id = ?")
      .get(id) as WorkspacePreparationAttemptRow | undefined;
    if (row === undefined) throw new Error(`Unknown workspace preparation attempt: ${id}`);
    return workspacePreparationAttemptFromRow(row);
  }

  public listWorkspacePreparationAttempts(ticketId?: string): WorkspacePreparationAttempt[] {
    const rows = ticketId === undefined
      ? this.#database.prepare("SELECT * FROM workspace_preparation_attempts ORDER BY created_at, rowid").all()
      : this.#database.prepare(
          "SELECT * FROM workspace_preparation_attempts WHERE ticket_id = ? ORDER BY created_at, rowid",
        ).all(ticketId);
    return (rows as WorkspacePreparationAttemptRow[]).map(workspacePreparationAttemptFromRow);
  }

  public latestWorkspacePreparationAttempt(ticketId: string): WorkspacePreparationAttempt | null {
    const row = this.#database.prepare(
      "SELECT * FROM workspace_preparation_attempts WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(ticketId) as WorkspacePreparationAttemptRow | undefined;
    return row === undefined ? null : workspacePreparationAttemptFromRow(row);
  }

  public updateWorkspacePreparationAttempt(
    id: string,
    patch: {
      status?: WorkspacePreparationStatus;
      approval?: unknown | null;
      process?: unknown | null;
      output?: string | null;
      diagnosticCode?: string | null;
      diagnosticDetail?: string | null;
      completedAt?: string | null;
    },
    now = new Date().toISOString(),
  ): WorkspacePreparationAttempt {
    const current = this.getWorkspacePreparationAttempt(id);
    const value = <T>(next: T | undefined, previous: T): T => next === undefined ? previous : next;
    const approval = value(patch.approval, current.approval);
    const process = value(patch.process, current.process);
    this.#database.prepare(`UPDATE workspace_preparation_attempts SET status = ?, approval_json = ?,
      process_json = ?, output = ?, diagnostic_code = ?, diagnostic_detail = ?, updated_at = ?,
      completed_at = ? WHERE id = ?`).run(
        patch.status ?? current.status,
        approval === null ? null : JSON.stringify(approval),
        process === null ? null : JSON.stringify(process),
        value(patch.output, current.output),
        value(patch.diagnosticCode, current.diagnosticCode),
        value(patch.diagnosticDetail, current.diagnosticDetail),
        now,
        value(patch.completedAt, current.completedAt),
        id,
      );
    return this.getWorkspacePreparationAttempt(id);
  }

  public interruptWorkspacePreparations(now = new Date().toISOString()): WorkspacePreparationAttempt[] {
    const uncertain = this.listWorkspacePreparationAttempts().filter(
      (attempt) => attempt.status === "QUEUED" || attempt.status === "PREPARING",
    );
    const transaction = this.#database.transaction(() => {
      for (const attempt of uncertain) {
        this.#database.prepare(`UPDATE workspace_preparation_attempts SET status = 'INTERRUPTED',
          diagnostic_code = ?, diagnostic_detail = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
            "preparation.bootstrap_interrupted",
            "raycoder restarted before workspace preparation reached a durable terminal state.",
            now,
            now,
            attempt.id,
          );
        const ticket = this.get(attempt.ticketId);
        if (ticket.status === "READY" || ticket.status === "READY_TO_MERGE") {
          const blocked = blockTicket(ticket, now);
          this.#database.prepare("UPDATE tickets SET status = ?, blocked_from = ?, updated_at = ? WHERE id = ?")
            .run(blocked.status, blocked.blockedFrom, blocked.updatedAt, blocked.id);
          this.#recordHistory(ticket.id, ticket.status, "BLOCKED", "workspace_preparation_interrupted", now);
        }
      }
    });
    transaction();
    return uncertain.map((attempt) => this.getWorkspacePreparationAttempt(attempt.id));
  }

  public createWorkspaceVerificationAttempt(input: CreateWorkspaceVerificationAttempt): WorkspaceVerificationAttempt {
    this.get(input.ticketId);
    const now = input.now ?? new Date().toISOString();
    this.#database.prepare(`INSERT INTO workspace_verification_attempts (
      id, ticket_id, integration_attempt_id, purpose, status, strategy, fingerprint, plan_json,
      approval_json, workspace, target_commit, resumed_from_attempt_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id,
      input.ticketId,
      input.integrationAttemptId ?? null,
      input.purpose,
      input.status,
      input.strategy,
      input.fingerprint,
      JSON.stringify(input.plan),
      input.approval === undefined || input.approval === null ? null : JSON.stringify(input.approval),
      input.workspace,
      input.targetCommit,
      input.resumedFromAttemptId ?? null,
      now,
      now,
    );
    return this.getWorkspaceVerificationAttempt(input.id);
  }

  public getWorkspaceVerificationAttempt(id: string): WorkspaceVerificationAttempt {
    const row = this.#database.prepare("SELECT * FROM workspace_verification_attempts WHERE id = ?")
      .get(id) as WorkspaceVerificationAttemptRow | undefined;
    if (row === undefined) throw new Error(`Unknown workspace verification attempt: ${id}`);
    return workspaceVerificationAttemptFromRow(row);
  }

  public listWorkspaceVerificationAttempts(ticketId?: string): WorkspaceVerificationAttempt[] {
    const rows = ticketId === undefined
      ? this.#database.prepare("SELECT * FROM workspace_verification_attempts ORDER BY created_at, rowid").all()
      : this.#database.prepare(
          "SELECT * FROM workspace_verification_attempts WHERE ticket_id = ? ORDER BY created_at, rowid",
        ).all(ticketId);
    return (rows as WorkspaceVerificationAttemptRow[]).map(workspaceVerificationAttemptFromRow);
  }

  public latestWorkspaceVerificationAttempt(
    ticketId: string,
    purpose?: WorkspaceVerificationPurpose,
  ): WorkspaceVerificationAttempt | null {
    const row = purpose === undefined
      ? this.#database.prepare(
          "SELECT * FROM workspace_verification_attempts WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ).get(ticketId)
      : this.#database.prepare(
          "SELECT * FROM workspace_verification_attempts WHERE ticket_id = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ).get(ticketId, purpose);
    return row === undefined ? null : workspaceVerificationAttemptFromRow(row as WorkspaceVerificationAttemptRow);
  }

  public updateWorkspaceVerificationAttempt(
    id: string,
    patch: {
      status?: WorkspaceVerificationStatus;
      approval?: unknown | null;
      process?: unknown | null;
      output?: string | null;
      diagnosticCode?: string | null;
      diagnosticDetail?: string | null;
      completedAt?: string | null;
    },
    now = new Date().toISOString(),
  ): WorkspaceVerificationAttempt {
    const current = this.getWorkspaceVerificationAttempt(id);
    const value = <T>(next: T | undefined, previous: T): T => next === undefined ? previous : next;
    const approval = value(patch.approval, current.approval);
    const process = value(patch.process, current.process);
    this.#database.prepare(`UPDATE workspace_verification_attempts SET status = ?, approval_json = ?,
      process_json = ?, output = ?, diagnostic_code = ?, diagnostic_detail = ?, updated_at = ?,
      completed_at = ? WHERE id = ?`).run(
        patch.status ?? current.status,
        approval === null ? null : JSON.stringify(approval),
        process === null ? null : JSON.stringify(process),
        value(patch.output, current.output),
        value(patch.diagnosticCode, current.diagnosticCode),
        value(patch.diagnosticDetail, current.diagnosticDetail),
        now,
        value(patch.completedAt, current.completedAt),
        id,
      );
    return this.getWorkspaceVerificationAttempt(id);
  }

  public interruptWorkspaceVerifications(now = new Date().toISOString()): WorkspaceVerificationAttempt[] {
    const uncertain = this.listWorkspaceVerificationAttempts().filter(
      (attempt) => attempt.status === "QUEUED" || attempt.status === "VERIFYING",
    );
    const transaction = this.#database.transaction(() => {
      for (const attempt of uncertain) {
        this.#database.prepare(`UPDATE workspace_verification_attempts SET status = 'INTERRUPTED',
          diagnostic_code = ?, diagnostic_detail = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
            "verification.bootstrap_interrupted",
            "raycoder restarted before workspace verification reached a durable terminal state.",
            now,
            now,
            attempt.id,
          );
        const ticket = this.get(attempt.ticketId);
        if (["READY", "RUNNING", "REVIEW", "READY_TO_MERGE"].includes(ticket.status)) {
          const blocked = blockTicket(ticket, now);
          this.#database.prepare("UPDATE tickets SET status = ?, blocked_from = ?, updated_at = ? WHERE id = ?")
            .run(blocked.status, blocked.blockedFrom, blocked.updatedAt, blocked.id);
          this.#recordHistory(ticket.id, ticket.status, "BLOCKED", "workspace_verification_interrupted", now);
        }
      }
    });
    transaction();
    return uncertain.map((attempt) => this.getWorkspaceVerificationAttempt(attempt.id));
  }

  public createAutoRun(input: {
    id: string;
    dirtyPolicy: "cancel" | "committed-head";
    now?: string;
  }): AutoRun {
    const now = input.now ?? new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO auto_runs (
        id, status, active_slot, dirty_policy, started_at, updated_at
      ) VALUES (?, 'RUNNING', 1, ?, ?, ?)`).run(input.id, input.dirtyPolicy, now, now);
      this.#insertAutoRunEvent(input.id, "STARTED", null, "user_started", null, now);
      this.#writeAutoRunEnabled(true, now);
    });
    transaction();
    return this.getAutoRun(input.id);
  }

  public getAutoRun(id: string): AutoRun {
    const row = this.#database.prepare("SELECT * FROM auto_runs WHERE id = ?").get(id) as AutoRunRow | undefined;
    if (row === undefined) throw new Error(`Unknown auto run: ${id}`);
    return autoRunFromRow(row);
  }

  public listAutoRuns(): AutoRun[] {
    return (this.#database.prepare("SELECT * FROM auto_runs ORDER BY started_at, rowid").all() as AutoRunRow[])
      .map(autoRunFromRow);
  }

  public latestAutoRun(): AutoRun | null {
    const row = this.#database.prepare("SELECT * FROM auto_runs ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get() as AutoRunRow | undefined;
    return row === undefined ? null : autoRunFromRow(row);
  }

  public activeAutoRun(): AutoRun | null {
    const row = this.#database.prepare("SELECT * FROM auto_runs WHERE active_slot = 1 LIMIT 1")
      .get() as AutoRunRow | undefined;
    return row === undefined ? null : autoRunFromRow(row);
  }

  public autoRunEvents(runId: string): AutoRunEvent[] {
    this.getAutoRun(runId);
    return (this.#database.prepare("SELECT * FROM auto_run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as AutoRunEventRow[]).map(autoRunEventFromRow);
  }

  public updateAutoRun(
    id: string,
    patch: {
      status?: AutoRunStatus;
      currentTicketId?: string | null;
      reasonCode?: string | null;
      reasonDetail?: string | null;
    },
    event: {
      type: AutoRunEventType;
      ticketId?: string | null;
      reasonCode?: string | null;
      detail?: string | null;
    },
    now = new Date().toISOString(),
  ): AutoRun {
    const transaction = this.#database.transaction(() => {
      const current = this.getAutoRun(id);
      const status = patch.status ?? current.status;
      const terminal = status === "STOPPED" || status === "COMPLETED";
      const value = <T>(next: T | undefined, previous: T): T => next === undefined ? previous : next;
      this.#database.prepare(`UPDATE auto_runs SET status = ?, active_slot = ?, current_ticket_id = ?,
        reason_code = ?, reason_detail = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
          status,
          terminal ? null : 1,
          value(patch.currentTicketId, current.currentTicketId),
          value(patch.reasonCode, current.reasonCode),
          value(patch.reasonDetail, current.reasonDetail),
          now,
          terminal ? now : null,
          id,
        );
      this.#insertAutoRunEvent(
        id,
        event.type,
        event.ticketId ?? null,
        event.reasonCode ?? null,
        event.detail ?? null,
        now,
      );
      if (terminal) this.#writeAutoRunEnabled(false, now);
    });
    transaction();
    return this.getAutoRun(id);
  }

  public recoverAutoRun(now = new Date().toISOString()): AutoRun | null {
    const active = this.activeAutoRun();
    if (active?.status !== "RUNNING") return null;
    return this.updateAutoRun(active.id, {
      status: "PAUSED",
      currentTicketId: null,
      reasonCode: "restart_required",
      reasonDetail: "raycoder restarted while Auto was running. Resume explicitly after reviewing ticket recovery.",
    }, {
      type: "PAUSED",
      ticketId: active.currentTicketId,
      reasonCode: "restart_required",
      detail: "Runtime reopened; Auto was not resumed automatically.",
    }, now);
  }

  public autoRunEnabled(): boolean {
    const value = this.projectSettings()["autoRun"];
    return typeof value === "object" && value !== null && (value as { enabled?: unknown }).enabled === true;
  }

  public setProjectSetting(key: string, value: unknown, now = new Date().toISOString()): void {
    this.#database.prepare(`INSERT INTO project_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(value), now);
  }

  public deleteProjectSetting(key: string): void {
    this.#database.prepare("DELETE FROM project_settings WHERE key = ?").run(key);
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

  #insertAutoRunEvent(
    runId: string,
    type: AutoRunEventType,
    ticketId: string | null,
    reasonCode: string | null,
    detail: string | null,
    createdAt: string,
  ): void {
    const row = this.#database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM auto_run_events WHERE run_id = ?",
    ).get(runId) as { sequence: number };
    this.#database.prepare(`INSERT INTO auto_run_events (
      run_id, sequence, type, ticket_id, reason_code, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(runId, row.sequence, type, ticketId, reasonCode, detail, createdAt);
  }

  #writeAutoRunEnabled(enabled: boolean, now: string): void {
    this.#database.prepare(`INSERT INTO project_settings (key, value_json, updated_at) VALUES ('autoRun', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ enabled }), now);
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

function workspacePreparationAttemptFromRow(row: WorkspacePreparationAttemptRow): WorkspacePreparationAttempt {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    integrationAttemptId: row.integration_attempt_id,
    purpose: row.purpose,
    status: row.status,
    strategy: row.strategy,
    fingerprint: row.fingerprint,
    plan: JSON.parse(row.plan_json) as unknown,
    approval: row.approval_json === null ? null : JSON.parse(row.approval_json) as unknown,
    workspace: row.workspace,
    baseCommit: row.base_commit,
    resumedFromAttemptId: row.resumed_from_attempt_id,
    process: row.process_json === null ? null : JSON.parse(row.process_json) as unknown,
    output: row.output,
    diagnosticCode: row.diagnostic_code,
    diagnosticDetail: row.diagnostic_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function workspaceVerificationAttemptFromRow(row: WorkspaceVerificationAttemptRow): WorkspaceVerificationAttempt {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    integrationAttemptId: row.integration_attempt_id,
    purpose: row.purpose,
    status: row.status,
    strategy: row.strategy,
    fingerprint: row.fingerprint,
    plan: JSON.parse(row.plan_json) as unknown,
    approval: row.approval_json === null ? null : JSON.parse(row.approval_json) as unknown,
    workspace: row.workspace,
    targetCommit: row.target_commit,
    resumedFromAttemptId: row.resumed_from_attempt_id,
    process: row.process_json === null ? null : JSON.parse(row.process_json) as unknown,
    output: row.output,
    diagnosticCode: row.diagnostic_code,
    diagnosticDetail: row.diagnostic_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function autoRunFromRow(row: AutoRunRow): AutoRun {
  return {
    id: row.id,
    status: row.status,
    dirtyPolicy: row.dirty_policy,
    currentTicketId: row.current_ticket_id,
    reasonCode: row.reason_code,
    reasonDetail: row.reason_detail,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function autoRunEventFromRow(row: AutoRunEventRow): AutoRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    ticketId: row.ticket_id,
    reasonCode: row.reason_code,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function parseStringArray(json: string, label: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid string array persisted for ${label}`);
  }
  return value as string[];
}

function planningArtifactFromRow(row: PlanningArtifactRow, sourceMessageIds: readonly number[]): PlanningArtifact {
  return {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    content: JSON.parse(row.content_json) as unknown,
    predecessorArtifactId: row.predecessor_artifact_id,
    replacesArtifactId: row.replaces_artifact_id,
    status: row.status,
    authorRole: row.author_role,
    authorId: row.author_id,
    sourceSessionId: row.source_session_id,
    sourceMessageIds,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    confirmedAt: row.confirmed_at,
  };
}

function planningSessionFromRow(row: PlanningSessionRow): PlanningSession {
  return {
    id: row.id,
    threadId: row.thread_id,
    adapterSessionId: row.adapter_session_id,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    stage: row.stage,
    request: JSON.parse(row.request_json) as unknown,
    resumedFromSessionId: row.resumed_from_session_id,
    retryOfSessionId: row.retry_of_session_id,
    status: row.status,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function planningEventFromRow(row: PlanningEventRow): PlanningEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json) as AgentEvent,
    createdAt: row.created_at,
  };
}
