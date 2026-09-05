import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentEvent, AgentSession, StartSessionInput } from "../src/agent-adapter.js";
import { createTicket } from "../src/domain.js";
import { Dispatcher } from "../src/dispatcher.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { GitWorkspaceManager } from "../src/git-workspace.js";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../src/process.js";
import { TicketRepository } from "../src/ticket-repository.js";
import { WorkspaceVerificationService } from "../src/workspace-verification.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

class RecordingAdapter implements AgentAdapter {
  public readonly starts: StartSessionInput[] = [];
  readonly #delegate = new FakeAgentAdapter();

  public capabilities() { return this.#delegate.capabilities(); }
  public preflight() { return this.#delegate.preflight(); }
  public startSession(input: StartSessionInput): Promise<AgentSession> {
    this.starts.push(input);
    return this.#delegate.startSession(input);
  }
  public send(session: AgentSession, prompt: string): AsyncIterable<AgentEvent> {
    return this.#delegate.send(session, prompt);
  }
  public cancel(session: AgentSession): Promise<void> { return this.#delegate.cancel(session); }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createRepository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "raycoder-dispatch-"));
  temporaryDirectories.push(directory);
  await runner.run("git", ["init", "-b", "main"], { cwd: directory });
  await runner.run("git", ["config", "user.name", "raycoder tests"], { cwd: directory });
  await runner.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: directory });
  writeFileSync(join(directory, "README.md"), "base\n", "utf8");
  await runner.run("git", ["add", "README.md"], { cwd: directory });
  await runner.run("git", ["commit", "-m", "test: base"], { cwd: directory });
  return directory;
}

describe("Dispatcher with deterministic adapter", () => {
  it("drives READY to READY_TO_MERGE and leaves a commit in the isolated workspace", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    repository.create(
      createTicket({
        id: "demo",
        title: "Demo",
        description: "Create a deterministic file",
        baseBranch: "main",
        hasPredecessors: false,
      }),
    );
    const adapter = new RecordingAdapter();
    const dispatcher = new Dispatcher(repository, new GitWorkspaceManager(), adapter);

    const result = await dispatcher.dispatch({ ticketId: "demo", projectRoot, dirtyPolicy: "cancel" });

    expect(result.status).toBe("READY_TO_MERGE");
    expect(result.workspace).not.toBeNull();
    expect(readFileSync(join(result.workspace ?? "", "raycoder-demo.txt"), "utf8")).toContain("deterministically");
    expect(await new GitWorkspaceManager().hasCommitSince(result.workspace ?? "", result.baseCommit ?? "")).toBe(true);
    expect(repository.history("demo").map((entry) => entry.toStatus)).toEqual([
      "READY",
      "RUNNING",
      "REVIEW",
      "READY_TO_MERGE",
    ]);
    expect(repository.history("demo").some((entry) => entry.toStatus === "DONE")).toBe(false);
    expect(adapter.starts[0]?.additionalWritableDirectories).toHaveLength(4);
    expect(adapter.starts[1]?.purpose).toBe("review");
    expect(adapter.starts[1]?.additionalWritableDirectories).toBeUndefined();
    repository.close();
  });

  it("owns failure transitions outside the adapter", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    repository.create(
      createTicket({ id: "failure", title: "Fail", description: "test", baseBranch: "main", hasPredecessors: false }),
    );
    const dispatcher = new Dispatcher(
      repository,
      new GitWorkspaceManager(),
      new FakeAgentAdapter({ failAtTurn: 0 }),
    );

    expect((await dispatcher.dispatch({ ticketId: "failure", projectRoot, dirtyPolicy: "cancel" })).status).toBe("FAILED");
    repository.close();
  });

  it("persists a structured independent review and resumes the same workspace after changes are requested", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({
      id: "reviewed",
      title: "Reviewed",
      description: "test review lifecycle",
      baseBranch: "main",
      hasPredecessors: false,
    }));
    const changesReviewer = new FakeAgentAdapter({ reviewVerdict: "changes_requested" });
    const implementation = new FakeAgentAdapter();
    const first = new Dispatcher(repository, new GitWorkspaceManager(), implementation, changesReviewer);

