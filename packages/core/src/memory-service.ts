import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";

export interface MemoryPreflight {
  readonly available: boolean;
  readonly configuredForCodex: boolean;
  readonly diagnostics: readonly {
    readonly level: "ok" | "warning" | "error";
    readonly code: string;
    readonly message: string;
    readonly action?: string;
  }[];
}

export interface MemoryConnection {
  readonly command: "engram";
  readonly args: readonly ["mcp"];
  readonly projectIdentity: string;
  readonly projectRoot: string;
  readonly contextInstruction: string;
}

export class MemorySetupConfirmationError extends Error {
  public constructor() {
    super("Configuring Engram for Codex requires explicit confirmation");
    this.name = "MemorySetupConfirmationError";
  }
}

export class MemoryService {
  readonly #runner: ProcessRunner;
  readonly #codexConfigPath: string;

  public constructor(
    runner: ProcessRunner = new NodeProcessRunner(),
    codexConfigPath = defaultCodexConfigPath(),
  ) {
    this.#runner = runner;
    this.#codexConfigPath = resolve(codexConfigPath);
  }

  public connection(projectIdentity: string, projectRoot: string): MemoryConnection {
    return {
      command: "engram",
      args: ["mcp"],
      projectIdentity,
      projectRoot: resolve(projectRoot),
      contextInstruction: `Treat durable memories tagged for raycoder project ${projectIdentity} as project-specific context for ${resolve(projectRoot)}.`,
    };
  }

  public async preflight(cwd = process.cwd()): Promise<MemoryPreflight> {
    const diagnostics: MemoryPreflight["diagnostics"][number][] = [];
    try {
      const version = await this.#runner.run("engram", ["--version"], { cwd, timeoutMs: 10_000 });
      diagnostics.push({ level: "ok", code: "engram.runtime", message: version.stdout.trim() || "Engram executable available" });
    } catch (error) {
      return {
        available: false,
        configuredForCodex: false,
        diagnostics: [{
          level: "warning",
          code: "engram.runtime_unavailable",
          message: error instanceof Error ? error.message : String(error),
          action: "Install Gentleman-Programming/engram, then run `engram setup codex`",
        }],
      };
    }
    let config = "";
    try {
      config = await readFile(this.#codexConfigPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const configured = /\[mcp_servers\.engram\][\s\S]*?command\s*=\s*["']engram["'][\s\S]*?args\s*=\s*\[[^\]]*["']mcp["']/u.test(config);
    diagnostics.push(configured
      ? { level: "ok", code: "engram.codex_configured", message: "Engram MCP is configured for Codex" }
      : {
          level: "warning",
          code: "engram.codex_not_configured",
          message: `Engram is installed but not configured in ${this.#codexConfigPath}`,
          action: "Run `engram setup codex`",
        });
    return { available: true, configuredForCodex: configured, diagnostics };
  }

  public async configureCodex(confirm: boolean, cwd = process.cwd()): Promise<MemoryPreflight> {
    if (!confirm) throw new MemorySetupConfirmationError();
    await this.#runner.run("engram", ["setup", "codex"], { cwd, timeoutMs: 60_000 });
    return await this.preflight(cwd);
  }
}

function defaultCodexConfigPath(): string {
  const appData = process.env.APPDATA;
  return process.platform === "win32" && appData !== undefined
    ? join(appData, "codex", "config.toml")
    : join(homedir(), ".codex", "config.toml");
}
