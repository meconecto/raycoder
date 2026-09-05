import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalConfigStore, defaultGlobalConfig } from "../src/global-config.js";

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

    expect(await store.read()).toEqual(defaultGlobalConfig);
    expect(existsSync(path)).toBe(false);
  });

  it("writes and reads the explicit integration mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    const store = new GlobalConfigStore(path);

    await store.setIntegrationMode("confirm");

    expect(await store.read()).toMatchObject({ version: 3, integrationMode: "confirm" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 3, integrationMode: "confirm" });
  });

  it("reads legacy configs with version 3 defaults without rewriting them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-config-v1-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ version: 1, integrationMode: "confirm" }));

    const config = await new GlobalConfigStore(path).read();

    expect(config).toMatchObject({ version: 3, integrationMode: "confirm", reviewMode: "independent", ui: { locale: "auto", theme: "system" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, integrationMode: "confirm" });

    await writeFile(path, JSON.stringify({ ...defaultGlobalConfig, version: 2, ui: undefined }));
    expect(await new GlobalConfigStore(path).read()).toMatchObject({ version: 3, ui: { locale: "auto", theme: "system" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 2 });
  });

  it("persists validated UI preferences", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raycoder-config-ui-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    const store = new GlobalConfigStore(path);
    expect((await store.setUiPreferences({ locale: "es", theme: "light" })).ui).toEqual({ locale: "es", theme: "light" });
    expect(await store.read()).toMatchObject({ version: 3, ui: { locale: "es", theme: "light" } });
  });
});
