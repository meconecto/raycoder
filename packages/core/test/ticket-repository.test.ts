import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DependencyCycleError, createTicket, type Ticket } from "../src/domain.js";
import { TicketRepository } from "../src/ticket-repository.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(id: string, hasPredecessors = false): Ticket {
  return createTicket({
    id,
    title: id,
    description: "test",
    baseBranch: "main",
    hasPredecessors,
    now: "2026-09-02T00:00:00.000Z",
  });
}

describe("TicketRepository", () => {
  it("migrates once and survives restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");

    const first = new TicketRepository(path);
    first.create(fixture("one"));
    expect(first.appliedMigrations()).toEqual([{ version: 1, name: "tickets_history_dependencies" }]);
    first.close();

    const second = new TicketRepository(path);
    expect(second.get("one").status).toBe("READY");
    expect(second.appliedMigrations()).toHaveLength(1);
    second.close();
  });

  it("persists dependencies and keeps READY_TO_MERGE descendants queued", () => {
    const repository = new TicketRepository(":memory:");
    repository.create(fixture("parent"));
    repository.create(fixture("child", true), ["parent"]);

    expect(repository.dependencies()).toEqual([{ ticketId: "child", predecessorId: "parent" }]);
    expect(repository.reconcileReadiness("child").status).toBe("QUEUED");
    repository.transition("parent", "RUNNING", "test");
    repository.transition("parent", "REVIEW", "test");
    repository.transition("parent", "READY_TO_MERGE", "test");
    expect(repository.reconcileReadiness("child").status).toBe("QUEUED");
    repository.transition("parent", "DONE", "test_fixture_integrated");
    expect(repository.reconcileReadiness("child").status).toBe("READY");
    repository.close();
  });

  it("rejects cyclic replacement before persistence", () => {
    const repository = new TicketRepository(":memory:");
    repository.create(fixture("a"));
    repository.create(fixture("b"));
    repository.create(fixture("c"));
    repository.replaceDependencies("b", ["a"]);
    repository.replaceDependencies("c", ["b"]);
    expect(() => repository.replaceDependencies("a", ["c"])).toThrow(DependencyCycleError);
    expect(repository.dependencies()).toEqual([
      { ticketId: "b", predecessorId: "a" },
      { ticketId: "c", predecessorId: "b" },
    ]);
    repository.close();
  });

  it("records blocked_from and transition history atomically", () => {
    const repository = new TicketRepository(":memory:");
    repository.create(fixture("ticket"));
    repository.transition("ticket", "RUNNING", "dispatch");
    expect(repository.block("ticket", "quota")).toMatchObject({ status: "BLOCKED", blockedFrom: "RUNNING" });
    expect(repository.resolveBlocked("ticket", "quota_restored")).toMatchObject({ status: "RUNNING", blockedFrom: null });
    expect(repository.history("ticket").map((entry) => entry.toStatus)).toEqual([
      "READY",
      "RUNNING",
      "BLOCKED",
      "RUNNING",
    ]);
    repository.close();
  });
});
