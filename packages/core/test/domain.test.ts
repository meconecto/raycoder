import { describe, expect, it } from "vitest";
import {
  DependencyCycleError,
  InvalidTransitionError,
  blockTicket,
  createTicket,
  isReady,
  replaceTicketDependencies,
  resolveBlockedTicket,
  transitionTicket,
  type Ticket,
  type TicketStatus,
} from "../src/domain.js";

function fixture(status: TicketStatus, id = "ticket-1"): Ticket {
  const base = createTicket({
    id,
    title: id,
    description: "test",
    baseBranch: "main",
    hasPredecessors: status === "QUEUED",
    now: "2026-09-02T00:00:00.000Z",
  });
  return { ...base, status };
}

describe("ticket lifecycle", () => {
  it("accepts a normal path through READY_TO_MERGE", () => {
    const ready = fixture("READY");
    const running = transitionTicket(ready, "RUNNING");
    const review = transitionTicket(running, "REVIEW");
    expect(transitionTicket(review, "READY_TO_MERGE").status).toBe("READY_TO_MERGE");
  });

  it("rejects invalid transitions explicitly", () => {
    expect(() => transitionTicket(fixture("READY"), "REVIEW")).toThrow(InvalidTransitionError);
    expect(() => transitionTicket(fixture("READY_TO_MERGE"), "READY")).toThrow(InvalidTransitionError);
    expect(() => transitionTicket(fixture("DONE"), "READY")).toThrow(InvalidTransitionError);
  });

  it.each(["READY", "RUNNING", "REVIEW", "READY_TO_MERGE"] as const)(
    "preserves and restores blocked_from for %s",
    (status) => {
      const blocked = blockTicket(fixture(status));
      expect(blocked).toMatchObject({ status: "BLOCKED", blockedFrom: status });
      expect(resolveBlockedTicket(blocked)).toMatchObject({ status, blockedFrom: null });
    },
  );

  it("requires the dedicated blocked semantics", () => {
    expect(() => transitionTicket(fixture("RUNNING"), "BLOCKED")).toThrow(InvalidTransitionError);
    expect(() => resolveBlockedTicket(fixture("BLOCKED"))).toThrow(InvalidTransitionError);
  });
});

describe("dependency DAG", () => {
  it("only considers DONE predecessors satisfied", () => {
    const child = fixture("QUEUED", "child");
    const edge = [{ ticketId: "child", predecessorId: "parent" }];

    expect(isReady("child", [child, fixture("READY_TO_MERGE", "parent")], edge)).toBe(false);
    expect(isReady("child", [child, fixture("BLOCKED", "parent")], edge)).toBe(false);
    expect(isReady("child", [child, fixture("DONE", "parent")], edge)).toBe(true);
  });

  it("rejects direct and transitive cycles", () => {
    expect(() => replaceTicketDependencies(["a"], [], "a", ["a"])).toThrow(DependencyCycleError);
    const edges = [
      { ticketId: "b", predecessorId: "a" },
      { ticketId: "c", predecessorId: "b" },
    ];
    expect(() => replaceTicketDependencies(["a", "b", "c"], edges, "a", ["c"])).toThrow(
      DependencyCycleError,
    );
  });
});
