import type { AgentAdapter, ProviderPreflight } from "./agent-adapter.js";

export interface PreflightReport {
  readonly canStart: boolean;
  readonly essential: readonly {
    name: string;
    ok: boolean;
    message: string;
  }[];
  readonly providers: readonly ProviderPreflight[];
  readonly upcoming: readonly string[];
}

export class PreflightService {
  readonly #adapters: readonly AgentAdapter[];
  readonly #nodeVersion: string;

  public constructor(adapters: readonly AgentAdapter[], nodeVersion = process.versions.node) {
    this.#adapters = adapters;
    this.#nodeVersion = nodeVersion;
  }

  public async run(): Promise<PreflightReport> {
    const major = Number.parseInt(this.#nodeVersion.split(".")[0] ?? "0", 10);
    const nodeOk = major >= 20;
    const providers = await Promise.all(this.#adapters.map(async (adapter): Promise<ProviderPreflight> => {
      try {
        return await adapter.preflight();
      } catch (error) {
        const capabilities = await adapter.capabilities().catch(() => ({ provider: "unknown" }));
        return {
          provider: capabilities.provider,
          executable: false,
          diagnostics: [{
            level: "error",
            code: "provider.preflight_crashed",
            message: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    }));
    const anyProvider = providers.some((provider) => provider.executable);
    return {
      canStart: nodeOk && anyProvider,
      essential: [{
        name: "node",
        ok: nodeOk,
        message: nodeOk ? `Node ${this.#nodeVersion} detected` : `Node 20+ required; found ${this.#nodeVersion}`,
      }],
      providers,
      upcoming: ["claude", "cursor-agent", "opencode"],
    };
  }
}