    const changes = await first.dispatch({ ticketId: "reviewed", projectRoot, dirtyPolicy: "cancel" });
    expect(changes.status).toBe("CHANGES_REQUESTED");
    expect(repository.reviewDecisions("reviewed")[0]).toMatchObject({
      verdict: "changes_requested",
      findings: ["Scripted review finding"],
    });
    const workspace = changes.workspace;

    const resumed = new Dispatcher(repository, new GitWorkspaceManager(), implementation, new FakeAgentAdapter());
    const approved = await resumed.dispatch({ ticketId: "reviewed", projectRoot, dirtyPolicy: "cancel" });
    expect(approved.status).toBe("READY_TO_MERGE");
    expect(approved.workspace).toBe(workspace);
    expect(repository.listAgentSessions("reviewed").map((session) => session.role)).toEqual([
      "implementation",
      "review",
      "implementation",
      "review",
    ]);
    repository.close();
  });

  it("supports self-review in the implementation thread", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({
      id: "self-review",
      title: "Self review",
      description: "review in one thread",
      baseBranch: "main",
      hasPredecessors: false,
    }));
    const adapter = new FakeAgentAdapter();
    const dispatcher = new Dispatcher(repository, new GitWorkspaceManager(), adapter, adapter, "self");

    expect((await dispatcher.dispatch({ ticketId: "self-review", projectRoot, dirtyPolicy: "cancel" })).status).toBe("READY_TO_MERGE");
    expect(repository.listAgentSessions("self-review")).toHaveLength(1);
    expect(repository.reviewDecisions("self-review")[0]?.verdict).toBe("approved");
    repository.close();
  });

  it("does not start the adapter before verification authorization and verifies before review", async () => {
    const projectRoot = await createRepository();
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ scripts: { verify: "fixture" } }), "utf8");
    writeFileSync(join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await runner.run("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: projectRoot });
    await runner.run("git", ["commit", "-m", "test: verification convention"], { cwd: projectRoot });
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "verified", title: "Verified", description: "gate review", baseBranch: "main", hasPredecessors: false }));
    const adapter = new RecordingAdapter();
    const verificationRunner = new DeterministicVerificationRunner();
    const verification = new WorkspaceVerificationService(repository, verificationRunner);
    const dispatcher = new Dispatcher(repository, new GitWorkspaceManager(), adapter, adapter, "independent", verification);

    await expect(dispatcher.dispatch({ ticketId: "verified", projectRoot, dirtyPolicy: "cancel" }))
      .rejects.toMatchObject({ code: "verification.approval_required" });
    expect(adapter.starts).toHaveLength(0);
    expect(repository.get("verified").status).toBe("READY");
    const fingerprint = repository.latestWorkspaceVerificationAttempt("verified")?.fingerprint;
    if (fingerprint === undefined) throw new Error("Expected verification fingerprint");

    const completed = await dispatcher.dispatch({
      ticketId: "verified", projectRoot, dirtyPolicy: "cancel",
      verificationApproval: { fingerprint, allowVerification: true, rememberForProject: true },
    });
    expect(completed.status).toBe("READY_TO_MERGE");
    expect(verificationRunner.verifications).toEqual(["pnpm run verify"]);
    expect(repository.latestWorkspaceVerificationAttempt("verified")).toMatchObject({ status: "PASSED" });
    expect(repository.history("verified").map((entry) => entry.toStatus)).toEqual(["READY", "RUNNING", "REVIEW", "READY_TO_MERGE"]);
    repository.close();
  });
});

class DeterministicVerificationRunner implements ProcessRunner {
  public readonly verifications: string[] = [];
  public async run(command: string, args: readonly string[], options: Parameters<ProcessRunner["run"]>[2]): Promise<ProcessResult> {
    if (command === "git") return await runner.run(command, args, options);
    if (args.includes("--version")) return { command, args, cwd: options.cwd, exitCode: 0, signal: null, stdout: `${command} 1.0.0\n`, stderr: "", durationMs: 1 };
    this.verifications.push([command, ...args].join(" "));
    return { command, args, cwd: options.cwd, exitCode: 0, signal: null, stdout: "verified\n", stderr: "", durationMs: 1 };
  }
}
