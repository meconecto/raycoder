import type { AgentAdapter, ProviderPreflight } from "./agent-adapter.js";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";

export interface ToolPreflightDiagnostic {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface PreflightReport {
  /** Whether the local control-plane UI can start. */
  readonly canServe: boolean;
  /** Whether at least one included provider can execute agents. */
  readonly canExecute: boolean;
  /** @deprecated Use canExecute. Retained for RC2 API compatibility. */
  readonly canStart: boolean;
  readonly essential: readonly {
    name: string;
    ok: boolean;
    message: string;
  }[];
  readonly tools: readonly ToolPreflightDiagnostic[];
  readonly providers: readonly ProviderPreflight[];
  readonly upcoming: readonly string[];
}

export class PreflightService {
  readonly #adapters: readonly AgentAdapter[];
  readonly #nodeVersion: string;
  readonly #runner: ProcessRunner;

  public constructor(
    adapters: readonly AgentAdapter[],
    nodeVersion = process.versions.node,
    runner: ProcessRunner = new NodeProcessRunner(),
  ) {
    this.#adapters = adapters;
    this.#nodeVersion = nodeVersion;
    this.#runner = runner;
  }

  public async run(): Promise<PreflightReport> {
    const major = Number.parseInt(this.#nodeVersion.split(".")[0] ?? "0", 10);
    const nodeOk = major >= 24;
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
    const git = await this.#gitDiagnostic();
    const canServe = nodeOk;
    const canExecute = canServe && anyProvider;
    return {
      canServe,
      canExecute,
      canStart: canExecute,
      essential: [{
        name: "node",
        ok: nodeOk,
        message: nodeOk ? `Node ${this.#nodeVersion} detected` : `Node 24+ required; found ${this.#nodeVersion}`,
      }],
      tools: [git],
      providers,
      upcoming: ["claude", "cursor-agent", "opencode"],
    };
  }

  async #gitDiagnostic(): Promise<ToolPreflightDiagnostic> {
    try {
      const result = await this.#runner.run("git", ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
      return { name: "git", ok: true, message: result.stdout.trim() || "Git detected" };
    } catch (error) {
      return {
        name: "git",
        ok: false,
        message: `Git is required to open projects: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
