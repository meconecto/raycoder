import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeGlobalCleanup, inspectGlobalCleanup } from "../src/global-cleanup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("global cleanup", () => {
  it("deletes only the exact allowlist and stale instance temp files", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-global-cleanup-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "config.json"), "{}", "utf8");
    writeFileSync(join(root, "projects.db"), "db", "utf8");
    writeFileSync(join(root, ".instance-a1b2.tmp"), "stale", "utf8");
    writeFileSync(join(root, "keep.txt"), "keep", "utf8");
    mkdirSync(join(root, "unknown-directory"));

    const inventory = await inspectGlobalCleanup(root);
    expect([...inventory.knownFiles].sort()).toEqual([".instance-a1b2.tmp", "config.json", "projects.db"]);
    expect([...inventory.preservedEntries].sort()).toEqual(["keep.txt", "unknown-directory"]);
    const remaining = await executeGlobalCleanup(inventory);
    expect(remaining.knownFiles).toEqual([]);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
    expect(existsSync(join(root, "unknown-directory"))).toBe(true);
  });
});
