import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { integrationModes, type IntegrationMode } from "./domain.js";

export const agentStages = ["planning", "specification", "ticketing", "implementation", "review"] as const;
export type AgentStage = (typeof agentStages)[number];
export type ReviewMode = "self" | "independent";

export interface AgentStageConfig {
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
}

export interface GlobalConfig {
  readonly version: 2;
  readonly integrationMode: IntegrationMode;
  readonly reviewMode: ReviewMode;
  readonly stages: Readonly<Record<AgentStage, AgentStageConfig>>;
}

const defaultStage = (): AgentStageConfig => ({ provider: "codex", model: "default", effort: "medium" });

export const defaultGlobalConfig: GlobalConfig = {
  version: 2,
  integrationMode: "auto",
  reviewMode: "independent",
  stages: {
    planning: defaultStage(),
    specification: defaultStage(),
    ticketing: defaultStage(),
    implementation: defaultStage(),
    review: defaultStage(),
  },
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
    if (candidate.version === 1 && isIntegrationMode(candidate.integrationMode)) {
      return { ...defaultGlobalConfig, integrationMode: candidate.integrationMode };
    }
    if (
      candidate.version !== 2
      || !isIntegrationMode(candidate.integrationMode)
      || (candidate.reviewMode !== "self" && candidate.reviewMode !== "independent")
      || !isStageTable(candidate.stages)
    ) throw new Error(`Unsupported raycoder global config at ${this.#path}`);
    return candidate as unknown as GlobalConfig;
  }

  public async setIntegrationMode(integrationMode: IntegrationMode): Promise<GlobalConfig> {
    return await this.write({ ...await this.read(), integrationMode });
  }

  public async setReviewMode(reviewMode: ReviewMode): Promise<GlobalConfig> {
    return await this.write({ ...await this.read(), reviewMode });
  }

  public async setStage(stage: AgentStage, config: AgentStageConfig): Promise<GlobalConfig> {
    const current = await this.read();
    return await this.write({ ...current, stages: { ...current.stages, [stage]: config } });
  }

  public async write(config: GlobalConfig): Promise<GlobalConfig> {
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true });
    const temporaryPath = join(parent, `.config-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#path);
    return config;
  }
}

function isIntegrationMode(value: unknown): value is IntegrationMode {
  return typeof value === "string" && (integrationModes as readonly string[]).includes(value);
}

function isStageTable(value: unknown): value is GlobalConfig["stages"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const table = value as Record<string, unknown>;
  return agentStages.every((stage) => {
    const row = table[stage];
    if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.provider === "string"
      && typeof candidate.model === "string"
      && (candidate.effort === null || typeof candidate.effort === "string");
  });
}
