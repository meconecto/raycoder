import { describe, expect, it } from "vitest";
import type { AgentAdapter, ProviderPreflight } from "../src/agent-adapter.js";
import { CodexPreflight, type RuntimePathResolver } from "../src/codex-preflight.js";
import { PreflightService } from "../src/preflight.js";
import type { ProcessResult, ProcessRunner } from "../src/process.js";

class FixtureRunner implements ProcessRunner {
  readonly #authentication: string;

  public constructor(authentication: string) {
    this.#authentication = authentication;
  }

  public async run(command: string, args: readonly string[], options: { cwd: string }): Promise<ProcessResult> {
    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: 0,
      stdout: args[0] === "--version" ? "codex-cli 0.152.1\n" : this.#authentication,
      stderr: "",
    };
  }
}

function adapter(preflight: ProviderPreflight): AgentAdapter {
  return {
    async capabilities() {
      return { provider: preflight.provider, cancellation: false, resumableSessions: false, nativeSkills: false, sandboxModes: [], models: [] };
    },
    async preflight() { return preflight; },
    async startSession() { throw new Error("unused"); },
    async *send() { yield* []; },
    async cancel() { return; },
  };
}

describe("Codex preflight", () => {
  it("checks the SDK runtime and ChatGPT authentication without running a model", async () => {
    const runtime: RuntimePathResolver = { async resolve() { return "C:\\codex.exe"; } };
    const result = await new CodexPreflight(new FixtureRunner("Logged in using ChatGPT\n"), runtime).check();
    expect(result.executable).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["codex.runtime", "codex.chatgpt_auth"]);
  });

  it("returns an actionable diagnostic instead of crashing when the runtime is absent", async () => {
    const runtime: RuntimePathResolver = { async resolve() { throw new Error("runtime missing"); } };
    const result = await new CodexPreflight(new FixtureRunner(""), runtime).check();
    expect(result).toMatchObject({ provider: "codex", executable: false });
    expect(result.diagnostics[0]).toMatchObject({ code: "codex.runtime_unavailable" });
  });
});

describe("preflight aggregation", () => {
  it("blocks on an essential requirement or when no included provider is executable", async () => {
    const unavailable = adapter({ provider: "codex", executable: false, diagnostics: [] });
    expect((await new PreflightService([unavailable], "24.20.0").run()).canStart).toBe(false);
    const available = adapter({ provider: "codex", executable: true, diagnostics: [] });
    expect((await new PreflightService([available], "22.23.2").run()).canStart).toBe(false);
  });

  it("does not let an unavailable individual provider block another executable provider", async () => {
    const report = await new PreflightService([
      adapter({ provider: "codex", executable: false, diagnostics: [] }),
      adapter({ provider: "future-test-provider", executable: true, diagnostics: [] }),
    ], "24.20.0").run();
    expect(report.canStart).toBe(true);
    expect(report.upcoming).toEqual(["claude", "cursor-agent", "opencode"]);
  });
});
