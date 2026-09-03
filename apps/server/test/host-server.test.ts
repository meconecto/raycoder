import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeAgentAdapter,
  MemoryService,
  ProjectManager,
  ProjectRegistry,
  type PreflightReport,
  type ProcessRunner,
} from "@raycoder/core";
import { RaycoderApplicationHost } from "../src/application-host.js";
import { createRaycoderServer } from "../src/server.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) rmSync(directory, { recursive: true, force: true });
});

const unavailableRunner: ProcessRunner = {
  async run() { throw new Error("not installed in test"); },
};

const limitedPreflight: PreflightReport = {
  canServe: true,
  canExecute: false,
  canStart: false,
  essential: [{ name: "node", ok: true, message: "Node test" }],
  tools: [{ name: "git", ok: true, message: "Git test" }],
  providers: [{ provider: "fake", executable: false, diagnostics: [{ level: "warning", code: "fake.offline", message: "Unavailable in test" }] }],
  upcoming: [],
};

function setup(): { projects: ProjectManager; host: RaycoderApplicationHost } {
  const global = mkdtempSync(join(tmpdir(), "raycoder-host-global-"));
  temporaryDirectories.push(global);
  const projects = new ProjectManager(new ProjectRegistry(join(global, "projects.db")), () => ({ adapter: new FakeAgentAdapter() }));
  return {
    projects,
    host: new RaycoderApplicationHost({
      projects,
      memory: new MemoryService(unavailableRunner, join(global, "codex.toml")),
      preflight: limitedPreflight,
      runPreflight: async () => limitedPreflight,
    }),
  };
}

async function listen(host: RaycoderApplicationHost): Promise<{ root: string; close: () => Promise<void> }> {
  const server = createRaycoderServer({ app: host });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    root: `http://127.0.0.1:${port}`,
    close: async () => await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

describe("projectless application host", () => {
  it("serves the selector and global preflight with zero projects and no executable provider", async () => {
    const fixture = setup();
    const server = await listen(fixture.host);
    try {
      expect(await (await fetch(`${server.root}/api/projects`)).json()).toEqual({ projects: [] });
      expect(await (await fetch(`${server.root}/api/preflight`)).json()).toMatchObject({ canServe: true, canExecute: false });
      expect(await (await fetch(server.root)).text()).toContain("Choose where to work");
      expect(await (await fetch(`${server.root}/app.js`)).text()).toContain("showLanding");
    } finally {
      await server.close();
      fixture.host.close();
    }
  });

  it("rejects foreign mutation origins with a structured error", async () => {
    const fixture = setup();
    const server = await listen(fixture.host);
    try {
      const response = await fetch(`${server.root}/api/projects/inspect`, {
        method: "POST",
        headers: { origin: "http://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ path: process.cwd() }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-origin mutations are not accepted", code: "request.invalid_origin" });
    } finally {
      await server.close();
      fixture.host.close();
    }
  });

  it("inspects, creates and opens a project, then blocks agent execution while preflight is limited", async () => {
    const fixture = setup();
    const project = join(mkdtempSync(join(tmpdir(), "raycoder-host-parent-")), "new-project");
    temporaryDirectories.push(join(project, ".."));
    const server = await listen(fixture.host);
    try {
      const inspected = await (await fetch(`${server.root}/api/projects/inspect`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: project }),
      })).json();
      expect(inspected).toMatchObject({ kind: "missing", canCreate: true });
      const createdResponse = await fetch(`${server.root}/api/projects`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", path: project, confirmGitInit: true }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { projects: { project: { id: string } }[] };
      const id = created.projects[0]?.project.id;
      expect(id).toBeTypeOf("string");
      expect(await (await fetch(`${server.root}/api/projects/${id}/inspection`)).json()).toMatchObject({ hasBaseCommit: true, branch: "main" });
      const ticket = await fetch(`${server.root}/api/projects/${id}/tickets`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Blocked run", description: "provider absent" }),
      }).then((response) => response.json()) as { ticket: { id: string } };
      const run = await fetch(`${server.root}/api/projects/${id}/tickets/${ticket.ticket.id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run", dirtyPolicy: "cancel" }),
      });
      expect(run.status).toBe(503);
      expect(await run.json()).toMatchObject({ code: "provider.unavailable" });
    } finally {
      await server.close();
      fixture.host.close();
    }
  });

  it("keeps a moved project visible with a repairable error", async () => {
    const fixture = setup();
    const parent = mkdtempSync(join(tmpdir(), "raycoder-host-stale-"));
    temporaryDirectories.push(parent);
    const original = join(parent, "original");
    const moved = join(parent, "moved");
    const created = await fixture.projects.create({ path: original, confirmGitInit: true });
    const id = fixture.projects.list()[0]?.project.id;
    if (id === undefined) throw new Error("Expected project");
    expect(created.projectRoot).toBe(original);
    fixture.projects.closeProject(id);
    renameSync(original, moved);
    const server = await listen(fixture.host);
    try {
      const open = await fetch(`${server.root}/api/projects/${id}/open`, { method: "POST" });
      expect(open.status).toBe(500);
      expect(await open.json()).toMatchObject({ error: expect.any(String), code: expect.any(String) });
      const projects = await (await fetch(`${server.root}/api/projects`)).json() as { projects: { state: string; project: { id: string } }[] };
      expect(projects.projects.find((entry) => entry.project.id === id)?.state).toBe("error");
    } finally {
      await server.close();
      fixture.host.close();
    }
  });

  it("executes a previewed cleanup through the API without deleting the checkout", async () => {
    const fixture = setup();
    const parent = mkdtempSync(join(tmpdir(), "raycoder-host-cleanup-"));
    temporaryDirectories.push(parent);
    const project = join(parent, "project");
    await fixture.projects.create({ path: project, name: "Disposable", confirmGitInit: true });
    const id = fixture.projects.list()[0]?.project.id;
    if (id === undefined) throw new Error("Expected project");
    const server = await listen(fixture.host);
    try {
      const plan = await fetch(`${server.root}/api/projects/${id}/cleanup/plan`, { method: "POST" }).then((response) => response.json()) as {
        id: string; fingerprint: string; confirmationPhrase: string;
      };
      const response = await fetch(`${server.root}/api/projects/${id}/cleanup/execute`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, fingerprint: plan.fingerprint, confirmationPhrase: plan.confirmationPhrase }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ complete: true });
      expect(existsSync(project)).toBe(true);
      expect(existsSync(join(project, ".raycoder"))).toBe(false);
    } finally {
      await server.close();
      fixture.host.close();
    }
  });
});
