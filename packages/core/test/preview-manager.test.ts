import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTicket } from "../src/domain.js";
import { NodeProcessRunner } from "../src/process.js";
import { PreviewManager } from "../src/preview-manager.js";
import { TicketRepository } from "../src/ticket-repository.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function repositoryFixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "raycoder-preview-"));
  temporaryDirectories.push(root);
  await runner.run("git", ["init", "-b", "main"], { cwd: root });
  await runner.run("git", ["config", "user.name", "raycoder tests"], { cwd: root });
  await runner.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: root });
  writeFileSync(join(root, "README.md"), "preview\n");
  await runner.run("git", ["add", "README.md"], { cwd: root });
  await runner.run("git", ["commit", "-m", "test: preview"], { cwd: root });
  return root;
}

describe("PreviewManager", () => {
  it("uses Git diagnostics for a non-visual project without influencing lifecycle", async () => {
    const root = await repositoryFixture();
    const repository = new TicketRepository(":memory:");
    const manager = new PreviewManager(repository, root);
    const status = await manager.status();
    expect(status).toMatchObject({ source: "base", mode: "diagnostic", running: false });
    expect(status.diagnostic).toContain("main");
    expect(repository.list()).toEqual([]);
    repository.close();
  });

  it("points an active selected ticket at its isolated workspace", async () => {
    const root = await repositoryFixture();
    const workspace = join(root, "ticket-workspace");
    const repository = new TicketRepository(":memory:");
    repository.create(createTicket({ id: "ticket", title: "Ticket", description: "test", baseBranch: "main", hasPredecessors: false }));
    repository.setGitMetadata("ticket", { branch: "raycoder/ticket", baseBranch: "main", baseCommit: "abc", workspace });
    repository.transition("ticket", "RUNNING", "test");
    const descriptor = await new PreviewManager(repository, root).describe("ticket");
    expect(descriptor).toMatchObject({ source: "ticket", ticketId: "ticket", root: workspace });
    expect(repository.get("ticket").status).toBe("RUNNING");
    repository.close();
  });

  it("detects a Node live-preview command without starting it", async () => {
    const root = await repositoryFixture();
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11", scripts: { dev: "vite" } }));
    const repository = new TicketRepository(":memory:");
    expect(await new PreviewManager(repository, root).describe()).toMatchObject({
      mode: "live",
      command: ["pnpm", "run", "dev"],
      url: "http://127.0.0.1:4320",
    });
    repository.close();
  });
});
