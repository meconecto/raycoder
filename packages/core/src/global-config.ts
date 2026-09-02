import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { integrationModes, type IntegrationMode } from "./domain.js";

export interface GlobalConfig {
  readonly version: 1;
  readonly integrationMode: IntegrationMode;
}

export const defaultGlobalConfig: GlobalConfig = {
  version: 1,
  integrationMode: "auto",
};

export class GlobalConfigStore {
  readonly #path: string;

  public constructor(path = join(homedir(), ".raycoder", "config.json")) {
    this.#path = resolve(path);
  }

  public get path(): string {
    return this.#path;
  }

  public async read(): Promise<GlobalConfig> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultGlobalConfig;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid raycoder global config at ${this.#path}`);
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.version !== 1
      || typeof candidate.integrationMode !== "string"
      || !(integrationModes as readonly string[]).includes(candidate.integrationMode)
    ) {
      throw new Error(`Unsupported raycoder global config at ${this.#path}`);
    }
    return { version: 1, integrationMode: candidate.integrationMode as IntegrationMode };
  }

  public async setIntegrationMode(integrationMode: IntegrationMode): Promise<GlobalConfig> {
    const config: GlobalConfig = { version: 1, integrationMode };
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true });
    const temporaryPath = join(parent, `.config-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#path);
    return config;
  }
}
