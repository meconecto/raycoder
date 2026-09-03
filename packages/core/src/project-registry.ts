import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import SqliteDatabase from "./sqlite.js";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";

export interface RegisteredProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

export class ProjectInitializationConfirmationError extends Error {
  public constructor() {
    super("Creating a project and initializing Git requires explicit confirmation");
    this.name = "ProjectInitializationConfirmationError";
  }
}

export class ProjectRegistry {
  readonly #database: SqliteDatabase;
  readonly #runner: ProcessRunner;

  public constructor(databasePath: string, runner: ProcessRunner = new NodeProcessRunner()) {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.#database = new SqliteDatabase(databasePath);
    this.#runner = runner;
    this.#database.pragma("journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public close(): void {
    this.#database.close();
  }

  public list(): RegisteredProject[] {
    return (this.#database.prepare("SELECT id, name, path, created_at, updated_at FROM projects ORDER BY updated_at DESC, name, id").all() as ProjectRow[])
      .map(fromProjectRow);
  }

  public get(id: string): RegisteredProject {
    const row = this.#database.prepare("SELECT id, name, path, created_at, updated_at FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    if (row === undefined) throw new Error(`Unknown project: ${id}`);
    return fromProjectRow(row);
  }

  public async register(projectPath: string, name?: string): Promise<RegisteredProject> {
    const root = resolve((await this.#runner.run("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(projectPath),
      timeoutMs: 10_000,
    })).stdout.trim());
    return this.#upsert(await canonicalPath(root), name ?? basename(root));
  }

  public async create(input: { path: string; name?: string; confirmGitInit: boolean }): Promise<RegisteredProject> {
    if (!input.confirmGitInit) throw new ProjectInitializationConfirmationError();
    const requested = resolve(input.path);
    await mkdir(requested, { recursive: true });
    const entries = await readdir(requested);
    if (entries.length > 0) throw new Error(`New project directory is not empty: ${requested}`);
    await this.#runner.run("git", ["init", "-b", "main"], { cwd: requested, timeoutMs: 30_000 });
    await this.#runner.run("git", [
      "-c", "user.name=raycoder",
      "-c", "user.email=raycoder@local.invalid",
      "commit", "--allow-empty", "-m", "chore: initialize raycoder project",
    ], { cwd: requested, timeoutMs: 30_000 });
    return this.#upsert(await canonicalPath(requested), input.name ?? basename(requested));
  }

  public async initialize(input: { path: string; name?: string; confirmGitInit: boolean }): Promise<RegisteredProject> {
    if (!input.confirmGitInit) throw new ProjectInitializationConfirmationError();
    const requested = resolve(input.path);
    const root = await canonicalPath(requested);
    await this.#runner.run("git", ["init", "-b", "main"], { cwd: root, timeoutMs: 30_000 });
    return this.#upsert(root, input.name ?? basename(root));
  }

  public touch(id: string): RegisteredProject {
    const now = new Date().toISOString();
    const result = this.#database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
    if (result.changes === 0) throw new Error(`Unknown project: ${id}`);
    return this.get(id);
  }

  public remove(id: string): void {
    const result = this.#database.prepare("DELETE FROM projects WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error(`Unknown project: ${id}`);
  }

  #upsert(path: string, name: string): RegisteredProject {
    const key = pathKey(path);
    const existing = this.#database.prepare("SELECT id, name, path, created_at, updated_at FROM projects WHERE path_key = ?")
      .get(key) as ProjectRow | undefined;
    const now = new Date().toISOString();
    if (existing !== undefined) {
      this.#database.prepare("UPDATE projects SET name = ?, path = ?, updated_at = ? WHERE id = ?")
        .run(name, path, now, existing.id);
      return this.get(existing.id);
    }
    const id = randomUUID();
    this.#database.prepare(`INSERT INTO projects (id, name, path, path_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, path, key, now, now);
    return this.get(id);
  }
}

async function canonicalPath(path: string): Promise<string> {
  return resolve(await realpath(path));
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function fromProjectRow(row: ProjectRow): RegisteredProject {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
