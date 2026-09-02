import type Database from "better-sqlite3";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "tickets_history_dependencies",
    sql: `
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'READY', 'RUNNING', 'REVIEW', 'CHANGES_REQUESTED',
          'READY_TO_MERGE', 'DONE', 'BLOCKED', 'FAILED', 'CANCELLED', 'INTERRUPTED'
        )),
        blocked_from TEXT CHECK (blocked_from IN (
          'QUEUED', 'READY', 'RUNNING', 'REVIEW', 'CHANGES_REQUESTED', 'READY_TO_MERGE'
        )),
        branch TEXT,
        base_branch TEXT NOT NULL,
        base_commit TEXT,
        workspace TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'BLOCKED' AND blocked_from IS NOT NULL) OR (status <> 'BLOCKED' AND blocked_from IS NULL))
      );

      CREATE TABLE ticket_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX ticket_history_ticket_id ON ticket_history(ticket_id, id);

      CREATE TABLE ticket_dependencies (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        predecessor_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
        PRIMARY KEY (ticket_id, predecessor_id),
        CHECK (ticket_id <> predecessor_id)
      );

      CREATE INDEX ticket_dependencies_predecessor ON ticket_dependencies(predecessor_id);

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, sequence)
      );
    `,
  },
  {
    version: 2,
    name: "integration_attempts",
    sql: `
      CREATE TABLE integration_attempts (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('auto', 'confirm')),
        status TEXT NOT NULL CHECK (status IN (
          'PREPARING', 'AWAITING_CONFIRMATION', 'APPLYING', 'INTEGRATED', 'BLOCKED', 'INTERRUPTED'
        )),
        original_base_commit TEXT NOT NULL,
        observed_base_head TEXT,
        ticket_head TEXT,
        target_commit TEXT,
        reconciliation_workspace TEXT,
        base_moved INTEGER NOT NULL DEFAULT 0 CHECK (base_moved IN (0, 1)),
        verification_status TEXT CHECK (verification_status IN ('SKIPPED', 'PASSED', 'FAILED', 'UNAVAILABLE')),
        verification_commands_json TEXT NOT NULL DEFAULT '[]',
        verification_output TEXT,
        diagnostic_code TEXT,
        diagnostic_detail TEXT,
        confirmed_at TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX integration_attempts_ticket_id ON integration_attempts(ticket_id, started_at, id);
      CREATE INDEX integration_attempts_status ON integration_attempts(status);
    `,
  },
  {
    version: 3,
    name: "operational_observations_and_reviews",
    sql: `
      ALTER TABLE agent_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'implementation';

      CREATE TABLE agent_process_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        process_alive INTEGER NOT NULL CHECK (process_alive IN (0, 1)),
        source TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE git_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        head TEXT,
        branch TEXT,
        is_clean INTEGER CHECK (is_clean IN (0, 1)),
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE review_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        reviewer_provider TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'changes_requested')),
        summary TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX agent_sessions_ticket_role ON agent_sessions(ticket_id, role, created_at);
      CREATE INDEX process_observations_session ON agent_process_observations(session_id, created_at);
      CREATE INDEX git_observations_ticket ON git_observations(ticket_id, created_at);
      CREATE INDEX review_decisions_ticket ON review_decisions(ticket_id, created_at);
    `,
  },
] as const;

export function migrate(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );
  const apply = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
}
