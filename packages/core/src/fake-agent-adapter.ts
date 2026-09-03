import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ProviderPreflight,
  StartSessionInput,
} from "./agent-adapter.js";
import { isPathInside } from "./git-workspace.js";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";

interface FakeSessionState {
  readonly workspace: string;
  readonly purpose: "implementation" | "review" | "planning";
  turn: number;
  cancelled: boolean;
  readonly implementationNumber: number;
}

export interface FakeAdapterOptions {
  readonly fileName?: string;
  readonly contents?: string;
  readonly commitMessage?: string;
  readonly failAtTurn?: number;
  readonly reviewVerdict?: "approved" | "changes_requested";
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly #sessions = new Map<string, FakeSessionState>();
  readonly #runner: ProcessRunner;
  readonly #options: Required<Omit<FakeAdapterOptions, "failAtTurn">> & Pick<FakeAdapterOptions, "failAtTurn">;
  #implementationCount = 0;

  public constructor(options: FakeAdapterOptions = {}, runner: ProcessRunner = new NodeProcessRunner()) {
    this.#runner = runner;
    this.#options = {
      fileName: options.fileName ?? "raycoder-demo.txt",
      contents: options.contents ?? "created deterministically by the raycoder fake adapter\n",
      commitMessage: options.commitMessage ?? "test: fake agent change",
      reviewVerdict: options.reviewVerdict ?? "approved",
      ...(options.failAtTurn === undefined ? {} : { failAtTurn: options.failAtTurn }),
    };
  }

  public async capabilities(): Promise<AdapterCapabilities> {
    return {
      provider: "fake",
      cancellation: true,
      resumableSessions: false,
      nativeSkills: false,
      sandboxModes: ["workspace-write"],
      models: [{ id: "deterministic", efforts: null }],
    };
  }

  public async preflight(): Promise<ProviderPreflight> {
    return {
      provider: "fake",
      executable: true,
      diagnostics: [{ level: "ok", code: "fake.ready", message: "Deterministic fake adapter ready" }],
    };
  }

  public async startSession(input: StartSessionInput): Promise<AgentSession> {
    const id = randomUUID();
    const purpose = input.purpose ?? "implementation";
    const implementationNumber = purpose === "implementation" ? ++this.#implementationCount : this.#implementationCount;
    this.#sessions.set(id, {
      workspace: resolve(input.workspace),
      purpose,
      turn: 0,
      cancelled: false,
      implementationNumber,
    });
    return { id, provider: "fake", providerSessionId: `fake-${id}` };
  }

  public async *send(session: AgentSession, prompt: string): AsyncIterable<AgentEvent> {
    const state = this.#sessions.get(session.id);
    if (state === undefined) throw new Error(`Unknown fake session: ${session.id}`);
    const timestamp = (): string => new Date().toISOString();

    if (state.cancelled) {
      yield { type: "error", timestamp: timestamp(), message: "Session cancelled", code: "cancelled", recoverable: false };
      yield { type: "completed", timestamp: timestamp(), success: false, summary: "cancelled" };
      return;
    }

    yield { type: "assistant_message", timestamp: timestamp(), text: `Fake turn ${state.turn + 1}: ${prompt}` };
    if (this.#options.failAtTurn === state.turn) {
      state.turn += 1;
      yield { type: "error", timestamp: timestamp(), message: "Scripted fake failure", code: "fake.failure", recoverable: false };
      yield { type: "completed", timestamp: timestamp(), success: false, summary: "scripted failure" };
      return;
    }

    if (state.turn === 0 && state.purpose === "implementation") {
      const filePath = resolve(state.workspace, this.#options.fileName);
      if (!isPathInside(state.workspace, filePath)) throw new Error("Fake adapter file escaped its workspace");
      yield { type: "tool_call", timestamp: timestamp(), callId: "fake-write", name: "write_file", input: { path: filePath } };
      const contents = state.implementationNumber === 1
        ? this.#options.contents
        : `${this.#options.contents.trimEnd()}\nimplementation ${state.implementationNumber}\n`;
      await writeFile(filePath, contents, "utf8");
      yield { type: "file_change", timestamp: timestamp(), paths: [filePath], summary: "deterministic fixture change" };
      await this.#runner.run("git", ["add", "--", this.#options.fileName], { cwd: state.workspace });
      const commit = await this.#runner.run("git", [
        "-c",
        "user.name=raycoder",
        "-c",
        "user.email=raycoder@local.invalid",
        "commit",
        "-m",
        this.#options.commitMessage,
      ], { cwd: state.workspace });
      yield {
        type: "command",
        timestamp: timestamp(),
        command: `git commit -m ${this.#options.commitMessage}`,
        cwd: state.workspace,
        exitCode: commit.exitCode,
        output: commit.stdout,
      };
      yield { type: "tool_result", timestamp: timestamp(), callId: "fake-write", success: true, output: join(state.workspace, this.#options.fileName) };
    }

    if (state.purpose === "review") {
      yield {
        type: "review_decision",
        timestamp: timestamp(),
        verdict: this.#options.reviewVerdict,
        summary: this.#options.reviewVerdict === "approved" ? "Deterministic review passed" : "Deterministic review requested changes",
        findings: this.#options.reviewVerdict === "approved" ? [] : ["Scripted review finding"],
      };
    }

    state.turn += 1;
    yield { type: "completed", timestamp: timestamp(), success: true, summary: state.turn === 1 ? "implemented" : "review approved" };
  }

  public async cancel(session: AgentSession): Promise<void> {
    const state = this.#sessions.get(session.id);
    if (state === undefined) throw new Error(`Unknown fake session: ${session.id}`);
    state.cancelled = true;
  }
}
