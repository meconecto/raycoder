export const ticketStatuses = [
  "QUEUED",
  "READY",
  "RUNNING",
  "REVIEW",
  "CHANGES_REQUESTED",
  "READY_TO_MERGE",
  "DONE",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
] as const;

export type TicketStatus = (typeof ticketStatuses)[number];

export const operationalStatuses = [
  "QUEUED",
  "READY",
  "RUNNING",
  "REVIEW",
  "CHANGES_REQUESTED",
  "READY_TO_MERGE",
] as const satisfies readonly TicketStatus[];

export type OperationalStatus = (typeof operationalStatuses)[number];

export const integrationModes = ["auto", "confirm"] as const;

export type IntegrationMode = (typeof integrationModes)[number];

export const integrationAttemptStatuses = [
  "PREPARING",
  "AWAITING_CONFIRMATION",
  "APPLYING",
  "INTEGRATED",
  "BLOCKED",
  "INTERRUPTED",
] as const;

export type IntegrationAttemptStatus = (typeof integrationAttemptStatuses)[number];

export const verificationStatuses = ["SKIPPED", "PASSED", "FAILED", "UNAVAILABLE"] as const;

export type VerificationStatus = (typeof verificationStatuses)[number];

export interface Ticket {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly blockedFrom: OperationalStatus | null;
  readonly branch: string | null;
  readonly baseBranch: string;
  readonly baseCommit: string | null;
  readonly workspace: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DependencyEdge {
  readonly ticketId: string;
  readonly predecessorId: string;
}

export class InvalidTransitionError extends Error {
  public constructor(from: TicketStatus, to: TicketStatus) {
    super(`Invalid ticket transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class DependencyCycleError extends Error {
  public constructor() {
    super("Dependency mutation would introduce a cycle");
    this.name = "DependencyCycleError";
  }
}

export class UnknownTicketError extends Error {
  public constructor(id: string) {
    super(`Unknown ticket: ${id}`);
    this.name = "UnknownTicketError";
  }
}

const transitionTable: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  QUEUED: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["QUEUED", "RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["REVIEW", "BLOCKED", "FAILED", "CANCELLED", "INTERRUPTED"],
  REVIEW: ["CHANGES_REQUESTED", "READY_TO_MERGE", "BLOCKED", "FAILED", "CANCELLED", "INTERRUPTED"],
  CHANGES_REQUESTED: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  READY_TO_MERGE: ["BLOCKED", "CANCELLED", "INTERRUPTED"],
  DONE: [],
  BLOCKED: [],
  FAILED: ["READY", "RUNNING", "CANCELLED"],
  CANCELLED: [],
  INTERRUPTED: ["READY", "RUNNING", "CANCELLED"],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return transitionTable[from].includes(to);
}

export function transitionTicket(ticket: Ticket, to: TicketStatus, now = new Date().toISOString()): Ticket {
  if (to === "BLOCKED" || ticket.status === "BLOCKED" || !canTransition(ticket.status, to)) {
    throw new InvalidTransitionError(ticket.status, to);
  }

  return { ...ticket, status: to, blockedFrom: null, updatedAt: now };
}

export function blockTicket(ticket: Ticket, now = new Date().toISOString()): Ticket {
  if (!isOperationalStatus(ticket.status) || !canTransition(ticket.status, "BLOCKED")) {
    throw new InvalidTransitionError(ticket.status, "BLOCKED");
  }

  return {
    ...ticket,
    status: "BLOCKED",
    blockedFrom: ticket.status,
    updatedAt: now,
  };
}

export function resolveBlockedTicket(
  ticket: Ticket,
  target: OperationalStatus | undefined = ticket.blockedFrom ?? undefined,
  now = new Date().toISOString(),
): Ticket {
  if (ticket.status !== "BLOCKED" || ticket.blockedFrom === null || target === undefined) {
    throw new InvalidTransitionError(ticket.status, target ?? ticket.status);
  }

  if (target !== ticket.blockedFrom && !canTransition(ticket.blockedFrom, target)) {
    throw new InvalidTransitionError(ticket.blockedFrom, target);
  }

  return { ...ticket, status: target, blockedFrom: null, updatedAt: now };
}

export function isOperationalStatus(status: TicketStatus): status is OperationalStatus {
  return (operationalStatuses as readonly TicketStatus[]).includes(status);
}

export function createTicket(input: {
  id: string;
  title: string;
  description: string;
  baseBranch: string;
  hasPredecessors: boolean;
  now?: string;
}): Ticket {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    status: input.hasPredecessors ? "QUEUED" : "READY",
    blockedFrom: null,
    branch: null,
    baseBranch: input.baseBranch,
    baseCommit: null,
    workspace: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function assertAcyclic(ticketIds: readonly string[], edges: readonly DependencyEdge[]): void {
  const ids = new Set(ticketIds);
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const id of ids) {
    successors.set(id, []);
    indegree.set(id, 0);
  }

  for (const edge of edges) {
    if (!ids.has(edge.ticketId)) throw new UnknownTicketError(edge.ticketId);
    if (!ids.has(edge.predecessorId)) throw new UnknownTicketError(edge.predecessorId);
    if (edge.ticketId === edge.predecessorId) throw new DependencyCycleError();
    successors.get(edge.predecessorId)?.push(edge.ticketId);
    indegree.set(edge.ticketId, (indegree.get(edge.ticketId) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    visited += 1;
    for (const successor of successors.get(id) ?? []) {
      const nextDegree = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, nextDegree);
      if (nextDegree === 0) queue.push(successor);
    }
  }

  if (visited !== ids.size) throw new DependencyCycleError();
}

export function replaceTicketDependencies(
  ticketIds: readonly string[],
  currentEdges: readonly DependencyEdge[],
  ticketId: string,
  predecessorIds: readonly string[],
): DependencyEdge[] {
  if (!ticketIds.includes(ticketId)) throw new UnknownTicketError(ticketId);
  const uniquePredecessors = [...new Set(predecessorIds)];
  const nextEdges = [
    ...currentEdges.filter((edge) => edge.ticketId !== ticketId),
    ...uniquePredecessors.map((predecessorId) => ({ ticketId, predecessorId })),
  ];
  assertAcyclic(ticketIds, nextEdges);
  return nextEdges;
}

export function isReady(ticketId: string, tickets: readonly Ticket[], edges: readonly DependencyEdge[]): boolean {
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  if (!ticketsById.has(ticketId)) throw new UnknownTicketError(ticketId);
  return edges
    .filter((edge) => edge.ticketId === ticketId)
    .every((edge) => ticketsById.get(edge.predecessorId)?.status === "DONE");
}

export function desiredPendingStatus(
  ticket: Ticket,
  tickets: readonly Ticket[],
  edges: readonly DependencyEdge[],
): "QUEUED" | "READY" {
  return isReady(ticket.id, tickets, edges) ? "READY" : "QUEUED";
}
