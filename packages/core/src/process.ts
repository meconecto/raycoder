import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ProcessExecutionError extends Error {
  public readonly result: ProcessResult;

  public constructor(result: ProcessResult) {
    super(`${result.command} ${result.args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
    this.name = "ProcessExecutionError";
    this.result = result;
  }
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number }): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs?: number },
  ): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);

      const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs);

      child.on("close", (exitCode) => {
        if (timeout !== undefined) clearTimeout(timeout);
        const result: ProcessResult = {
          command,
          args,
          cwd: options.cwd,
          exitCode: exitCode ?? -1,
          stdout,
          stderr: timedOut ? `${stderr}\nProcess timed out after ${options.timeoutMs}ms` : stderr,
        };
        if (result.exitCode === 0 && !timedOut) resolve(result);
        else reject(new ProcessExecutionError(result));
      });
    });
  }
}
