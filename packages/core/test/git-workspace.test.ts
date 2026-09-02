import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirtyRepositoryError, GitWorkspaceManager, isPathInside } from "../src/git-workspace.js";
import { NodeProcessRunner } from "../src/process.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createRepository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "raycoder-git-"));
  temporaryDirectories.push(directory);
  await runner.run("git", ["init", "-b", "main"], { cwd: directory });
  await runner.run("git", ["config", "user.name", "raycoder tests"], { cwd: directory });
  await runner.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: directory });
  writeFileSync(join(directory, "README.md"), "base\n", "utf8");
  await runner.run("git", ["add", "README.md"], { cwd: directory });
  await runner.run("git", ["commit", "-m", "test: base"], { cwd: directory });
  return directory;
}

describe("GitWorkspaceManager", () => {
  it("requires an explicit dirty-repository choice", async () => {
    const repository = await createRepository();
    writeFileSync(join(repository, "README.md"), "uncommitted\n", "utf8");
    const manager = new GitWorkspaceManager();
    await expect(
      manager.create({ projectRoot: repository, ticketId: "ticket-dirty", baseBranch: "main", dirtyPolicy: "cancel" }),
    ).rejects.toBeInstanceOf(DirtyRepositoryError);
  });

  it("creates a physically isolated branch from the current committed base head", async () => {
    const repository = await createRepository();
    const currentHead = (await runner.run("git", ["rev-parse", "main"], { cwd: repository })).stdout.trim();
    writeFileSync(join(repository, "README.md"), "not included\n", "utf8");

    const manager = new GitWorkspaceManager();
    const metadata = await manager.create({
      projectRoot: repository,
      ticketId: "Ticket 42",
      baseBranch: "main",
      dirtyPolicy: "committed-head",
    });

    expect(metadata.baseCommit).toBe(currentHead);
    expect(metadata.branch).toBe("raycoder/ticket-42");
    expect(isPathInside(repository, metadata.workspace)).toBe(true);
    expect(resolve(metadata.workspace)).not.toBe(resolve(repository));
    expect(readFileSync(join(metadata.workspace, "README.md"), "utf8").replace(/\r\n/gu, "\n")).toBe("base\n");
    expect(readFileSync(join(repository, ".git", "info", "exclude"), "utf8")).toContain("/.raycoder/");
  });

  it("exposes only the Git metadata directories required to commit the ticket branch", async () => {
    const repository = await createRepository();
    const manager = new GitWorkspaceManager();
    const metadata = await manager.create({
      projectRoot: repository,
      ticketId: "sandboxed",
      baseBranch: "main",
      dirtyPolicy: "cancel",
    });

    const directories = await manager.agentWritableDirectories(metadata.workspace, metadata.branch);
    const absolute = async (...args: string[]): Promise<string> => resolve(
      (await runner.run("git", ["rev-parse", "--path-format=absolute", ...args], { cwd: metadata.workspace })).stdout.trim(),
    );
    const worktreeGitDirectory = resolve(
      (await runner.run("git", ["rev-parse", "--absolute-git-dir"], { cwd: metadata.workspace })).stdout.trim(),
    );
    const objects = await absolute("--git-path", "objects");
    const branchRefs = dirname(await absolute("--git-path", `refs/heads/${metadata.branch}`));
    const branchLogs = dirname(await absolute("--git-path", `logs/refs/heads/${metadata.branch}`));

    expect(directories).toEqual([worktreeGitDirectory, objects, branchRefs, branchLogs]);
    expect(directories).not.toContain(resolve(repository, ".git"));
    expect(directories).not.toContain(resolve(repository));
  });

  it("rejects Git metadata access when the ticket workspace no longer owns its expected branch", async () => {
    const repository = await createRepository();
    const manager = new GitWorkspaceManager();
    const metadata = await manager.create({
      projectRoot: repository,
      ticketId: "detached",
      baseBranch: "main",
      dirtyPolicy: "cancel",
    });
    await runner.run("git", ["checkout", "--detach"], { cwd: metadata.workspace });

    await expect(manager.agentWritableDirectories(metadata.workspace, metadata.branch)).rejects.toThrow(
      "expected refs/heads/raycoder/detached",
    );
  });

  it("normalizes a subdirectory and excludes metadata before it is created", async () => {
    const repository = await createRepository();
    const nested = join(repository, "nested");
    mkdirSync(nested);
    const manager = new GitWorkspaceManager();

    expect(await manager.prepareProject(nested)).toBe(realpathSync.native(resolve(repository)));
    mkdirSync(join(repository, ".raycoder"));
    writeFileSync(join(repository, ".raycoder", "raycoder.db"), "metadata", "utf8");

    expect((await runner.run("git", ["status", "--porcelain"], { cwd: repository })).stdout).toBe("");
  });
});
