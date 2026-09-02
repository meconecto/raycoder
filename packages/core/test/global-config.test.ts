import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalConfigStore } from "../src/global-config.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GlobalConfigStore", () => {
  it("defaults to auto without creating a file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "config.json");
    const store = new GlobalConfigStore(path);

    expect(await store.read()).toEqual({ version: 1, integrationMode: "auto" });
    expect(existsSync(path)).toBe(false);
  });

  it("writes and reads the explicit integration mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    const store = new GlobalConfigStore(path);

    await store.setIntegrationMode("confirm");

    expect(await store.read()).toEqual({ version: 1, integrationMode: "confirm" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, integrationMode: "confirm" });
  });
});
