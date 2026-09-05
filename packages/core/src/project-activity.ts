import type { TicketStatus } from "./domain.js";
import type {
  IntegrationAttempt,
  PlanningSession,
  TicketRepository,
  WorkspacePreparationAttempt,
  WorkspaceVerificationAttempt,
} from "./ticket-repository.js";

export type ActivitySeverity = "info" | "warning" | "error";
export type ActivitySource = "planning" | "ticket" | "preparation" | "verification" | "integration";
export type ActivityAction =
  | "retry_planning"
  | "resume_planning"
  | "open_ticket"
  | "approve_preparation"
  | "confirm_integration"
  | "open_settings";

export interface ProjectActivityItem {
  readonly id: string;
  readonly source: ActivitySource;
  readonly severity: ActivitySeverity;
  readonly status: string;
  readonly code: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly ticketId: string | null;
  readonly sessionId: string | null;
  readonly action: ActivityAction | null;
  readonly resolved: boolean;
}

export interface ProjectAttentionSummary {
  readonly count: number;
  readonly highestSeverity: Exclude<ActivitySeverity, "info"> | null;
  readonly latestCode: string | null;
  readonly latestAt: string | null;
}

export interface ProjectActivityPage {
  readonly items: readonly ProjectActivityItem[];
  readonly nextCursor: string | null;
  readonly summary: ProjectAttentionSummary;
}

export class ProjectActivityService {
  readonly #repository: TicketRepository;

  public constructor(repository: TicketRepository) {
    this.#repository = repository;
  }

  public summary(): ProjectAttentionSummary {
    const unresolved = this.#items().filter((item) => !item.resolved && item.severity !== "info");
    const highestSeverity = unresolved.some((item) => item.severity === "error")
      ? "error"
      : unresolved.some((item) => item.severity === "warning") ? "warning" : null;
    return {
      count: unresolved.length,
      highestSeverity,
      latestCode: unresolved[0]?.code ?? null,
      latestAt: unresolved[0]?.occurredAt ?? null,
    };
  }

  public list(input: { before?: string; limit?: number; severity?: ActivitySeverity } = {}): ProjectActivityPage {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const filtered = this.#items().filter((item) => (
      (input.before === undefined || activityCursor(item) < input.before)
      && (input.severity === undefined || item.severity === input.severity)
    ));
    const items = filtered.slice(0, limit);
    return {
      items,
      nextCursor: filtered.length > limit && items.length > 0 ? activityCursor(items.at(-1) as ProjectActivityItem) : null,
      summary: this.summary(),
    };
  }

  #items(): ProjectActivityItem[] {
    const planning = this.#repository.listPlanningSessions();
    const items = [
      ...planning.map((session) => planningItem(session, planning)),
      ...this.#repository.list().flatMap((ticket) => this.#repository.history(ticket.id).map((entry) => ({
        id: `ticket:${entry.id}`,
        source: "ticket" as const,
        severity: ticketSeverity(entry.toStatus),
        status: entry.toStatus,
        code: ticketCode(entry.toStatus),
        title: ticket.title,
        detail: entry.reason,
        occurredAt: entry.createdAt,
        ticketId: ticket.id,
        sessionId: null,
        action: ticketAction(entry.toStatus),
        resolved: ticket.status !== entry.toStatus || !attentionTicketStatuses.has(ticket.status),
      }))),
      ...this.#repository.listWorkspacePreparationAttempts().map((attempt) => preparationItem(
        attempt,
        this.#repository.latestWorkspacePreparationAttempt(attempt.ticketId),
      )),
      ...this.#repository.listWorkspaceVerificationAttempts().map((attempt) => verificationItem(
        attempt,
        this.#repository.latestWorkspaceVerificationAttempt(attempt.ticketId, attempt.purpose),
      )),
      ...this.#repository.listIntegrationAttempts().map((attempt) => integrationItem(
        attempt,
        this.#repository.latestIntegrationAttempt(attempt.ticketId),
      )),
    ];
    return items.sort((left, right) => (
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
    ));
  }
}

