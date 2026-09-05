import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.js";
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
      { version: 4, name: "planning_artifacts_threads_and_settings" },
      { version: 5, name: "conversational_planning_sessions_and_traceability" },
      { version: 6, name: "durable_workspace_preparation" },
      { version: 7, name: "planning_retry_traceability" },
      { version: 8, name: "durable_multistack_verification" },
    ]);
    first.close();

    const second = new TicketRepository(path);
    expect(second.get("one").status).toBe("READY");
    expect(second.appliedMigrations()).toHaveLength(8);
    second.close();
  });

  it("upgrades an existing v1 database without losing tickets", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-v1-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");
    const database = new SqliteDatabase(path);
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

    expect(repository.appliedMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(repository.get("upgraded").status).toBe("READY");
    repository.close();
  });

  it("upgrades a real v4 planning database to v5 idempotently without losing history", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-v4-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");
    const database = new SqliteDatabase(path);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );`);
    for (const migration of migrations.slice(0, 4)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-09-02T00:00:00.000Z");
    }
    database.prepare(`INSERT INTO planning_threads
      (id, provider, provider_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("thread-v4", "fake", "provider-v4", "completed", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:01.000Z");
    database.prepare(`INSERT INTO planning_messages
      (thread_id, sequence, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("thread-v4", 0, "user", "preserved message", "2026-09-02T00:00:00.000Z");
    database.prepare(`INSERT INTO planning_artifacts
      (id, kind, revision, content_json, predecessor_artifact_id, status, created_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("artifact-v4", "interrogation", 1, JSON.stringify({ markdown: "preserved" }), null, "approved",
        "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:01.000Z");
    database.close();

    const first = new TicketRepository(path);
    expect(first.appliedMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(first.latestPlanningThread()).toMatchObject({ id: "thread-v4", status: "idle" });
    expect(first.planningMessages("thread-v4")).toMatchObject([{ content: "preserved message", sessionId: null }]);
    expect(first.getPlanningArtifact("artifact-v4")).toMatchObject({
      content: { markdown: "preserved" },
      authorRole: "system",
      sourceMessageIds: [],
    });
    first.close();

    const second = new TicketRepository(path);
    expect(second.appliedMigrations()).toHaveLength(8);
    expect(second.listPlanningSessions()).toEqual([]);
    second.close();
  });

  it("upgrades a real v5 database to v6 idempotently without losing tickets", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-v5-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");
    const database = new SqliteDatabase(path);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );`);
    for (const migration of migrations.slice(0, 5)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-09-02T00:00:00.000Z");
    }
    database.prepare(`INSERT INTO tickets (
      id, title, description, status, blocked_from, branch, base_branch, base_commit, workspace, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "v5-ticket", "V5", "preserved", "READY", null, null, "main", null, null,
      "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z",
    );
    database.close();

    const first = new TicketRepository(path);
    expect(first.get("v5-ticket")).toMatchObject({ title: "V5", status: "READY" });
    expect(first.appliedMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(first.listWorkspacePreparationAttempts()).toEqual([]);
    first.close();

    const second = new TicketRepository(path);
    expect(second.appliedMigrations()).toHaveLength(8);
    expect(second.get("v5-ticket").description).toBe("preserved");
    second.close();
  });

  it("upgrades a real v6 database to v7 and preserves planning failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-v6-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");
    const database = new SqliteDatabase(path);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );`);
    for (const migration of migrations.slice(0, 6)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-09-02T00:00:00.000Z");
    }
    database.prepare(`INSERT INTO planning_threads
      (id, provider, provider_session_id, status, created_at, updated_at, singleton)
      VALUES ('thread-v6', 'fake', NULL, 'error', ?, ?, 1)`)
      .run("2026-09-02T00:00:00.000Z", "2026-09-02T00:00:01.000Z");
    database.prepare(`INSERT INTO planning_sessions
      (id, thread_id, provider, stage, request_json, status, error_code, error_detail, created_at, updated_at, completed_at)
      VALUES ('failed-v6', 'thread-v6', 'fake', 'conversation', ?, 'error', 'quota_exhausted', 'limit', ?, ?, ?)`)
      .run(JSON.stringify({ kind: "message", content: "preserved" }), "2026-09-02T00:00:00.000Z",
        "2026-09-02T00:00:01.000Z", "2026-09-02T00:00:01.000Z");
    database.close();

    const repository = new TicketRepository(path);
    expect(repository.getPlanningSession("failed-v6")).toMatchObject({
      status: "error",
      errorCode: "quota_exhausted",
      retryOfSessionId: null,
    });
    expect(repository.appliedMigrations().at(-2)).toEqual({ version: 7, name: "planning_retry_traceability" });
    expect(repository.listWorkspaceVerificationAttempts()).toEqual([]);
    repository.close();

    const reopened = new TicketRepository(path);
    expect(reopened.appliedMigrations()).toHaveLength(8);
    reopened.close();
  });

  it("upgrades a real v7 database to v8 idempotently without losing ticket history", () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-db-v7-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "raycoder.db");
    const database = new SqliteDatabase(path);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );`);
    for (const migration of migrations.slice(0, 7)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-09-02T00:00:00.000Z");
    }
    database.prepare(`INSERT INTO tickets
      (id, title, description, status, blocked_from, branch, base_branch, base_commit, workspace, created_at, updated_at)
      VALUES ('v7-ticket', 'V7', 'preserved', 'READY', NULL, NULL, 'main', NULL, NULL, ?, ?)`)
      .run("2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
    database.prepare(`INSERT INTO ticket_history
      (ticket_id, from_status, to_status, reason, created_at)
      VALUES ('v7-ticket', NULL, 'READY', 'created', ?)`)
      .run("2026-09-02T00:00:00.000Z");
    database.close();

    const upgraded = new TicketRepository(path);
    expect(upgraded.get("v7-ticket")).toMatchObject({ status: "READY", description: "preserved" });
    expect(upgraded.history("v7-ticket")).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "READY", reason: "created" }),
    ]);
    expect(upgraded.listWorkspaceVerificationAttempts()).toEqual([]);
    expect(upgraded.appliedMigrations().at(-1)).toEqual({ version: 8, name: "durable_multistack_verification" });
    upgraded.close();

    const reopened = new TicketRepository(path);
    expect(reopened.appliedMigrations()).toHaveLength(8);
    expect(reopened.history("v7-ticket")).toHaveLength(1);
    reopened.close();
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
