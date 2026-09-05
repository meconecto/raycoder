import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTicket } from "../src/domain.js";
import { GitWorkspaceManager } from "../src/git-workspace.js";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../src/process.js";
import { TicketRepository } from "../src/ticket-repository.js";
import { sanitizeOutput, WorkspacePreparationError, WorkspacePreparationService } from "../src/workspace-preparation.js";

const roots: string[] = [];
const git = new NodeProcessRunner();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspacePreparationService", () => {
  it("persists approval before preparing and reuses it for the project", async () => {
    const root = await fixture();
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "one", title: "One", description: "test", baseBranch: "main", hasPredecessors: false }));
    const runner = new DependencyRunner();
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(runner), runner);

    let plan;
    try {
      await service.prepareTicket({ ticketId: "one", projectRoot: root, dirtyPolicy: "cancel" });
      throw new Error("Expected approval requirement");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePreparationError);
      expect((error as WorkspacePreparationError).code).toBe("preparation.approval_required");
      plan = ((error as WorkspacePreparationError).details as { plan: { fingerprint: string } }).plan;
    }
    expect(repository.get("one").status).toBe("READY");
    expect(repository.latestWorkspacePreparationAttempt("one")?.status).toBe("AWAITING_APPROVAL");

    const prepared = await service.prepareTicket({
      ticketId: "one", projectRoot: root, dirtyPolicy: "cancel",
      approval: { fingerprint: plan.fingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true },
    });
    expect(prepared.status).toBe("PREPARED");
    expect(service.approval()?.fingerprint).toBe(plan.fingerprint);
    expect(runner.dependencies).toEqual(["pnpm install --frozen-lockfile"]);
    repository.close();
  });

  it("blocks the ticket and preserves the workspace when preparation changes tracked files", async () => {
    const root = await fixture();
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "changed", title: "Changed", description: "test", baseBranch: "main", hasPredecessors: false }));
    const runner = new DependencyRunner(true);
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(runner), runner);
    let fingerprint = "";
    await service.prepareTicket({ ticketId: "changed", projectRoot: root, dirtyPolicy: "cancel" }).catch((error: WorkspacePreparationError) => {
      fingerprint = (error.details as { plan: { fingerprint: string } }).plan.fingerprint;
    });

    await expect(service.prepareTicket({
      ticketId: "changed", projectRoot: root, dirtyPolicy: "cancel",
      approval: { fingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true },
    })).rejects.toMatchObject({ code: "preparation.tracked_files_changed" });
    expect(repository.get("changed")).toMatchObject({ status: "BLOCKED", blockedFrom: "READY" });
    expect(repository.get("changed").workspace).not.toBeNull();
    repository.close();
  });

  it("detects built-in multistack ambiguity and accepts explicit ordered units", async () => {
    const root = await fixture();
    writeFileSync(join(root, "go.mod"), "module example.test/demo\n\ngo 1.24\n", "utf8");
    await git.run("git", ["add", "go.mod"], { cwd: root });
    await git.run("git", ["commit", "-m", "test: add go module"], { cwd: root });
    const repository = new TicketRepository(":memory:");
    const runner = new DependencyRunner();
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(runner), runner);
    await expect(service.inspect(root)).rejects.toMatchObject({ code: "preparation.strategy_ambiguous" });
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy: "pnpm" }, { root: ".", strategy: "go" }] });
    expect((await service.inspect(root)).units.map((unit) => unit.strategy)).toEqual(["pnpm", "go"]);
    repository.close();
  });

  it.each([
    ["uv", ["uv sync --locked"]],
    ["poetry", ["poetry check --lock --no-interaction", "poetry sync --no-interaction"]],
    ["pipenv", ["pipenv verify", "pipenv sync --dev"]],
    ["cargo", ["cargo fetch --locked"]],
    ["go", ["go mod download", "go mod verify"]],
  ] as const)("builds locked %s commands without a shell", async (strategy, expected) => {
    const root = await fixture();
    for (const [path, contents] of Object.entries({
      "pyproject.toml": "[project]\nname='fixture'\nversion='0.0.0'\n",
      "uv.lock": "version = 1\n",
      "poetry.lock": "# lock\n",
      Pipfile: "[packages]\n",
      "Pipfile.lock": "{}\n",
      "Cargo.toml": "[package]\nname='fixture'\nversion='0.0.0'\n",
      "Cargo.lock": "version = 4\n",
      "go.mod": "module example.test/fixture\n\ngo 1.24\n",
      "go.sum": "",
    })) writeFileSync(join(root, path), contents, "utf8");
    const repository = new TicketRepository(":memory:");
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(git), new DependencyRunner());
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy }] });

    const plan = await service.inspect(root);

    expect(plan.units[0]?.commands.map((command) => command.display)).toEqual(expected);
    expect(plan.units[0]?.commands.every((command) => command.args.length > 0)).toBe(true);
    repository.close();
  });

  it("keeps custom script arguments literal and requires a tracked in-repository script", async () => {
    const root = await fixture();
    writeFileSync(join(root, "prepare.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await git.run("git", ["add", "prepare.sh"], { cwd: root });
    await git.run("git", ["commit", "-m", "test: add preparation script"], { cwd: root });
    const repository = new TicketRepository(":memory:");
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(git), new DependencyRunner());
    service.setConfig({ mode: "explicit", units: [{ root: ".", strategy: "bash", script: "prepare.sh", args: ["$(touch escaped)", "two words"] }] });

    const command = (await service.inspect(root)).units[0]?.commands[0];

    expect(command).toMatchObject({ executable: "bash", args: ["--noprofile", "--norc", "prepare.sh", "$(touch escaped)", "two words"] });
    expect(() => service.setConfig({ mode: "explicit", units: [{ root: "../outside", strategy: "pnpm" }] })).not.toThrow();
    await expect(service.inspect(root)).rejects.toMatchObject({ code: "preparation.custom_step_invalid" });
    repository.close();
  });

  it("invalidates the fingerprint when a lock changes and redacts bounded output", async () => {
    const root = await fixture();
    const repository = new TicketRepository(":memory:");
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(git), new DependencyRunner());
    const before = await service.inspect(root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nchanged: true\n", "utf8");
    const after = await service.inspect(root);

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(sanitizeOutput("https://user:secret@example.test npm_abcdefghijklmnop")).toBe("https://[redacted]@example.test [redacted]");
    expect(sanitizeOutput("x".repeat(120_000))).toHaveLength(100_000);
    repository.close();
  });

  it("persists invalid recognized stacks as failed and blocks dispatch", async () => {
    const root = await fixture();
    rmSync(join(root, "pnpm-lock.yaml"));
    await git.run("git", ["add", "pnpm-lock.yaml"], { cwd: root });
    await git.run("git", ["commit", "-m", "test: remove invalid lock"], { cwd: root });
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "invalid", title: "Invalid", description: "test", baseBranch: "main", hasPredecessors: false }));
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(git), new DependencyRunner());

    await expect(service.prepareTicket({ ticketId: "invalid", projectRoot: root, dirtyPolicy: "cancel" }))
      .rejects.toMatchObject({ code: "preparation.strategy_ambiguous" });
    expect(repository.get("invalid")).toMatchObject({ status: "BLOCKED", blockedFrom: "READY" });
    expect(repository.latestWorkspacePreparationAttempt("invalid")).toMatchObject({
      status: "FAILED",
      diagnosticCode: "preparation.strategy_ambiguous",
    });
    repository.close();
  });

  it("cancels an active preparation and does not leak unrelated environment variables", async () => {
    const root = await fixture();
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "cancel", title: "Cancel", description: "test", baseBranch: "main", hasPredecessors: false }));
    const runner = new BlockingDependencyRunner();
    const service = new WorkspacePreparationService(repository, new GitWorkspaceManager(runner), runner);
    let fingerprint = "";
    await service.prepareTicket({ ticketId: "cancel", projectRoot: root, dirtyPolicy: "cancel" }).catch((error: WorkspacePreparationError) => {
      fingerprint = (error.details as { plan: { fingerprint: string } }).plan.fingerprint;
    });
    process.env.RAYCODER_TEST_SECRET = "must-not-leak";
    const running = service.prepareTicket({
      ticketId: "cancel", projectRoot: root, dirtyPolicy: "cancel",
      approval: { fingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true },
    });
    await runner.started;
    await expect(service.cancel("cancel")).resolves.toBe(true);

    await expect(running).rejects.toMatchObject({ code: "preparation.cancelled" });
    delete process.env.RAYCODER_TEST_SECRET;
    expect(runner.environment?.RAYCODER_TEST_SECRET).toBeUndefined();
    expect(repository.get("cancel").status).toBe("CANCELLED");
    expect(repository.latestWorkspacePreparationAttempt("cancel")?.status).toBe("CANCELLED");
    repository.close();
  });

  it("interrupts uncertain attempts durably without assuming the process is alive", () => {
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "restart", title: "Restart", description: "test", baseBranch: "main", hasPredecessors: false }));
    repository.createWorkspacePreparationAttempt({
      id: "preparing", ticketId: "restart", purpose: "dispatch", status: "PREPARING", strategy: "pnpm",
      fingerprint: "fingerprint", plan: {}, workspace: "workspace", baseCommit: "base",
    });

    expect(new WorkspacePreparationService(repository, new GitWorkspaceManager(git), git).recoverInterrupted())
      .toMatchObject([{ id: "preparing", status: "INTERRUPTED", process: null }]);
    expect(repository.get("restart")).toMatchObject({ status: "BLOCKED", blockedFrom: "READY" });
    repository.close();
  });
});