function verificationItem(attempt: WorkspaceVerificationAttempt, latest: WorkspaceVerificationAttempt | null): ProjectActivityItem {
  const attention = ["AWAITING_APPROVAL", "FAILED", "UNAVAILABLE", "INTERRUPTED"].includes(attempt.status);
  return {
    id: `verification:${attempt.id}`,
    source: "verification",
    severity: attempt.status === "FAILED" || attempt.status === "UNAVAILABLE" ? "error" : attention ? "warning" : "info",
    status: attempt.status,
    code: attempt.diagnosticCode,
    title: "Workspace verification",
    detail: attempt.diagnosticDetail,
    occurredAt: attempt.completedAt ?? attempt.updatedAt,
    ticketId: attempt.ticketId,
    sessionId: null,
    action: attempt.status === "AWAITING_APPROVAL" ? "open_settings" : attention ? "open_ticket" : null,
    resolved: attention && latest?.id !== attempt.id,
  };
}

const attentionTicketStatuses = new Set<TicketStatus>(["BLOCKED", "FAILED", "INTERRUPTED"]);

function planningItem(session: PlanningSession, sessions: readonly PlanningSession[]): ProjectActivityItem {
  const retry = sessions.filter((candidate) => candidate.retryOfSessionId === session.id).at(-1);
  const resume = sessions.filter((candidate) => candidate.resumedFromSessionId === session.id).at(-1);
  const attention = session.status === "error" || session.status === "interrupted";
  return {
    id: `planning:${session.id}`,
    source: "planning",
    severity: session.status === "error" ? "error" : session.status === "interrupted" ? "warning" : "info",
    status: session.status,
    code: session.errorCode,
    title: `Planning ${session.stage}`,
    detail: session.errorDetail,
    occurredAt: session.completedAt ?? session.updatedAt,
    ticketId: null,
    sessionId: session.id,
    action: session.status === "error" ? "retry_planning" : session.status === "interrupted" ? "resume_planning" : null,
    resolved: attention && [retry, resume].some((linked) => (
      linked !== undefined && linked.status !== "idle" && linked.status !== "running"
    )),
  };
}

function preparationItem(attempt: WorkspacePreparationAttempt, latest: WorkspacePreparationAttempt | null): ProjectActivityItem {
  const attention = ["AWAITING_APPROVAL", "FAILED", "INTERRUPTED"].includes(attempt.status);
  return {
    id: `preparation:${attempt.id}`,
    source: "preparation",
    severity: attempt.status === "FAILED" ? "error" : attention ? "warning" : "info",
    status: attempt.status,
    code: attempt.diagnosticCode,
    title: "Workspace preparation",
    detail: attempt.diagnosticDetail,
    occurredAt: attempt.completedAt ?? attempt.updatedAt,
    ticketId: attempt.ticketId,
    sessionId: null,
    action: attempt.status === "AWAITING_APPROVAL" ? "approve_preparation" : attention ? "open_ticket" : null,
    resolved: attention && latest?.id !== attempt.id,
  };
}

function integrationItem(attempt: IntegrationAttempt, latest: IntegrationAttempt | null): ProjectActivityItem {
  const attention = ["AWAITING_CONFIRMATION", "BLOCKED", "INTERRUPTED"].includes(attempt.status);
  return {
    id: `integration:${attempt.id}`,
    source: "integration",
    severity: attempt.status === "BLOCKED" ? "error" : attention ? "warning" : "info",
    status: attempt.status,
    code: attempt.diagnosticCode,
    title: "Integration",
    detail: attempt.diagnosticDetail,
    occurredAt: attempt.completedAt ?? attempt.updatedAt,
    ticketId: attempt.ticketId,
    sessionId: null,
    action: attempt.status === "AWAITING_CONFIRMATION" ? "confirm_integration" : attention ? "open_ticket" : null,
    resolved: attention && latest?.id !== attempt.id,
  };
}

function ticketSeverity(status: TicketStatus): ActivitySeverity {
  if (status === "FAILED" || status === "BLOCKED") return "error";
  if (status === "INTERRUPTED" || status === "CANCELLED" || status === "CHANGES_REQUESTED") return "warning";
  return "info";
}

function ticketCode(status: TicketStatus): string | null {
  return attentionTicketStatuses.has(status) ? `ticket.${status.toLowerCase()}` : null;
}

function ticketAction(status: TicketStatus): ActivityAction | null {
  return attentionTicketStatuses.has(status) ? "open_ticket" : null;
}

function activityCursor(item: ProjectActivityItem): string {
  return `${item.occurredAt}|${item.id}`;
}
