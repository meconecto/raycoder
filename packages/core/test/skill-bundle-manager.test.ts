import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillBundleManager } from "../src/skill-bundle-manager.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SkillBundleManager", () => {
  it("installs once and can completely restore the pinned bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-skills-"));
    temporaryDirectories.push(root);
    const bundle = join(root, "bundle");
    const project = join(root, "project");
    await mkdir(join(bundle, "engineering", "implement"), { recursive: true });
    await mkdir(project, { recursive: true });
    writeFileSync(join(bundle, "PINNED.json"), JSON.stringify({ source: "fixture", commit: "abc", bundle: "engineering", license: "MIT" }));
    writeFileSync(join(bundle, "engineering", "implement", "SKILL.md"), "original\n");
    const manager = new SkillBundleManager(bundle);

    expect((await manager.ensureProjectSkills(project)).installed).toBe(true);
    const installed = join(project, ".raycoder", "skills", "engineering", "implement", "SKILL.md");
    writeFileSync(installed, "corrupt\n");
    expect((await manager.ensureProjectSkills(project)).installed).toBe(false);
    expect(readFileSync(installed, "utf8")).toBe("corrupt\n");

    await manager.restoreProjectSkills(project);
    expect(readFileSync(installed, "utf8")).toBe("original\n");
    expect(existsSync(join(project, ".raycoder", "skills", "PINNED.json"))).toBe(true);
  });
});
