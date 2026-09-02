import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterCapabilities } from "../src/agent-adapter.js";
import { GlobalConfigStore } from "../src/global-config.js";
import { SettingsService } from "../src/settings-service.js";
import { TicketRepository } from "../src/ticket-repository.js";

const temporaryDirectories: string[] = [];
const codex: AdapterCapabilities = {
  provider: "codex",
  cancellation: true,
  resumableSessions: true,
  nativeSkills: true,
  sandboxModes: ["workspace-write"],
  models: [{ id: "default", efforts: ["low", "medium", "high"] }],
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SettingsService", () => {
  it("merges a project override and validates provider, model and effort from capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "raycoder-settings-"));
    temporaryDirectories.push(root);
    const repository = new TicketRepository(join(root, "project.db"));
    const settings = new SettingsService(new GlobalConfigStore(join(root, "config.json")), repository);
    const override = { integrationMode: "confirm" as const, stages: { review: { provider: "codex", model: "default", effort: "high" } } };
    await settings.validateProjectOverride(override, [codex]);
    settings.setProjectOverride(override);
    expect(await settings.effective([codex])).toMatchObject({
      integrationMode: "confirm",
      stages: { review: { effort: "high" } },
    });
    await expect(settings.validateProjectOverride({
      stages: { review: { provider: "codex", model: "missing", effort: null } },
    }, [codex])).rejects.toThrow(/Model missing/u);
    repository.close();
  });
});
