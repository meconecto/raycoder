import type SqliteDatabase from "./sqlite.js";

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
  {
    version: 4,
    name: "planning_artifacts_threads_and_settings",
    sql: `
      CREATE TABLE planning_threads (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE planning_artifacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('interrogation', 'spec', 'tickets')),
        revision INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        predecessor_artifact_id TEXT REFERENCES planning_artifacts(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        UNIQUE (kind, revision)
      );

      CREATE TABLE planning_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES planning_threads(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, sequence)
      );

      CREATE TABLE project_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX planning_artifacts_kind_revision ON planning_artifacts(kind, revision);
      CREATE INDEX planning_messages_thread_sequence ON planning_messages(thread_id, sequence);
    `,
  },
  {
    version: 5,
    name: "conversational_planning_sessions_and_traceability",
    sql: `
      ALTER TABLE planning_threads ADD COLUMN singleton INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1);
      UPDATE planning_threads SET status = 'idle' WHERE status NOT IN ('idle', 'running', 'interrupted', 'error');
      CREATE UNIQUE INDEX planning_threads_singleton ON planning_threads(singleton);

      CREATE TABLE planning_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES planning_threads(id) ON DELETE CASCADE,
        adapter_session_id TEXT,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        stage TEXT NOT NULL CHECK (stage IN ('conversation', 'spec', 'tickets')),
        request_json TEXT NOT NULL,
        resumed_from_session_id TEXT REFERENCES planning_sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN (
          'idle', 'running', 'completed', 'cancelled', 'interrupted', 'error'
        )),
        error_code TEXT,
        error_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE planning_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, sequence)
      );

      ALTER TABLE planning_messages ADD COLUMN session_id TEXT REFERENCES planning_sessions(id) ON DELETE SET NULL;

      ALTER TABLE planning_artifacts ADD COLUMN author_role TEXT NOT NULL DEFAULT 'system'
        CHECK (author_role IN ('user', 'assistant', 'system'));
      ALTER TABLE planning_artifacts ADD COLUMN author_id TEXT;
      ALTER TABLE planning_artifacts ADD COLUMN source_session_id TEXT REFERENCES planning_sessions(id) ON DELETE SET NULL;
      ALTER TABLE planning_artifacts ADD COLUMN replaces_artifact_id TEXT REFERENCES planning_artifacts(id) ON DELETE SET NULL;
      ALTER TABLE planning_artifacts ADD COLUMN confirmed_at TEXT;

      CREATE TABLE planning_artifact_sources (
        artifact_id TEXT NOT NULL REFERENCES planning_artifacts(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES planning_messages(id) ON DELETE RESTRICT,
        PRIMARY KEY (artifact_id, message_id)
      );

      ALTER TABLE tickets ADD COLUMN planning_artifact_id TEXT REFERENCES planning_artifacts(id) ON DELETE RESTRICT;

      CREATE TABLE planning_dag_confirmations (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES planning_artifacts(id) ON DELETE RESTRICT,
        replaced_artifact_id TEXT REFERENCES planning_artifacts(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX planning_sessions_thread_created ON planning_sessions(thread_id, created_at, id);
      CREATE INDEX planning_sessions_status ON planning_sessions(status);
      CREATE INDEX planning_events_session_sequence ON planning_events(session_id, sequence);
      CREATE INDEX planning_messages_session ON planning_messages(session_id, sequence);
      CREATE INDEX planning_artifact_sources_message ON planning_artifact_sources(message_id, artifact_id);
      CREATE INDEX tickets_planning_artifact ON tickets(planning_artifact_id, created_at, id);
      CREATE INDEX planning_dag_confirmations_created ON planning_dag_confirmations(created_at, id);
    `,
  },
  {
    version: 6,
    name: "durable_workspace_preparation",
    sql: `
      CREATE TABLE workspace_preparation_attempts (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        integration_attempt_id TEXT REFERENCES integration_attempts(id) ON DELETE SET NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('dispatch', 'integration')),
        status TEXT NOT NULL CHECK (status IN (
          'AWAITING_APPROVAL', 'QUEUED', 'PREPARING', 'PREPARED', 'NOT_APPLICABLE',
          'FAILED', 'CANCELLED', 'INTERRUPTED'
        )),
        strategy TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        approval_json TEXT,
        workspace TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        resumed_from_attempt_id TEXT REFERENCES workspace_preparation_attempts(id) ON DELETE SET NULL,
        process_json TEXT,
        output TEXT,
        diagnostic_code TEXT,
        diagnostic_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX workspace_preparation_ticket_created
        ON workspace_preparation_attempts(ticket_id, created_at, id);
      CREATE INDEX workspace_preparation_status
        ON workspace_preparation_attempts(status);
      CREATE INDEX workspace_preparation_integration
        ON workspace_preparation_attempts(integration_attempt_id, created_at);
    `,
  },
  {
    version: 7,
    name: "planning_retry_traceability",
    sql: `
      ALTER TABLE planning_sessions ADD COLUMN retry_of_session_id TEXT
        REFERENCES planning_sessions(id) ON DELETE SET NULL;

      CREATE INDEX planning_sessions_retry
        ON planning_sessions(retry_of_session_id, created_at, id);
    `,
  },
  {
    version: 8,
    name: "durable_multistack_verification",
    sql: `
      CREATE TABLE workspace_verification_attempts (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        integration_attempt_id TEXT REFERENCES integration_attempts(id) ON DELETE SET NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('dispatch', 'integration')),
        status TEXT NOT NULL CHECK (status IN (
          'AWAITING_APPROVAL', 'QUEUED', 'VERIFYING', 'PASSED', 'FAILED',
          'UNAVAILABLE', 'CANCELLED', 'INTERRUPTED'
        )),
        strategy TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        approval_json TEXT,
        workspace TEXT NOT NULL,
        target_commit TEXT NOT NULL,
        resumed_from_attempt_id TEXT REFERENCES workspace_verification_attempts(id) ON DELETE SET NULL,
        process_json TEXT,
        output TEXT,
        diagnostic_code TEXT,
        diagnostic_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX workspace_verification_ticket_created
        ON workspace_verification_attempts(ticket_id, created_at, id);
      CREATE INDEX workspace_verification_status
        ON workspace_verification_attempts(status);
      CREATE INDEX workspace_verification_integration
        ON workspace_verification_attempts(integration_attempt_id, created_at);
    `,
  },
  {
    version: 9,
    name: "durable_opt_in_auto_runs",
    sql: `
      CREATE TABLE auto_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED')),
        active_slot INTEGER CHECK (active_slot = 1),
        dirty_policy TEXT NOT NULL CHECK (dirty_policy IN ('cancel', 'committed-head')),
        current_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        reason_code TEXT,
        reason_detail TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (
          (status IN ('RUNNING', 'PAUSED') AND active_slot = 1 AND completed_at IS NULL)
          OR (status IN ('STOPPED', 'COMPLETED') AND active_slot IS NULL AND completed_at IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX auto_runs_single_active ON auto_runs(active_slot) WHERE active_slot = 1;
      CREATE INDEX auto_runs_started ON auto_runs(started_at, id);

      CREATE TABLE auto_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES auto_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'STARTED', 'TICKET_STARTED', 'TICKET_FINISHED', 'PAUSED', 'RESUMED', 'STOPPED', 'COMPLETED'
        )),
        ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        reason_code TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );

      CREATE INDEX auto_run_events_run_sequence ON auto_run_events(run_id, sequence);
      CREATE INDEX auto_run_events_ticket ON auto_run_events(ticket_id, created_at);
    `,
  },
] as const;

export function migrate(database: SqliteDatabase): void {
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
