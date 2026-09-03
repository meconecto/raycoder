import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const INSTANCE_PROTOCOL_VERSION = 1;

export interface InstanceRecord {
  readonly version: 1;
  readonly id: string;
  readonly nonce: string;
  readonly pid: number;
  readonly port: number;
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly startedAt: string;
}

interface LockRecord {
  readonly id: string;
  readonly nonce: string;
  readonly pid: number;
  readonly createdAt: string;
}

export type InstanceAcquisition =
  | { readonly kind: "acquired"; readonly lease: InstanceLease }
  | { readonly kind: "existing"; readonly record: InstanceRecord };

export class InstanceCoordinator {
  public readonly root: string;
  readonly #lockPath: string;
  readonly #recordPath: string;
  readonly #appVersion: string;
  readonly #fetch: typeof fetch;

  public constructor(appVersion: string, root = join(homedir(), ".raycoder"), fetchImplementation = fetch) {
    this.root = resolve(root);
    this.#lockPath = join(this.root, "instance.lock");
    this.#recordPath = join(this.root, "instance.json");
    this.#appVersion = appVersion;
    this.#fetch = fetchImplementation;
  }

  public async acquire(): Promise<InstanceAcquisition> {
    await mkdir(this.root, { recursive: true });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const lock: LockRecord = {
        id: randomUUID(),
        nonce: randomBytes(32).toString("hex"),
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
        await handle.close();
        return {
          kind: "acquired",
          lease: new InstanceLease(this.root, this.#lockPath, this.#recordPath, lock, this.#appVersion),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await this.readActive();
      if (existing !== null) return { kind: "existing", record: existing };
      const observed = await readLock(this.#lockPath);
      if (observed !== null && processAlive(observed.pid)) {
        await delay(200);
        continue;
      }
      if (observed !== null) {
        await delay(200);
        const activeAfterWait = await this.readActive();
        if (activeAfterWait !== null) return { kind: "existing", record: activeAfterWait };
        const observedAfterWait = await readLock(this.#lockPath);
        if (observedAfterWait?.nonce !== observed.nonce) continue;
        await removeIfOwned(this.#lockPath, observed.nonce);
      }
      await removeStaleRecord(this.#recordPath, observed?.nonce);
    }
    throw new Error("Another raycoder process is still starting. Try again in a few seconds.");
  }

  public async readActive(): Promise<InstanceRecord | null> {
    const record = await readInstance(this.#recordPath);
    if (record === null) return null;
    try {
      const response = await this.#fetch(`http://127.0.0.1:${record.port}/api/instance`, {
        headers: { "x-raycoder-instance-nonce": record.nonce },
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return null;
      const value = await response.json() as Partial<InstanceRecord>;
      return value.id === record.id && value.protocolVersion === record.protocolVersion ? record : null;
    } catch {
      return null;
    }
  }
}

export class InstanceLease {
  public readonly id: string;
  public readonly nonce: string;
  readonly #root: string;
  readonly #lockPath: string;
  readonly #recordPath: string;
  readonly #lock: LockRecord;
  readonly #appVersion: string;

  public constructor(root: string, lockPath: string, recordPath: string, lock: LockRecord, appVersion: string) {
    this.#root = root;
    this.#lockPath = lockPath;
    this.#recordPath = recordPath;
    this.#lock = lock;
    this.#appVersion = appVersion;
    this.id = lock.id;
    this.nonce = lock.nonce;
  }

  public record(port: number): InstanceRecord {
    return {
      version: 1,
      id: this.id,
      nonce: this.nonce,
      pid: process.pid,
      port,
      appVersion: this.#appVersion,
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
      startedAt: this.#lock.createdAt,
    };
  }

  public async publish(port: number): Promise<InstanceRecord> {
    const record = this.record(port);
    const temporary = join(this.#root, `.instance-${this.nonce}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#recordPath);
    return record;
  }

  public async release(): Promise<void> {
    await removeIfOwned(this.#recordPath, this.nonce);
    await removeIfOwned(this.#lockPath, this.nonce);
    try {
      const entries = await readdir(this.#root);
      if (entries.length === 0) await rm(this.#root, { recursive: false });
    } catch {
      // Global state remains when it contains config or project registry data.
    }
  }
}

export async function readInstance(path: string): Promise<InstanceRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<InstanceRecord>;
    return record.version === 1
      && typeof record.id === "string"
      && typeof record.nonce === "string"
      && typeof record.pid === "number"
      && typeof record.port === "number"
      && typeof record.appVersion === "string"
      && typeof record.protocolVersion === "number"
      && typeof record.startedAt === "string"
      ? record as InstanceRecord
      : null;
  } catch {
    return null;
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const lock = value as Partial<LockRecord>;
    return typeof lock.id === "string" && typeof lock.nonce === "string" && typeof lock.pid === "number" && typeof lock.createdAt === "string"
      ? lock as LockRecord
      : null;
  } catch {
    return null;
  }
}

async function removeIfOwned(path: string, nonce: string): Promise<void> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && (value as { nonce?: unknown }).nonce === nonce) {
      await rm(path, { force: true });
    }
  } catch {
    return;
  }
}

async function removeStaleRecord(path: string, expectedNonce?: string): Promise<void> {
  const record = await readInstance(path);
  if (record === null || expectedNonce === undefined || record.nonce === expectedNonce) await rm(path, { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
