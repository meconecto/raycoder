import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../src/process.js";
import { ProjectInspector } from "../src/project-inspector.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ProjectInspector", () => {
  it("classifies missing, empty, non-Git, file and Git paths without mutating them", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-inspection-"));
    temporaryDirectories.push(root);
    const empty = join(root, "empty");
    const populated = join(root, "populated");
    const file = join(root, "file.txt");
    const repository = join(root, "repository");
    mkdirSync(empty);
    mkdirSync(populated);
    writeFileSync(join(populated, "kept.txt"), "keep\n", "utf8");
    writeFileSync(file, "file\n", "utf8");
    mkdirSync(repository);
    await runner.run("git", ["init", "-b", "main"], { cwd: repository });

    const inspector = new ProjectInspector();
    await expect(inspector.inspect(join(root, "missing"))).resolves.toMatchObject({ kind: "missing", canCreate: true, canonicalPath: null });
    await expect(inspector.inspect(empty)).resolves.toMatchObject({ kind: "empty_directory", canCreate: true });
    await expect(inspector.inspect(populated)).resolves.toMatchObject({ kind: "non_git_directory", canInitialize: true });
    await expect(inspector.inspect(file)).resolves.toMatchObject({ kind: "inaccessible", canRegister: false });
    await expect(inspector.inspect(repository)).resolves.toMatchObject({ kind: "git_repository", hasBaseCommit: false, branch: "main" });
    expect(await runner.run("git", ["status", "--porcelain"], { cwd: repository })).toMatchObject({ stdout: "" });
  });

  it("canonicalizes a nested path to the repository root and reports dirty state", async () => {
    const repository = mkdtempSync(join(tmpdir(), "raycoder-inspection-repo-"));
    temporaryDirectories.push(repository);
    await runner.run("git", ["init", "-b", "main"], { cwd: repository });
    await runner.run("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { cwd: repository });
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(repository, "dirty.txt"), "dirty\n", "utf8");

    await expect(new ProjectInspector().inspect(nested)).resolves.toMatchObject({
      kind: "git_repository", repositoryRoot: realpathSync(repository), branch: "main", hasBaseCommit: true, dirty: true,
    });
  });
});
