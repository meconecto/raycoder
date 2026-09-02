import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dispatcher,
  FakeAgentAdapter,
  GitWorkspaceManager,
  IntegrationService,
  NodeProcessRunner,
  TicketRepository,
  ProjectOrchestrator,
  ProjectManager,
  ProjectRegistry,
  type PreflightReport,
} from "@raycoder/core";
import { createRaycoderServer } from "../src/server.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createRepository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "raycoder-server-"));
  temporaryDirectories.push(directory);
  await runner.run("git", ["init", "-b", "main"], { cwd: directory });
  await runner.run("git", ["config", "user.name", "raycoder tests"], { cwd: directory });
  await runner.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: directory });
  writeFileSync(join(directory, "README.md"), "base\n", "utf8");
  await runner.run("git", ["add", "README.md"], { cwd: directory });
  await runner.run("git", ["commit", "-m", "test: base"], { cwd: directory });
  return directory;
}

describe("minimal server", () => {
  it("exposes preflight and automatically integrates the demonstration ticket", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    const preflight: PreflightReport = {
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      providers: [{ provider: "fake", executable: true, diagnostics: [] }],
      upcoming: [],
    };
    const dispatcher = new Dispatcher(repository, new GitWorkspaceManager(), new FakeAgentAdapter());
    const integration = new IntegrationService(repository, projectRoot, "auto");
    const server = createRaycoderServer({
      repository,
      orchestrator: new ProjectOrchestrator(repository, dispatcher, integration),
      preflight,
      projectRoot,
      baseBranch: "main",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}`;
    try {
      expect(await (await fetch(`${root}/api/preflight`)).json()).toMatchObject({ canStart: true });
      const response = await fetch(`${root}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dirtyPolicy: "cancel" }),
      });
      expect(response.status).toBe(202);
      await waitFor(() => repository.list()[0]?.status === "DONE");
      expect(repository.list()[0]?.status).toBe("DONE");
      expect(await (await fetch(`${root}/api/config`)).json()).toEqual({ integrationMode: "auto" });
      const tickets = await (await fetch(`${root}/api/tickets`)).json() as {
        tickets: { integrationAttempt: { status: string } }[];
      };
      expect(tickets.tickets[0]?.integrationAttempt.status).toBe("INTEGRATED");
      expect(await (await fetch(root)).text()).toContain("raycoder");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      repository.close();
    }
  });

  it("confirms a prepared integration through the API", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    const preflight: PreflightReport = {
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      providers: [{ provider: "fake", executable: true, diagnostics: [] }],
      upcoming: [],
    };
    const dispatcher = new Dispatcher(repository, new GitWorkspaceManager(), new FakeAgentAdapter());
    const integration = new IntegrationService(repository, projectRoot, "confirm");
    const server = createRaycoderServer({
      repository,
      orchestrator: new ProjectOrchestrator(repository, dispatcher, integration),
      preflight,
      projectRoot,
      baseBranch: "main",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}`;
    try {
      await fetch(`${root}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dirtyPolicy: "cancel" }),
      });
      await waitFor(() => repository.latestIntegrationAttempt(repository.list()[0]?.id ?? "missing")?.status === "AWAITING_CONFIRMATION");
      const ticket = repository.list()[0];
      const attempt = ticket === undefined ? null : repository.latestIntegrationAttempt(ticket.id);
      if (ticket === undefined || attempt === null) throw new Error("Expected a prepared integration attempt");

      const response = await fetch(`${root}/api/tickets/${encodeURIComponent(ticket.id)}/integration`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", attemptId: attempt.id }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ kind: "integrated", ticket: { status: "DONE" } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      repository.close();
    }
  });

  it("exposes project-scoped ticket, dependency, history, session and action APIs", async () => {
    const projectRoot = await createRepository();
    const registryRoot = mkdtempSync(join(tmpdir(), "raycoder-server-registry-"));
    temporaryDirectories.push(registryRoot);
    const projects = new ProjectManager(
      new ProjectRegistry(join(registryRoot, "projects.db")),
      () => ({ adapter: new FakeAgentAdapter() }),
    );
    const runtime = await projects.register(projectRoot);
    const project = projects.list()[0]?.project;
    if (project === undefined) throw new Error("Expected registered project");
    const preflight: PreflightReport = {
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      providers: [{ provider: "fake", executable: true, diagnostics: [] }],
      upcoming: [],
    };
    const server = createRaycoderServer({
      repository: runtime.repository,
      orchestrator: runtime.orchestrator,
      preflight,
      projectRoot: runtime.projectRoot,
      baseBranch: runtime.baseBranch,
      projects,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}/api/projects/${project.id}`;
    try {
      const parentResponse = await fetch(`${root}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "parent", title: "Parent", description: "first" }),
      });
      expect(parentResponse.status).toBe(201);
      const childResponse = await fetch(`${root}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "child", title: "Child", description: "second", predecessorIds: ["parent"] }),
      });
      expect(childResponse.status).toBe(201);

      const run = await fetch(`${root}/tickets/parent/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run", dirtyPolicy: "cancel" }),
      });
      expect(run.status).toBe(202);
      expect(runtime.repository.get("parent").status).toBe("DONE");
      expect(runtime.repository.get("child").status).toBe("READY");
      expect((await (await fetch(`${root}/dependencies`)).json())).toMatchObject({
        dependencies: [{ ticketId: "child", predecessorId: "parent" }],
      });
      const history = await (await fetch(`${root}/tickets/parent/history`)).json() as { reviews: unknown[] };
      expect(history.reviews).toHaveLength(1);
      const sessions = await (await fetch(`${root}/tickets/parent/sessions`)).json() as { sessions: unknown[] };
      expect(sessions.sessions).toHaveLength(2);
      expect(await (await fetch(`${root}/capabilities`)).json()).toMatchObject({ provider: "fake" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      projects.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for server dispatch");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
