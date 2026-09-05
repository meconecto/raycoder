import { tmpdir } from "node:os";
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
});
