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
