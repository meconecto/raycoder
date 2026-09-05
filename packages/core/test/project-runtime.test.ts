import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentEvent, AgentSession, StartSessionInput } from "../src/agent-adapter.js";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../src/process.js";
import { ProjectManager } from "../src/project-manager.js";
import { ProjectInspector } from "../src/project-inspector.js";
import { ProjectInitializationConfirmationError, ProjectRegistry } from "../src/project-registry.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function gitFixture(label: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), `raycoder-${label}-`));
  temporaryDirectories.push(directory);
  await runner.run("git", ["init", "-b", "main"], { cwd: directory });
  await runner.run("git", ["config", "user.name", "raycoder tests"], { cwd: directory });
  await runner.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: directory });
  writeFileSync(join(directory, "README.md"), `${label}\n`, "utf8");
  await runner.run("git", ["add", "README.md"], { cwd: directory });
  await runner.run("git", ["commit", "-m", `test: ${label}`], { cwd: directory });
  return directory;
}

describe("ProjectRegistry and ProjectRuntime", () => {
  it("deduplicates existing repositories and requires confirmation before initializing Git", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-registry-"));
    temporaryDirectories.push(root);
    const registry = new ProjectRegistry(join(root, "projects.db"));
    const existing = await gitFixture("existing");
    const first = await registry.register(existing);
    const second = await registry.register(existing, "Renamed");
    expect(second.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);

    const fresh = join(root, "fresh");
    await expect(registry.create({ path: fresh, confirmGitInit: false })).rejects.toBeInstanceOf(ProjectInitializationConfirmationError);
    const created = await registry.create({ path: fresh, name: "Fresh", confirmGitInit: true });
    expect(created.name).toBe("Fresh");
    expect((await runner.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: fresh })).stdout.trim()).toBe("true");
    expect((await runner.run("git", ["log", "-1", "--format=%an <%ae>|%s"], { cwd: fresh })).stdout.trim())
      .toBe("raycoder <raycoder@local.invalid>|chore: initialize raycoder project");
    await expect(runner.run("git", ["config", "--local", "--get", "user.name"], { cwd: fresh })).rejects.toThrow();
    registry.setAttention(first.id, {
      count: 1,
      highestSeverity: "error",
      latestCode: "quota_exhausted",
      latestAt: "2026-09-05T03:06:20.360Z",
    });
    expect(registry.attention(first.id)).toMatchObject({ count: 1, latestCode: "quota_exhausted" });
    registry.close();
    const reopened = new ProjectRegistry(join(root, "projects.db"));
    expect(reopened.attention(first.id)).toMatchObject({ count: 1, highestSeverity: "error" });
    reopened.close();
  });

  it("inspects paths before mutation and initializes an existing folder without staging its files", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-onboarding-"));
    temporaryDirectories.push(root);
    const existing = join(root, "existing");
    const missing = join(root, "missing");
    mkdirSync(existing);
    writeFileSync(join(existing, "private.txt"), "not automatically tracked\n", "utf8");
    const inspector = new ProjectInspector(runner);
    expect(await inspector.inspect(missing)).toMatchObject({ kind: "missing", canCreate: true });
    expect(await inspector.inspect(existing)).toMatchObject({ kind: "non_git_directory", canInitialize: true });

    const manager = new ProjectManager(
      new ProjectRegistry(join(root, "projects.db")),
      () => ({ adapter: new FakeAgentAdapter() }),
      inspector,
    );
    const runtime = await manager.initialize({ path: existing, confirmGitInit: true });
    expect(runtime.baseBranch).toBe("main");
    expect((await runner.run("git", ["status", "--porcelain"], { cwd: existing })).stdout.trim()).toBe("?? private.txt");
    expect(await inspector.inspect(existing)).toMatchObject({
      kind: "git_repository",
      hasBaseCommit: false,
      dirty: true,
    });
    manager.close();
  });

  it("runs projects concurrently while preserving sequential dependency execution inside each project", async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "raycoder-manager-"));
    temporaryDirectories.push(globalRoot);
    const registry = new ProjectRegistry(join(globalRoot, "projects.db"));
    const manager = new ProjectManager(registry, () => ({ adapter: new FakeAgentAdapter() }));
    const [first, second] = await Promise.all([
      manager.register(await gitFixture("project-a")),
      manager.register(await gitFixture("project-b")),
    ]);
    first.tickets.create({ id: "a1", title: "A1", description: "first" });
    first.tickets.create({ id: "a2", title: "A2", description: "second", predecessorIds: ["a1"] });
    second.tickets.create({ id: "b1", title: "B1", description: "parallel" });

    await Promise.all([
      first.scheduler.runUntilIdle({ dirtyPolicy: "cancel" }),
      second.scheduler.runUntilIdle({ dirtyPolicy: "cancel" }),
    ]);

    expect(first.repository.list().map((ticket) => ticket.status)).toEqual(["DONE", "DONE"]);
    expect(second.repository.get("b1").status).toBe("DONE");
    expect(first.repository.history("a2").map((entry) => entry.toStatus).slice(0, 2)).toEqual(["QUEUED", "READY"]);
    manager.close();
  }, 20_000);

  it("marks a prepared planning session interrupted when the project runtime reopens", async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "raycoder-planning-recovery-"));
    temporaryDirectories.push(globalRoot);
    const manager = new ProjectManager(
      new ProjectRegistry(join(globalRoot, "projects.db")),
      () => ({ adapter: new FakeAgentAdapter() }),
    );
    const first = await manager.register(await gitFixture("planning-recovery"));
    const projectId = manager.list()[0]?.project.id;
    if (projectId === undefined) throw new Error("Expected registered project");
    const session = await first.planning.prepareMessage("Persist before enqueue");
    expect(session.status).toBe("idle");
    manager.closeProject(projectId);

    const reopened = await manager.open(projectId);
    expect(reopened.planningRecovery).toMatchObject([{ id: session.id, status: "interrupted" }]);
    expect(reopened.repository.getPlanningSession(session.id)).toMatchObject({
      status: "interrupted",
      errorCode: "planning.bootstrap_interrupted",
    });
    manager.close();
  });

  it("never starts the adapter until workspace preparation is durably PREPARED", async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "raycoder-preparation-runtime-"));
    temporaryDirectories.push(globalRoot);
    const project = await gitFixture("preparation-runtime");
    writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@11.19.0" }), "utf8");
    writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await runner.run("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: project });
    await runner.run("git", ["commit", "-m", "test: add node stack"], { cwd: project });
    const adapter = new CountingAdapter();
    const preparationRunner = new RuntimePreparationRunner();
    const manager = new ProjectManager(
      new ProjectRegistry(join(globalRoot, "projects.db")),
      () => ({ adapter, runner: preparationRunner }),
    );
    const runtime = await manager.register(project);
    runtime.tickets.create({ id: "prepared-first", title: "Prepared first", description: "gate adapter" });

    await expect(runtime.scheduler.enqueue("prepared-first", { dirtyPolicy: "cancel" }))
      .rejects.toMatchObject({ code: "preparation.approval_required" });
    expect(adapter.starts).toBe(0);
    const waiting = runtime.repository.latestWorkspacePreparationAttempt("prepared-first");
    expect(waiting?.status).toBe("AWAITING_APPROVAL");
    const fingerprint = waiting?.fingerprint;
    if (fingerprint === undefined) throw new Error("Expected preparation fingerprint");

    await runtime.scheduler.enqueue("prepared-first", {
      dirtyPolicy: "cancel",
      preparationApproval: { fingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true },
    });

    expect(runtime.repository.listWorkspacePreparationAttempts("prepared-first").some((attempt) => attempt.status === "PREPARED")).toBe(true);
    expect(adapter.starts).toBeGreaterThan(0);
    expect(runtime.repository.get("prepared-first").status).toBe("DONE");
    manager.close();
  }, 20_000);
});

class CountingAdapter implements AgentAdapter {
  public starts = 0;
  readonly #delegate = new FakeAgentAdapter();
  public capabilities() { return this.#delegate.capabilities(); }
  public preflight() { return this.#delegate.preflight(); }
  public startSession(input: StartSessionInput): Promise<AgentSession> { this.starts += 1; return this.#delegate.startSession(input); }
  public send(session: AgentSession, prompt: string): AsyncIterable<AgentEvent> { return this.#delegate.send(session, prompt); }
  public cancel(session: AgentSession): Promise<void> { return this.#delegate.cancel(session); }
}

class RuntimePreparationRunner implements ProcessRunner {
  public async run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Readonly<Record<string, string>> }): Promise<ProcessResult> {
    if (command === "git") return await runner.run(command, args, options);
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: args.includes("--version") ? `${command} 11.19.0\n` : "prepared\n", stderr: "" };
  }
}
