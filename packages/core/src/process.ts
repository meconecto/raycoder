import { spawn, type ChildProcess } from "node:child_process";

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
  run(command: string, args: readonly string[], options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Readonly<Record<string, string>>;
    maxOutputBytes?: number;
    onSpawn?: (processId: number) => void;
  }): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      env?: Readonly<Record<string, string>>;
      maxOutputBytes?: number;
      onSpawn?: (processId: number) => void;
    },
  ): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error("Process cancelled before it started"));
        return;
      }
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let forceKill: NodeJS.Timeout | undefined;
      const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk, maxOutputBytes);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk, maxOutputBytes);
      });
      child.on("error", reject);

      const abort = () => {
        terminateProcessTree(child, "SIGTERM");
        forceKill = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 5_000);
        forceKill.unref();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (child.pid !== undefined) options.onSpawn?.(child.pid);

      const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child, "SIGTERM");
            forceKill = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 5_000);
            forceKill.unref();
          }, options.timeoutMs);

      child.on("close", (exitCode) => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        options.signal?.removeEventListener("abort", abort);
        const result: ProcessResult = {
          command,
          args,
          cwd: options.cwd,
          exitCode: exitCode ?? -1,
          stdout,
          stderr: timedOut
            ? `${stderr}\nProcess timed out after ${options.timeoutMs}ms`
            : options.signal?.aborted === true ? `${stderr}\nProcess cancelled` : stderr,
        };
        if (result.exitCode === 0 && !timedOut) resolve(result);
        else reject(new ProcessExecutionError(result));
      });
    });
  }
}

function appendBounded(current: string, chunk: string, maximumBytes: number): string {
  if (Buffer.byteLength(current) >= maximumBytes) return current;
  const remaining = maximumBytes - Buffer.byteLength(current);
  const next = Buffer.from(chunk).subarray(0, remaining).toString("utf8");
  return `${current}${next}${Buffer.byteLength(chunk) > remaining ? "\n[output truncated]" : ""}`;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill(signal));
    killer.once("close", (exitCode) => {
      if (exitCode !== 0) child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
