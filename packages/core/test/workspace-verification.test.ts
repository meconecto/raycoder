import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTicket } from "../src/domain.js";
import { NodeProcessRunner, ProcessExecutionError, type ProcessResult, type ProcessRunner } from "../src/process.js";
import { TicketRepository } from "../src/ticket-repository.js";
import { WorkspaceVerificationService } from "../src/workspace-verification.js";

const roots: string[] = [];
const git = new NodeProcessRunner();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceVerificationService", () => {
  it("persists approval, runs a Node convention and reuses the passed attempt", async () => {
    const root = await nodeFixture();
    const repository = repositoryWithTicket("node");
    const runner = new VerificationRunner();
    const service = new WorkspaceVerificationService(repository, runner);
    const plan = await service.inspect(root);

    await expect(service.verify({ ticketId: "node", workspace: root, targetCommit: "commit" }))
      .rejects.toMatchObject({ code: "verification.approval_required" });
    expect(repository.latestWorkspaceVerificationAttempt("node")).toMatchObject({ status: "AWAITING_APPROVAL" });

    const passed = await service.verify({
      ticketId: "node", workspace: root, targetCommit: "commit",
      approval: { fingerprint: plan.fingerprint, allowVerification: true, rememberForProject: true },
    });
    expect(passed).toMatchObject({ status: "PASSED", fingerprint: plan.fingerprint });
    expect(runner.commands).toEqual(["pnpm run verify"]);
    expect(await service.verify({ ticketId: "node", workspace: root, targetCommit: "commit" })).toMatchObject({ id: passed.id });
    repository.close();
  });

  it.each([
    ["uv", "uv run --locked pytest"],
    ["poetry", "poetry run pytest"],
    ["pipenv", "pipenv run pytest"],
    ["cargo", "cargo test --locked"],
    ["go", "go test ./..."],
  ] as const)("builds the %s convention without shell interpolation", async (strategy, display) => {
    const root = await nodeFixture();
    for (const [path, contents] of Object.entries({
      "pyproject.toml": "[project]\nname='fixture'\nversion='0.0.0'\n",
      "uv.lock": "version = 1\n", "poetry.lock": "# lock\n", Pipfile: "[packages]\n", "Pipfile.lock": "{}\n",
      "Cargo.toml": "[package]\nname='fixture'\nversion='0.0.0'\n", "Cargo.lock": "version = 4\n",
      "go.mod": "module example.test/fixture\n\ngo 1.24\n", "go.sum": "",
    })) writeFileSync(join(root, path), contents, "utf8");
    const repository = new TicketRepository(":memory:");
    const service = new WorkspaceVerificationService(repository, new VerificationRunner());
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy }] });
    expect((await service.inspect(root)).units[0]?.commands[0]?.display).toBe(display);
    repository.close();
  });

  it("rejects ambiguous roots and supports ordered multistack units", async () => {
    const root = await nodeFixture();
    writeFileSync(join(root, "go.mod"), "module example.test/fixture\n\ngo 1.24\n", "utf8");
    const repository = new TicketRepository(":memory:");
    const service = new WorkspaceVerificationService(repository, new VerificationRunner());
    await expect(service.inspect(root)).rejects.toMatchObject({ code: "verification.strategy_ambiguous" });
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy: "pnpm" }, { root: ".", strategy: "go" }] });
    expect((await service.inspect(root)).units.map((unit) => unit.strategy)).toEqual(["pnpm", "go"]);
    repository.close();
  });

  it("invalidates approval after a relevant input changes", async () => {
    const root = await nodeFixture();
    const repository = repositoryWithTicket("changed");
    const service = new WorkspaceVerificationService(repository, new VerificationRunner());
    const first = await service.inspect(root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nchanged: true\n", "utf8");
    const second = await service.inspect(root);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    await expect(service.verify({
      ticketId: "changed", workspace: root, targetCommit: "new",
      approval: { fingerprint: first.fingerprint, allowVerification: true, rememberForProject: true },
    })).rejects.toMatchObject({ code: "verification.plan_changed" });
    repository.close();
  });

  it("requires tracked contained scripts and preserves literal arguments", async () => {
    const root = await nodeFixture();
    writeFileSync(join(root, "verify.ps1"), "exit 0\n", "utf8");
    await git.run("git", ["add", "verify.ps1"], { cwd: root });
    await git.run("git", ["commit", "-m", "test: verification script"], { cwd: root });
    const repository = new TicketRepository(":memory:");
    const service = new WorkspaceVerificationService(repository, new VerificationRunner());
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy: "pwsh", script: "verify.ps1", args: ["$(touch nope)", "two words"] }] });
    expect((await service.inspect(root)).units[0]?.commands[0]).toMatchObject({
      executable: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "verify.ps1", "$(touch nope)", "two words"],
    });
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy: "bash", script: "untracked.sh" }] });
    writeFileSync(join(root, "untracked.sh"), "exit 0\n", "utf8");
    await expect(service.inspect(root)).rejects.toMatchObject({ code: "verification.custom_step_invalid" });
    repository.close();
  });

  it("blocks on failure, sanitizes output and records recovery", async () => {
    const root = await nodeFixture();
    const repository = repositoryWithTicket("failed");
    const runner = new VerificationRunner({ fail: true });
    const service = new WorkspaceVerificationService(repository, runner);
    const plan = await service.inspect(root);
    await expect(service.verify({
      ticketId: "failed", workspace: root, targetCommit: "commit",
      approval: { fingerprint: plan.fingerprint, allowVerification: true, rememberForProject: true },
    })).rejects.toMatchObject({ code: "verification.failed" });
    expect(repository.get("failed")).toMatchObject({ status: "BLOCKED", blockedFrom: "READY" });
    expect(repository.latestWorkspaceVerificationAttempt("failed")).toMatchObject({ status: "FAILED" });

    repository.resolveBlocked("failed", "test", "READY");
    const interrupted = repository.createWorkspaceVerificationAttempt({
      id: "uncertain", ticketId: "failed", purpose: "dispatch", status: "VERIFYING", strategy: "pnpm",
      fingerprint: plan.fingerprint, plan, workspace: root, targetCommit: "commit",
    });
    expect(service.recoverInterrupted()).toMatchObject([{ id: interrupted.id }]);
    expect(repository.getWorkspaceVerificationAttempt(interrupted.id)).toMatchObject({
      status: "INTERRUPTED", diagnosticCode: "verification.bootstrap_interrupted",
    });
    repository.close();
  });

  it("fails when verification changes a tracked file", async () => {
    const root = await nodeFixture();
    const repository = repositoryWithTicket("dirty-verification");
    const service = new WorkspaceVerificationService(repository, new VerificationRunner({ mutateTracked: true }));
    const plan = await service.inspect(root);

    await expect(service.verify({
      ticketId: "dirty-verification", workspace: root, targetCommit: "commit",
      approval: { fingerprint: plan.fingerprint, allowVerification: true, rememberForProject: true },
    })).rejects.toMatchObject({ code: "verification.tracked_files_changed" });
    expect(repository.latestWorkspaceVerificationAttempt("dirty-verification")).toMatchObject({
      status: "FAILED", diagnosticCode: "verification.tracked_files_changed",
    });
    expect(repository.get("dirty-verification")).toMatchObject({ status: "BLOCKED", blockedFrom: "READY" });
    repository.close();
  });

  it("cancels the exact active verification and leaves the ticket cancelled", async () => {
    const root = await nodeFixture();
    const repository = repositoryWithTicket("cancel-verification");
    const runner = new CancellableVerificationRunner();
    const service = new WorkspaceVerificationService(repository, runner);
    const plan = await service.inspect(root);
    const operation = service.verify({
      ticketId: "cancel-verification", workspace: root, targetCommit: "commit",
      approval: { fingerprint: plan.fingerprint, allowVerification: true, rememberForProject: true },
    });
    await runner.started;

    expect(await service.cancel("cancel-verification")).toBe(true);
    await expect(operation).rejects.toMatchObject({ code: "verification.cancelled" });
    expect(repository.latestWorkspaceVerificationAttempt("cancel-verification")).toMatchObject({ status: "CANCELLED" });
    expect(repository.get("cancel-verification").status).toBe("CANCELLED");
    repository.close();
  });
});

