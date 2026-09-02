import type { ProviderPreflight } from "./agent-adapter.js";
import { resolveCodexRuntimePath } from "./codex-runtime.js";
import { NodeProcessRunner, ProcessExecutionError, type ProcessRunner } from "./process.js";

export interface RuntimePathResolver {
  resolve(): Promise<string>;
}

export class CodexPreflight {
  readonly #runner: ProcessRunner;
  readonly #runtime: RuntimePathResolver;

  public constructor(
    runner: ProcessRunner = new NodeProcessRunner(),
    runtime: RuntimePathResolver = { resolve: resolveCodexRuntimePath },
  ) {
    this.#runner = runner;
    this.#runtime = runtime;
  }

  public async check(): Promise<ProviderPreflight> {
    let path: string;
    try {
      path = await this.#runtime.resolve();
      const version = await this.#runner.run(path, ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
      const authentication = await this.#runner.run(path, ["login", "status"], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      const authText = `${authentication.stdout}\n${authentication.stderr}`.trim();
      if (!/chatgpt/iu.test(authText)) {
        return {
          provider: "codex",
          executable: false,
          diagnostics: [
            { level: "ok", code: "codex.runtime", message: version.stdout.trim() || "Official Codex runtime available" },
            {
              level: "error",
              code: "codex.chatgpt_auth_required",
              message: `Codex is authenticated, but not with an active ChatGPT session (${authText || "method unknown"})`,
              action: "Run `codex login` and choose ChatGPT authentication",
            },
          ],
        };
      }
      return {
        provider: "codex",
        executable: true,
        diagnostics: [
          { level: "ok", code: "codex.runtime", message: version.stdout.trim() || "Official Codex runtime available" },
          { level: "ok", code: "codex.chatgpt_auth", message: authText || "Active ChatGPT session detected" },
        ],
      };
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        return {
          provider: "codex",
          executable: false,
          diagnostics: [
            {
              level: "error",
              code: error.result.args[0] === "login" ? "codex.not_authenticated" : "codex.runtime_unavailable",
              message: (error.result.stderr || error.result.stdout || error.message).trim(),
              action: error.result.args[0] === "login" ? "Run `codex login`" : "Reinstall raycoder so the official Codex runtime is present",
            },
          ],
        };
      }
      return {
        provider: "codex",
        executable: false,
        diagnostics: [
          {
            level: "error",
            code: "codex.runtime_unavailable",
            message: error instanceof Error ? error.message : String(error),
            action: "Reinstall raycoder so the official Codex runtime is present",
          },
        ],
      };
    }
  }
}
