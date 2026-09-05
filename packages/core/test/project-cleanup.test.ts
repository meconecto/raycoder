import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../src/fake-agent-adapter.js";
import { NodeProcessRunner } from "../src/process.js";
import { ProjectCleanupService } from "../src/project-cleanup.js";
import { ProjectManager } from "../src/project-manager.js";
import { ProjectRegistry } from "../src/project-registry.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) rmSync(directory, { recursive: true, force: true });
});

async function setup(adapter = new FakeAgentAdapter()): Promise<{
  root: string;
  manager: ProjectManager;
  cleanup: ProjectCleanupService;
  projectId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "raycoder-cleanup-project-"));
  const global = mkdtempSync(join(tmpdir(), "raycoder-cleanup-global-"));
  temporaryDirectories.push(root, global);
  await runner.run("git", ["init", "-b", "main"], { cwd: root });
  await runner.run("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { cwd: root });
  const manager = new ProjectManager(new ProjectRegistry(join(global, "projects.db")), () => ({ adapter }));
  await manager.register(root, "Cleanup fixture");
  const projectId = manager.list()[0]?.project.id;
  if (projectId === undefined) throw new Error("Expected project registration");
  return { root, manager, cleanup: new ProjectCleanupService(manager), projectId };
}

describe("ProjectCleanupService", () => {
  it("previews and removes safe worktrees, integrated branches, metadata and registration in order", async () => {
    const fixture = await setup();
    const runtime = fixture.manager.get(fixture.projectId);
    runtime.tickets.create({ id: "done", title: "Done", description: "safe branch" });
    await runtime.scheduler.enqueue("done", { dirtyPolicy: "cancel" });
    expect(runtime.repository.get("done").status).toBe("DONE");

    const plan = await fixture.cleanup.plan(fixture.projectId);
    expect(plan.targets.some((target) => target.kind === "ticket_worktree" && target.selectedByDefault)).toBe(true);
    expect(plan.targets.some((target) => target.kind === "branch" && target.integrated && target.selectedByDefault)).toBe(true);
    const result = await fixture.cleanup.execute({
      projectId: fixture.projectId,
      planId: plan.id,
      fingerprint: plan.fingerprint,
      confirmationPhrase: plan.confirmationPhrase,
    });

    expect(result).toMatchObject({ complete: true, failedStep: null });
    expect(fixture.manager.list()).toEqual([]);
    expect(existsSync(fixture.root)).toBe(true);
    expect(existsSync(join(fixture.root, ".raycoder"))).toBe(false);
    expect(readFileSync(join(fixture.root, ".git", "info", "exclude"), "utf8")).not.toContain("/.raycoder/");
    expect((await runner.run("git", ["branch", "--list", "raycoder/*"], { cwd: fixture.root })).stdout.trim()).toBe("");
    fixture.manager.close();
  }, 20_000);

  it("deselects dirty failed work and requires force when explicitly selected", async () => {
    const fixture = await setup(new FakeAgentAdapter({ failAtTurn: 0 }));
    const runtime = fixture.manager.get(fixture.projectId);
    runtime.tickets.create({ id: "failed", title: "Failed", description: "preserve this" });
    await runtime.scheduler.enqueue("failed", { dirtyPolicy: "cancel" });
    const ticket = runtime.repository.get("failed");
    if (ticket.workspace === null) throw new Error("Expected failed ticket workspace");
    writeFileSync(join(ticket.workspace, "uncommitted.txt"), "do not lose\n", "utf8");

    const plan = await fixture.cleanup.plan(fixture.projectId);
    const risky = plan.targets.filter((target) => target.requiresForce);
    expect(risky.some((target) => target.kind === "ticket_worktree" && target.dirty && !target.selectedByDefault)).toBe(true);
    expect(risky.some((target) => target.kind === "branch" && !target.selectedByDefault)).toBe(true);
    await expect(fixture.cleanup.execute({
      projectId: fixture.projectId,
      planId: plan.id,
      fingerprint: plan.fingerprint,
      confirmationPhrase: plan.confirmationPhrase,
      selectedTargetIds: risky.map((target) => target.id),
    })).rejects.toThrow("force=true");
    expect(existsSync(ticket.workspace)).toBe(true);
    fixture.manager.close();
  }, 20_000);

  it("preserves a clean worktree that is awaiting preparation approval", async () => {
    const fixture = await setup();
    writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@11.19.0" }), "utf8");
    writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await runner.run("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: fixture.root });
    await runner.run("git", [
      "-c", "user.name=raycoder tests",
      "-c", "user.email=tests@raycoder.local",
      "commit", "-m", "test: add node stack",
    ], { cwd: fixture.root });
    const runtime = fixture.manager.get(fixture.projectId);
    runtime.tickets.create({ id: "approval", title: "Approval", description: "preserve preparation" });
    await runtime.preparation.prepareTicket({ ticketId: "approval", projectRoot: fixture.root, dirtyPolicy: "cancel" }).catch(() => undefined);

    const plan = await fixture.cleanup.plan(fixture.projectId);
    const target = plan.targets.find((candidate) => candidate.kind === "ticket_worktree" && candidate.ticketId === "approval");

    expect(target).toMatchObject({ dirty: false, requiresForce: true, selectedByDefault: false });
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "preparation.preserved", targetId: target?.id }));
    fixture.manager.close();
  }, 20_000);

  it("rejects a stale fingerprint after workspace state changes", async () => {
    const fixture = await setup(new FakeAgentAdapter({ failAtTurn: 0 }));
    const runtime = fixture.manager.get(fixture.projectId);
    runtime.tickets.create({ id: "changed", title: "Changed", description: "fingerprint" });
    await runtime.scheduler.enqueue("changed", { dirtyPolicy: "cancel" });
    const ticket = runtime.repository.get("changed");
    if (ticket.workspace === null) throw new Error("Expected workspace");
    const plan = await fixture.cleanup.plan(fixture.projectId);
    writeFileSync(join(ticket.workspace, "changed-after-plan.txt"), "change\n", "utf8");

    await expect(fixture.cleanup.execute({
      projectId: fixture.projectId,
      planId: plan.id,
      fingerprint: plan.fingerprint,
      confirmationPhrase: plan.confirmationPhrase,
      selectedTargetIds: [],
    })).rejects.toThrow("inventory changed");
    fixture.manager.close();
  }, 20_000);

  it("never targets a registered worktree outside validated raycoder roots", async () => {
    const fixture = await setup();
    const outside = mkdtempSync(join(tmpdir(), "raycoder-external-worktree-"));
    rmSync(outside, { recursive: true, force: true });
    temporaryDirectories.push(outside);
    await runner.run("git", ["worktree", "add", "-b", "raycoder/external", outside, "main"], { cwd: fixture.root });
    const plan = await fixture.cleanup.plan(fixture.projectId);

    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "worktree.outside_roots" }));
    expect(plan.targets.some((target) => target.path === outside)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    fixture.manager.close();
  });

  it("refuses execution while the project scheduler has pending work", async () => {
    const fixture = await setup();
    const runtime = fixture.manager.get(fixture.projectId);
    const plan = await fixture.cleanup.plan(fixture.projectId);
    let release: (() => void) | undefined;
    const pending = runtime.scheduler.serialize(async () => await new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await expect(fixture.cleanup.execute({
        projectId: fixture.projectId,
        planId: plan.id,
        fingerprint: plan.fingerprint,
        confirmationPhrase: plan.confirmationPhrase,
        selectedTargetIds: [],
      })).rejects.toThrow("idle scheduler");
    } finally {
      release?.();
      await pending;
      fixture.manager.close();
    }
  });
});
