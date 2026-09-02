import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService, MemorySetupConfirmationError } from "../src/memory-service.js";
import type { ProcessResult, ProcessRunner } from "../src/process.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class EngramRunner implements ProcessRunner {
  public readonly calls: string[] = [];
  public async run(command: string, args: readonly string[], options: { cwd: string }): Promise<ProcessResult> {
    this.calls.push([command, ...args].join(" "));
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: "engram 1.0\n", stderr: "" };
  }
}

describe("MemoryService", () => {
  it("checks the Engram runtime and Codex MCP configuration without mutating it", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-engram-"));
    temporaryDirectories.push(root);
    const config = join(root, "config.toml");
    writeFileSync(config, '[mcp_servers.engram]\ncommand = "engram"\nargs = ["mcp"]\n');
    const runner = new EngramRunner();
    const memory = new MemoryService(runner, config);
    expect(await memory.preflight(root)).toMatchObject({ available: true, configuredForCodex: true });
    expect(runner.calls).toEqual(["engram --version"]);
    expect(memory.connection("project-a", root).contextInstruction).toContain("project-a");
  });

  it("requires confirmation before running Engram setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-engram-"));
    temporaryDirectories.push(root);
    const runner = new EngramRunner();
    const memory = new MemoryService(runner, join(root, "missing.toml"));
    await expect(memory.configureCodex(false, root)).rejects.toBeInstanceOf(MemorySetupConfirmationError);
    expect(runner.calls).toEqual([]);
  });
});
