import { DatabaseSync, type StatementResultingChanges, type StatementSync } from "node:sqlite";

export interface SqliteStatement {
  run(...parameters: unknown[]): StatementResultingChanges;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export class SqliteDatabase {
  readonly #database: DatabaseSync;

  public constructor(path: string) {
    this.#database = new DatabaseSync(path);
  }

  public close(): void {
    this.#database.close();
  }

  public exec(sql: string): void {
    this.#database.exec(sql);
  }

  public pragma(statement: string): void {
    this.#database.exec(`PRAGMA ${statement}`);
  }

  public prepare(sql: string): SqliteStatement {
    return new StatementAdapter(this.#database.prepare(sql));
  }

  public transaction<TArguments extends unknown[], TResult>(operation: (...args: TArguments) => TResult): (...args: TArguments) => TResult {
    return (...args: TArguments): TResult => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(...args);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    };
  }
}

class StatementAdapter implements SqliteStatement {
  readonly #statement: StatementSync;

  public constructor(statement: StatementSync) {
    this.#statement = statement;
  }

  public run(...parameters: unknown[]): StatementResultingChanges {
    const run = this.#statement.run.bind(this.#statement) as (...values: unknown[]) => StatementResultingChanges;
    return run(...parameters);
  }

  public get(...parameters: unknown[]): unknown {
    const get = this.#statement.get.bind(this.#statement) as (...values: unknown[]) => unknown;
    return get(...parameters);
  }

  public all(...parameters: unknown[]): unknown[] {
    const all = this.#statement.all.bind(this.#statement) as (...values: unknown[]) => unknown[];
    return all(...parameters);
  }
}

export default SqliteDatabase;
