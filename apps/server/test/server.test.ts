import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
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
      canServe: true,
      canExecute: true,
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      tools: [{ name: "git", ok: true, message: "Git test" }],
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
      const html = await (await fetch(root)).text();
      expect(html).toContain("raycoder");
      expect(html).toContain("Open a workspace");
      expect(html).toContain("data-tab=\"dag\"");
      expect(html).toContain('<script type="module" src="/app.js"></script>');
      const app = await (await fetch(`${root}/app.js`)).text();
      expect(() => new Script(app)).not.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      repository.close();
    }
  });

  it("confirms a prepared integration through the API", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    const preflight: PreflightReport = {
      canServe: true,
      canExecute: true,
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      tools: [{ name: "git", ok: true, message: "Git test" }],
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
      canServe: true,
      canExecute: true,
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      tools: [{ name: "git", ok: true, message: "Git test" }],
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
      const interrogationResponse = await fetch(`${root}/planning/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "interrogation", markdown: "Aligned plan" }),
      });
      const interrogation = await interrogationResponse.json() as { artifact: { id: string } };
      await fetch(`${root}/planning/artifacts/${interrogation.artifact.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const specResponse = await fetch(`${root}/planning/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "spec", markdown: "# Spec", predecessorArtifactId: interrogation.artifact.id }),
      });
      const spec = await specResponse.json() as { artifact: { id: string } };
      await fetch(`${root}/planning/artifacts/${spec.artifact.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const planResponse = await fetch(`${root}/planning/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "tickets",
          predecessorArtifactId: spec.artifact.id,
          tickets: [{ id: "planned", title: "Planned", description: "from spec", predecessorIds: [] }],
        }),
      });
      const plan = await planResponse.json() as { artifact: { id: string } };
      expect(runtime.repository.list().some((ticket) => ticket.id === "planned")).toBe(false);
      await fetch(`${root}/planning/artifacts/${plan.artifact.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      await fetch(`${root}/planning/artifacts/${plan.artifact.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm_tickets" }),
      });
      expect(runtime.repository.get("planned").status).toBe("READY");
      expect(await (await fetch(`${root}/skills`)).json()).toMatchObject({ info: { commit: expect.any(String) } });
      expect(await (await fetch(`${root}/preview`)).json()).toMatchObject({
        source: "base",
        mode: "diagnostic",
        running: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      projects.close();
    }
  }, 20_000);

  it("runs conversational planning asynchronously through durable project APIs", async () => {
    const projectRoot = await createRepository();
    const registryRoot = mkdtempSync(join(tmpdir(), "raycoder-planning-api-"));
    temporaryDirectories.push(registryRoot);
    const projects = new ProjectManager(
      new ProjectRegistry(join(registryRoot, "projects.db")),
      () => ({ adapter: new FakeAgentAdapter() }),
    );
    const runtime = await projects.register(projectRoot);
    const projectId = projects.list()[0]?.project.id;
    if (projectId === undefined) throw new Error("Expected registered project");
    const preflight: PreflightReport = {
      canServe: true,
      canExecute: true,
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      tools: [{ name: "git", ok: true, message: "Git test" }],
      providers: [{ provider: "fake", executable: true, diagnostics: [] }],
      upcoming: [],
    };
    const server = createRaycoderServer({ projects, preflight });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}/api/projects/${projectId}`;
    try {
      const foreignOrigin = await fetch(`${root}/planning/thread`, {
        method: "POST",
        headers: { origin: "http://evil.example" },
      });
      expect(foreignOrigin.status).toBe(403);
      expect(await foreignOrigin.json()).toMatchObject({ code: "request.invalid_origin" });
      const firstThread = await fetch(`${root}/planning/thread`, { method: "POST" }).then((response) => response.json()) as { thread: { id: string } };
      const secondThread = await fetch(`${root}/planning/thread`, { method: "POST" }).then((response) => response.json()) as { thread: { id: string } };
      expect(secondThread.thread.id).toBe(firstThread.thread.id);

      const conversationResponse = await fetch(`${root}/planning/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Plan a deterministic feature" }),
      });
      expect(conversationResponse.status).toBe(202);
      const conversation = await conversationResponse.json() as { session: { id: string } };
      await waitFor(() => runtime.repository.getPlanningSession(conversation.session.id).status === "completed");

      const specResponse = await fetch(`${root}/planning/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage: "spec" }),
      });
      expect(specResponse.status).toBe(202);
      const specSession = await specResponse.json() as { session: { id: string } };
      await waitFor(() => runtime.repository.getPlanningSession(specSession.session.id).status === "completed");
      const spec = runtime.repository.listPlanningArtifacts("spec").at(-1);
      if (spec === undefined) throw new Error("Expected generated SPEC");
      const editedSpecResponse = await fetch(`${root}/planning/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          predecessorArtifactId: spec.predecessorArtifactId,
          replacesArtifactId: spec.id,
          content: {
            ...spec.content as Record<string, unknown>,
            summary: "Corrected through the structured API",
          },
        }),
      });
      expect(editedSpecResponse.status).toBe(201);
      const editedSpec = await editedSpecResponse.json() as { artifact: { id: string } };
      await fetch(`${root}/planning/artifacts/${editedSpec.artifact.id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
      });

      const ticketResponse = await fetch(`${root}/planning/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage: "tickets", predecessorArtifactId: editedSpec.artifact.id }),
      });
      expect(ticketResponse.status).toBe(202);
      const ticketSession = await ticketResponse.json() as { session: { id: string } };
      await waitFor(() => runtime.repository.getPlanningSession(ticketSession.session.id).status === "completed");
      const generatedPlan = runtime.repository.listPlanningArtifacts("tickets").at(-1);
      if (generatedPlan === undefined) throw new Error("Expected generated ticket plan");

      const rejectedConfirmation = await fetch(`${root}/planning/dag/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifactId: generatedPlan.id }),
      });
      expect(rejectedConfirmation.status).toBe(409);
      expect(await rejectedConfirmation.json()).toMatchObject({ code: "planning.revision_invalid" });
      const editedPlanResponse = await fetch(`${root}/planning/ticket-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          predecessorArtifactId: editedSpec.artifact.id,
          replacesArtifactId: generatedPlan.id,
          tickets: [
            { id: "plan-core", title: "Build core", description: "Corrected through the structured API", predecessorIds: [] },
            { id: "plan-ui", title: "Build UI", description: "Expose the core", predecessorIds: ["plan-core"] },
          ],
        }),
      });
      expect(editedPlanResponse.status).toBe(201);
      const editedPlan = await editedPlanResponse.json() as { artifact: { id: string } };
      const plan = runtime.repository.getPlanningArtifact(editedPlan.artifact.id);
      await fetch(`${root}/planning/artifacts/${plan.id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
      });
      const confirmation = await fetch(`${root}/planning/dag/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifactId: plan.id }),
      });
      expect(confirmation.status).toBe(200);
      expect(await confirmation.json()).toMatchObject({ tickets: [{ id: "plan-core" }, { id: "plan-ui" }] });

      const cycle = await fetch(`${root}/planning/ticket-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          predecessorArtifactId: editedSpec.artifact.id,
          tickets: [
            { id: "cycle-a", title: "A", description: "A", predecessorIds: ["cycle-b"] },
            { id: "cycle-b", title: "B", description: "B", predecessorIds: ["cycle-a"] },
          ],
        }),
      });
      expect(cycle.status).toBe(409);
      expect(await cycle.json()).toMatchObject({ code: "planning.cycle" });

      const snapshot = await fetch(`${root}/planning`).then((response) => response.json()) as {
        messages: unknown[]; sessions: unknown[]; events: unknown[]; confirmation: { artifactId: string };
      };
      expect(snapshot.messages.length).toBeGreaterThanOrEqual(5);
      expect(snapshot.sessions).toHaveLength(3);
      expect(snapshot.events.length).toBeGreaterThanOrEqual(6);
      expect(snapshot.confirmation.artifactId).toBe(plan.id);
      const events = await fetch(`${root}/planning/sessions/${ticketSession.session.id}/events`).then((response) => response.json()) as { events: unknown[] };
      expect(events.events).toHaveLength(2);
      expect(await fetch(`${root}/planning/messages`).then((response) => response.json())).toMatchObject({ messages: expect.any(Array) });
      expect(await fetch(`${root}/planning/sessions`).then((response) => response.json())).toMatchObject({ sessions: expect.any(Array) });

      const pending = await runtime.planning.prepareMessage("Cancel before it runs");
      const cancelled = await fetch(`${root}/planning/sessions/${pending.id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ session: { status: "cancelled" } });

      const orphaned = await runtime.planning.prepareMessage("Cannot be resumed by fake");
      runtime.repository.updatePlanningSession(orphaned.id, { status: "running", providerSessionId: "opaque" });
      runtime.planning.recoverInterruptedSessions();
      const recovery = await fetch(`${root}/planning/recovery`).then((response) => response.json()) as { interrupted: { id: string }[] };
      expect(recovery.interrupted.map((session) => session.id)).toContain(orphaned.id);
      const resume = await fetch(`${root}/planning/sessions/${orphaned.id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }),
      });
      expect(resume.status).toBe(409);
      expect(await resume.json()).toMatchObject({ code: "planning.resume_unsupported" });
      const closeInterrupted = await fetch(`${root}/planning/sessions/${orphaned.id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
      });
      expect(closeInterrupted.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      projects.close();
    }
  }, 20_000);

  it("keeps planning available without HEAD while ticket execution stays disabled", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "raycoder-unborn-api-"));
    temporaryDirectories.push(projectRoot);
    await runner.run("git", ["init", "-b", "main"], { cwd: projectRoot });
    const registryRoot = mkdtempSync(join(tmpdir(), "raycoder-unborn-registry-"));
    temporaryDirectories.push(registryRoot);
    const projects = new ProjectManager(
      new ProjectRegistry(join(registryRoot, "projects.db")),
      () => ({ adapter: new FakeAgentAdapter() }),
    );
    const runtime = await projects.register(projectRoot);
    const projectId = projects.list()[0]?.project.id;
    if (projectId === undefined) throw new Error("Expected registered project");
    const preflight: PreflightReport = {
      canServe: true,
      canExecute: true,
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      tools: [{ name: "git", ok: true, message: "Git test" }],
      providers: [{ provider: "fake", executable: true, diagnostics: [] }],
      upcoming: [],
    };
    const server = createRaycoderServer({ projects, preflight });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}/api/projects/${projectId}`;
    try {
      const interrogation = runtime.planning.approve(runtime.planning.recordInterrogation("Approved decisions").id);
      const spec = runtime.planning.approve(runtime.planning.recordSpec("No-HEAD SPEC", interrogation.id).id);
      const plan = runtime.planning.proposeTickets([
        { id: "unborn-ticket", title: "Unborn", description: "Planned before baseline", predecessorIds: [] },
      ], spec.id);
      runtime.planning.approve(plan.id);
      const confirmed = await fetch(`${root}/planning/dag/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifactId: plan.id }),
      });
      expect(confirmed.status).toBe(200);
      expect(runtime.repository.get("unborn-ticket")).toMatchObject({ status: "READY", baseBranch: "main" });

      const run = await fetch(`${root}/tickets/unborn-ticket/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run" }),
      });
      expect(run.status).toBe(409);
      expect(await run.json()).toMatchObject({ code: "project.baseline_required" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      projects.close();
    }
  }, 20_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for server dispatch");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