class VerificationRunner implements ProcessRunner {
  readonly commands: string[] = [];
  readonly #fail: boolean;
  readonly #mutateTracked: boolean;

  public constructor(options: { fail?: boolean; mutateTracked?: boolean } = {}) {
    this.#fail = options.fail ?? false;
    this.#mutateTracked = options.mutateTracked ?? false;
  }

  public async run(command: string, args: readonly string[], options: Parameters<ProcessRunner["run"]>[2]): Promise<ProcessResult> {
    if (command === "git") return await git.run(command, args, options);
    if (args.includes("--version") || args[0] === "version") return result(command, args, `${command} 1.0.0\n`);
    this.commands.push([command, ...args].join(" "));
    options.onSpawn?.(12345);
    if (this.#mutateTracked) appendFileSync(join(options.cwd, "package.json"), "\n", "utf8");
    if (this.#fail) {
      throw new ProcessExecutionError(result(command, args, "", "token npm_abcdefghijklmnop failed\n", 1));
    }
    return result(command, args, "verified\n");
  }
}

class CancellableVerificationRunner implements ProcessRunner {
  public readonly started: Promise<void>;
  readonly #markStarted: () => void;

  public constructor() {
    let markStarted = () => {};
    this.started = new Promise<void>((resolve) => { markStarted = resolve; });
    this.#markStarted = markStarted;
  }

  public async run(command: string, args: readonly string[], options: Parameters<ProcessRunner["run"]>[2]): Promise<ProcessResult> {
    if (command === "git") return await git.run(command, args, options);
    if (args.includes("--version")) return result(command, args, `${command} 1.0.0\n`);
    options.onSpawn?.(23456);
    this.#markStarted();
    return await new Promise<ProcessResult>((_resolve, reject) => {
      const abort = () => reject(new Error("cancelled by test"));
      if (options.signal?.aborted === true) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function result(command: string, args: readonly string[], stdout = "", stderr = "", exitCode = 0): ProcessResult {
  return { command, args, cwd: "", exitCode, signal: null, stdout, stderr, durationMs: 1 };
}

function repositoryWithTicket(id: string): TicketRepository {
  const repository = new TicketRepository(":memory:");
  repository.create(createTicket({ id, title: id, description: "test", baseBranch: "main", hasPredecessors: false }));
  return repository;
}

async function nodeFixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "raycoder-verification-"));
  roots.push(root);
  await git.run("git", ["init", "-b", "main"], { cwd: root });
  await git.run("git", ["config", "user.name", "raycoder tests"], { cwd: root });
  await git.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { verify: "node -e pass" } }), "utf8");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await git.run("git", ["add", "."], { cwd: root });
  await git.run("git", ["commit", "-m", "test: fixture"], { cwd: root });
  return root;
}
