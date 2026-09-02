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
  type OperationalStatus,
  type Ticket,
  type TicketStatus,
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
  readonly createdAt: string;
  readonly updatedAt: string;
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
      id, ticket_id, provider, provider_session_id, status, created_at, updated_at
    ) VALUES (@id, @ticketId, @provider, @providerSessionId, @status, @createdAt, @updatedAt)`).run(session);
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
