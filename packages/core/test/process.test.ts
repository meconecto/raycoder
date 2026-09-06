import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeProcessRunner, ProcessExecutionError } from "../src/process.js";

describe("NodeProcessRunner", () => {
  it("uses an exact supplied environment and bounds captured output", async () => {
    process.env.RAYCODER_RUNNER_SECRET = "must-not-leak";
    try {
      const result = await new NodeProcessRunner().run(process.execPath, [
        "-e",
        "process.stdout.write(String(process.env.RAYCODER_RUNNER_SECRET)); process.stdout.write('x'.repeat(10000))",
      ], { cwd: tmpdir(), env: {}, maxOutputBytes: 128 });

      expect(result.stdout).not.toContain("must-not-leak");
      expect(result.stdout).toContain("[output truncated]");
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(160);
    } finally {
      delete process.env.RAYCODER_RUNNER_SECRET;
    }
  });

  it("aborts the exact spawned operation and reports cancellation", async () => {
    const controller = new AbortController();
    let processId = 0;
    const running = new NodeProcessRunner().run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: tmpdir(),
      signal: controller.signal,
      onSpawn: (pid) => { processId = pid; controller.abort(); },
    });

    await expect(running).rejects.toSatisfy((error: unknown) =>
      error instanceof ProcessExecutionError && error.result.stderr.includes("Process cancelled"));
    expect(processId).toBeGreaterThan(0);
  });

  it("runs Windows package-manager CMD shims through an explicit interpreter without enabling shell mode", async () => {
    if (process.platform !== "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "raycoder-cmd-runner-"));
    try {
      const shimDirectory = join(directory, "batch shims");
      mkdirSync(shimDirectory);
      const launcher = join(shimDirectory, "fixture-runner.cmd");
      writeFileSync(
        launcher,
        `@"${process.execPath}" -e "process.stdout.write(process.argv[1])" %1\r\n`,
        "utf8",
      );
      const environment = {
        ...process.env,
        PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ""}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      };
      const runner = new NodeProcessRunner();

      const result = await runner.run("fixture-runner", ["literal two words"], { cwd: directory, env: environment });

      expect(result.stdout).toBe("literal two words");
      await expect(runner.run("fixture-runner", ["unsafe & injected"], { cwd: directory, env: environment }))
        .rejects.toThrow("unsupported command characters");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
