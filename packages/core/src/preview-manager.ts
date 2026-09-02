import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketStatus } from "./domain.js";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";
import type { TicketRepository } from "./ticket-repository.js";

const previewWorkspaceStatuses = new Set<TicketStatus>(["RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"]);

export interface PreviewDescriptor {
  readonly source: "base" | "ticket";
  readonly ticketId: string | null;
  readonly root: string;
  readonly mode: "live" | "diagnostic";
  readonly command: readonly string[] | null;
  readonly url: string | null;
}

export interface PreviewStatus extends PreviewDescriptor {
  readonly running: boolean;
  readonly logs: string;
  readonly diagnostic: string;
}

export class PreviewManager {
  readonly #repository: TicketRepository;
  readonly #projectRoot: string;
  readonly #runner: ProcessRunner;
  readonly #port: number;
  #process: ChildProcess | null = null;
  #descriptor: PreviewDescriptor | null = null;
  #logs = "";

  public constructor(
    repository: TicketRepository,
    projectRoot: string,
    runner: ProcessRunner = new NodeProcessRunner(),
    port = 4320,
  ) {
    this.#repository = repository;
    this.#projectRoot = projectRoot;
    this.#runner = runner;
    this.#port = port;
  }

  public async describe(ticketId?: string): Promise<PreviewDescriptor> {
    const ticket = ticketId === undefined ? null : this.#repository.get(ticketId);
    const useTicket = ticket !== null
      && previewWorkspaceStatuses.has(ticket.status)
      && ticket.workspace !== null;
    const root = useTicket ? ticket.workspace as string : this.#projectRoot;
    const command = await detectPreviewCommand(root);
    return {
      source: useTicket ? "ticket" : "base",
      ticketId: useTicket ? ticket.id : null,
      root,
      mode: command === null ? "diagnostic" : "live",
      command,
      url: command === null ? null : `http://127.0.0.1:${this.#port}`,
    };
  }

  public async start(ticketId?: string): Promise<PreviewStatus> {
    this.stop();
    const descriptor = await this.describe(ticketId);
    this.#descriptor = descriptor;
    this.#logs = "";
    if (descriptor.command !== null) {
      const [command, ...args] = descriptor.command;
      if (command === undefined) throw new Error("Invalid preview command");
      const executable = process.platform === "win32" && ["pnpm", "npm", "yarn", "bun"].includes(command)
        ? `${command}.cmd`
        : command;
      const child = spawn(executable, args, {
        cwd: descriptor.root,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: String(this.#port) },
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.#appendLog(chunk));
      child.stderr.on("data", (chunk: string) => this.#appendLog(chunk));
      child.on("error", (error) => this.#appendLog(`${error.message}\n`));
      child.once("close", () => {
        if (this.#process === child) this.#process = null;
      });
      this.#process = child;
    }
    return await this.status();
  }

  public stop(): void {
    this.#process?.kill();
    this.#process = null;
  }

  public async status(ticketId?: string): Promise<PreviewStatus> {
    const descriptor = this.#descriptor ?? await this.describe(ticketId);
    const diagnostic = descriptor.mode === "diagnostic" ? await this.#gitDiagnostic(descriptor.root) : "";
    return {
      ...descriptor,
      running: this.#process !== null,
      logs: this.#logs,
      diagnostic,
    };
  }

  async #gitDiagnostic(root: string): Promise<string> {
    try {
      const [status, log] = await Promise.all([
        this.#runner.run("git", ["status", "--short", "--branch"], { cwd: root, timeoutMs: 10_000 }),
        this.#runner.run("git", ["log", "-5", "--oneline", "--decorate"], { cwd: root, timeoutMs: 10_000 }),
      ]);
      return `${status.stdout.trim()}\n\n${log.stdout.trim()}`.trim();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  #appendLog(chunk: string): void {
    this.#logs = `${this.#logs}${chunk}`.slice(-32_000);
  }
}

async function detectPreviewCommand(root: string): Promise<readonly string[] | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;
  const scripts = (manifest as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;
  const command = typeof (scripts as Record<string, unknown>).dev === "string"
    ? "dev"
    : typeof (scripts as Record<string, unknown>).start === "string" ? "start" : null;
  if (command === null) return null;
  const manager = await packageManager(root, (manifest as Record<string, unknown>).packageManager);
  return manager === "npm" ? ["npm", "run", command] : [manager, "run", command];
}

async function packageManager(root: string, declared: unknown): Promise<"pnpm" | "npm" | "yarn" | "bun"> {
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
  }
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    try {
      await access(join(root, file));
      return manager;
    } catch {
      continue;
    }
  }
  return "npm";
}
