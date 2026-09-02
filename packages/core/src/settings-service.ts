import type { AdapterCapabilities } from "./agent-adapter.js";
import {
  agentStages,
  type AgentStage,
  type AgentStageConfig,
  type GlobalConfig,
  type GlobalConfigStore,
  type ReviewMode,
} from "./global-config.js";
import type { IntegrationMode } from "./domain.js";
import type { TicketRepository } from "./ticket-repository.js";

export interface ProjectConfigOverride {
  readonly integrationMode?: IntegrationMode;
  readonly reviewMode?: ReviewMode;
  readonly stages?: Partial<Record<AgentStage, AgentStageConfig>>;
}

export class SettingsService {
  readonly #global: GlobalConfigStore;
  readonly #project: TicketRepository;

  public constructor(global: GlobalConfigStore, project: TicketRepository) {
    this.#global = global;
    this.#project = project;
  }

  public projectOverride(): ProjectConfigOverride {
    const value = this.#project.projectSettings().configuration;
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid project configuration override");
    return value as ProjectConfigOverride;
  }

  public setProjectOverride(override: ProjectConfigOverride): void {
    this.#project.setProjectSetting("configuration", override);
  }

  public async validateProjectOverride(
    override: ProjectConfigOverride,
    capabilities: readonly AdapterCapabilities[],
  ): Promise<GlobalConfig> {
    return mergeAndValidate(await this.#global.read(), override, capabilities);
  }

  public async effective(capabilities: readonly AdapterCapabilities[]): Promise<GlobalConfig> {
    const global = await this.#global.read();
    const override = this.projectOverride();
    return mergeAndValidate(global, override, capabilities);
  }
}

function mergeAndValidate(
  global: GlobalConfig,
  override: ProjectConfigOverride,
  capabilities: readonly AdapterCapabilities[],
): GlobalConfig {
  const effective: GlobalConfig = {
    ...global,
    ...(override.integrationMode === undefined ? {} : { integrationMode: override.integrationMode }),
    ...(override.reviewMode === undefined ? {} : { reviewMode: override.reviewMode }),
    stages: Object.fromEntries(agentStages.map((stage) => [
      stage,
      override.stages?.[stage] ?? global.stages[stage],
    ])) as unknown as GlobalConfig["stages"],
  };
  validateStages(effective.stages, capabilities);
  return effective;
}

function validateStages(
  stages: Readonly<Record<AgentStage, AgentStageConfig>>,
  capabilities: readonly AdapterCapabilities[],
): void {
  for (const stage of agentStages) {
    const selected = stages[stage];
    const provider = capabilities.find((candidate) => candidate.provider === selected.provider);
    if (provider === undefined) throw new Error(`Provider ${selected.provider} configured for ${stage} is unavailable`);
    const model = provider.models.find((candidate) => candidate.id === selected.model);
    if (model === undefined) throw new Error(`Model ${selected.model} configured for ${stage} is unavailable`);
    if (selected.effort !== null && (model.efforts === null || !model.efforts.includes(selected.effort))) {
      throw new Error(`Effort ${selected.effort} configured for ${stage} is unavailable`);
    }
  }
}