class DependencyRunner implements ProcessRunner {
  public readonly dependencies: string[] = [];

  public constructor(readonly mutateManifest = false) {}

  public async run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Readonly<Record<string, string>> }): Promise<ProcessResult> {
    if (command === "git") return await git.run(command, args, options);
    const display = [command, ...args].join(" ");
    if (args.includes("--version") || (command === "go" && args[0] === "version")) {
      return result(command, args, options.cwd, `${command} 1.0.0\n`);
    }
    this.dependencies.push(display);
    if (this.mutateManifest && command === "pnpm") writeFileSync(join(options.cwd, "package.json"), "{}\n", "utf8");
    return result(command, args, options.cwd, "prepared\n");
  }
}

class BlockingDependencyRunner extends DependencyRunner {
  public environment: Readonly<Record<string, string>> | undefined;
  readonly #started: Promise<void>;
  #markStarted: (() => void) | undefined;

  public constructor() {
    super();
    this.#started = new Promise((resolve) => { this.#markStarted = resolve; });
  }

  public get started(): Promise<void> { return this.#started; }

  public override async run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Readonly<Record<string, string>> }): Promise<ProcessResult> {
    if (command === "git" || args.includes("--version")) return await super.run(command, args, options);
    this.environment = options.env;
    this.#markStarted?.();
    return await new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("cancelled by test")), { once: true });
    });
  }
}

function result(command: string, args: readonly string[], cwd: string, stdout: string): ProcessResult {
  return { command, args, cwd, exitCode: 0, stdout, stderr: "" };
}

async function fixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "raycoder-preparation-"));
  roots.push(root);
  await git.run("git", ["init", "-b", "main"], { cwd: root });
  await git.run("git", ["config", "user.name", "raycoder tests"], { cwd: root });
  await git.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@1.0.0" }), "utf8");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await git.run("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: root });
  await git.run("git", ["commit", "-m", "test: base"], { cwd: root });
  return root;
}
