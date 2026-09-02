import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessExecutionError, type ProcessResult, type ProcessRunner } from "../src/process.js";
import { NodeProjectVerifier } from "../src/project-verifier.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("NodeProjectVerifier", () => {
  it("uses verify exclusively when present", async () => {
    const directory = fixture({ verify: "pnpm test && pnpm build", test: "vitest" }, "pnpm-lock.yaml");
    const runner = new RecordingRunner();

    const result = await new NodeProjectVerifier(runner).verify(directory);

    expect(result.status).toBe("PASSED");
    expect(result.commands).toEqual(["pnpm install --frozen-lockfile", "pnpm run verify"]);
    expect(runner.commands).toEqual(result.commands);
  });

  it("runs available fallback scripts in the fixed order", async () => {
    const directory = fixture({ build: "tsc", test: "vitest", lint: "eslint ." }, "package-lock.json");
    const runner = new RecordingRunner();

    const result = await new NodeProjectVerifier(runner).verify(directory);

    expect(result.commands).toEqual(["npm ci", "npm run lint", "npm run test", "npm run build"]);
  });

  it("reports ambiguous lockfiles and placeholder tests as unavailable", async () => {
    const ambiguous = fixture({ test: "vitest" }, "pnpm-lock.yaml");
    writeFileSync(join(ambiguous, "package-lock.json"), "{}", "utf8");
    expect(await new NodeProjectVerifier(new RecordingRunner()).verify(ambiguous)).toMatchObject({
      status: "UNAVAILABLE",
      diagnosticCode: "verification_lockfile_ambiguous",
    });

    const placeholder = fixture({ test: "echo \"Error: no test specified\" && exit 1" }, "package-lock.json");
    expect(await new NodeProjectVerifier(new RecordingRunner()).verify(placeholder)).toMatchObject({
      status: "UNAVAILABLE",
      diagnosticCode: "verification_placeholder_test",
    });
  });

  it("stops and records output when a verification command fails", async () => {
    const directory = fixture({ test: "vitest" }, "pnpm-lock.yaml");
    const runner = new RecordingRunner(1);

    const result = await new NodeProjectVerifier(runner).verify(directory);

    expect(result).toMatchObject({ status: "FAILED", diagnosticCode: "verification_failed" });
    expect(result.output).toContain("failed output");
  });
});

class RecordingRunner implements ProcessRunner {
  public readonly commands: string[] = [];

  public constructor(readonly failAt = -1) {}

  public async run(command: string, args: readonly string[], options: { cwd: string }): Promise<ProcessResult> {
    const display = [command, ...args].join(" ");
    this.commands.push(display);
    const result: ProcessResult = {
      command,
      args,
      cwd: options.cwd,
      exitCode: this.commands.length === this.failAt ? 1 : 0,
      stdout: this.commands.length === this.failAt ? "failed output" : "ok",
      stderr: "",
    };
    if (result.exitCode !== 0) throw new ProcessExecutionError(result);
    return result;
  }
}

function fixture(scripts: Record<string, string>, lockfile: string): string {
  const directory = mkdtempSync(join(tmpdir(), "raycoder-verifier-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts }), "utf8");
  writeFileSync(join(directory, lockfile), "", "utf8");
  return directory;
}
