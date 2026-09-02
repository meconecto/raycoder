import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { DependencyCycleError, createTicket, type Ticket } from "../src/domain.js";
import { migrations } from "../src/migrations.js";
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
    expect(first.appliedMigrations()).toEqual([
      { version: 1, name: "tickets_history_dependencies" },
      { version: 2, name: "integration_attempts" },
      { version: 3, name: "operational_observations_and_reviews" },
    ]);
    first.close();

    const second = new TicketRepository(path);
    expect(second.get("one").status).toBe("READY");
    expect(second.appliedMigrations()).toHaveLength(3);
    second.close();
  });

  it("upgrades an existing v1 database without losing tickets", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-v1-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");
    const database = new Database(path);
    const firstMigration = migrations[0];
    if (firstMigration === undefined) throw new Error("Expected migration 1");
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );`);
    database.exec(firstMigration.sql);
    database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)")
      .run(firstMigration.name, "2026-09-02T00:00:00.000Z");
    database.close();

    const repository = new TicketRepository(path);
    repository.create(fixture("upgraded"));

    expect(repository.appliedMigrations().map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(repository.get("upgraded").status).toBe("READY");
    repository.close();
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
    repository.createIntegrationAttempt({
      id: "attempt-parent",
      ticketId: "parent",
      mode: "auto",
      originalBaseCommit: "base",
      ticketHead: "ticket",
    });
    repository.updateIntegrationAttempt("attempt-parent", {
      status: "APPLYING",
      observedBaseHead: "base",
      targetCommit: "ticket",
      verificationStatus: "SKIPPED",
    });
    repository.completeIntegration("attempt-parent");
    expect(repository.get("child").status).toBe("READY");
    expect(repository.history("child").at(-1)?.reason).toBe("dependencies_reconciled_after_integration");
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

  it("rejects a cycle during creation in the domain before writing", () => {
    const repository = new TicketRepository(":memory:");
    expect(() => repository.create(fixture("self", true), ["self"])).toThrow(DependencyCycleError);
    expect(repository.list()).toEqual([]);
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
