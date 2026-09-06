import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

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
    const environment = options.env === undefined ? process.env : options.env;
    const invocation = windowsBatchInvocation(command, args, environment);
    return await new Promise((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error("Process cancelled before it started"));
        return;
      }
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: environment,
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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

function windowsBatchInvocation(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== "win32") return { command, args: [...args], windowsVerbatimArguments: false };
  const batchPath = findWindowsBatch(command, environment);
  if (batchPath === null) return { command, args: [...args], windowsVerbatimArguments: false };
  if (/[\0\r\n"&|<>^%!()]/u.test(batchPath)) {
    throw new Error(`Windows batch launcher path contains unsupported command characters: ${batchPath}`);
  }
  for (const argument of args) {
    if (!/^[\p{L}\p{N} _.,:/@=+\-\\]*$/u.test(argument)) {
      throw new Error(`Windows batch launcher argument contains unsupported command characters: ${argument}`);
    }
  }
  const commandInterpreter = environmentValue(environment, "ComSpec") ?? "cmd.exe";
  const commandLine = `"${[batchPath, ...args].map((value) => `"${value}"`).join(" ")}"`;
  return {
    command: commandInterpreter,
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

function findWindowsBatch(
  command: string,
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): string | null {
  const extension = extname(command).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    if (isAbsolute(command) || /[\\/]/u.test(command)) return command;
  }
  if (isAbsolute(command) || /[\\/]/u.test(command)) return null;
  const pathValue = environmentValue(environment, "PATH") ?? "";
  const extensions = extension === ""
    ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of pathValue.split(delimiter).filter((entry) => entry !== "")) {
    for (const candidateExtension of extensions) {
      const candidate = join(directory, `${command}${candidateExtension}`);
      if (!existsSync(candidate)) continue;
      const candidateType = extname(candidate).toLowerCase();
      return candidateType === ".cmd" || candidateType === ".bat" ? candidate : null;
    }
  }
  return extension === ".cmd" || extension === ".bat" ? command : null;
}

function environmentValue(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const entry = Object.entries(environment).find(([key, value]) => key.toUpperCase() === name.toUpperCase() && value !== undefined);
  return entry?.[1];
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
