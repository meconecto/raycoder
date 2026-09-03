import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MemoryService,
  PlannedTicket,
  PreflightReport,
  ProjectConfigOverride,
  ProjectManager,
  ProjectOrchestrator,
  ProjectRuntime,
  SpecContent,
  TicketRepository,
} from "@raycoder/core";
import {
  createTicket,
  DependencyCycleError,
  PlanningBusyError,
  PlanningGenerationError,
  PlanningInvalidStateError,
  PlanningResumeUnsupportedError,
  ProjectCleanupService,
  UnknownTicketError,
} from "@raycoder/core";
import type { RaycoderApplicationHost } from "./application-host.js";
import { NativeDirectoryPicker, type DirectoryPicker } from "./platform.js";

export interface InstanceIdentity {
  readonly id: string;
  readonly nonce: string;
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly port: number;
}

export interface RaycoderServerOptions {
  readonly app?: RaycoderApplicationHost;
  readonly repository?: TicketRepository;
  readonly orchestrator?: ProjectOrchestrator;
  readonly preflight?: PreflightReport;
  readonly projectRoot?: string;
  readonly baseBranch?: string;
  readonly projects?: ProjectManager;
  readonly memory?: MemoryService;
  readonly directoryPicker?: DirectoryPicker;
  readonly uiRoot?: string;
  readonly instance?: InstanceIdentity;
  readonly onShutdown?: () => void;
}

export function createRaycoderServer(options: RaycoderServerOptions): Server {
  const executionErrors = new Map<string, string>();
  const projects = options.app?.projects ?? options.projects;
  const cleanup = projects === undefined ? undefined : new ProjectCleanupService(projects);
  return createServer((request, response) => {
    void route(request, response, options, executionErrors, cleanup).catch((error: unknown) => {
      const mapped = httpError(error);
      sendError(response, mapped.status, mapped.code, error, mapped.details);
    });
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: RaycoderServerOptions,
  executionErrors: Map<string, string>,
  cleanup?: ProjectCleanupService,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!validHost(request.headers.host)) {
    sendError(response, 403, "request.invalid_host", new Error("Only loopback requests are accepted"));
    return;
  }
  if (isMutation(request.method) && !validOrigin(request.headers.origin, request.headers.host)) {
    sendError(response, 403, "request.invalid_origin", new Error("Cross-origin mutations are not accepted"));
    return;
  }
  if (request.method === "GET" && ["/", "/app.js", "/styles.css"].includes(url.pathname)) {
    await sendUiAsset(response, url.pathname, options.uiRoot);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/instance") {
    if (options.instance === undefined || request.headers["x-raycoder-instance-nonce"] !== options.instance.nonce) {
      sendError(response, 404, "instance.not_found", new Error("Instance not found"));
      return;
    }
    const { nonce: _, ...publicIdentity } = options.instance;
    void _;
    sendJson(response, 200, publicIdentity);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/instance/shutdown") {
    if (options.instance === undefined || request.headers["x-raycoder-instance-nonce"] !== options.instance.nonce) {
      sendError(response, 404, "instance.not_found", new Error("Instance not found"));
      return;
    }
    if (options.onShutdown === undefined) {
      sendError(response, 409, "instance.shutdown_unavailable", new Error("Instance shutdown is unavailable"));
      return;
    }
    sendJson(response, 202, { shuttingDown: true });
    setImmediate(options.onShutdown);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/preflight") {
    sendJson(response, 200, currentPreflight(options));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/preflight/refresh") {
    sendJson(response, 200, options.app === undefined ? currentPreflight(options) : await options.app.refreshPreflight());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/system/directory-picker") {
    sendJson(response, 200, await (options.directoryPicker ?? new NativeDirectoryPicker()).selectDirectory());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config" && options.orchestrator !== undefined) {
    sendJson(response, 200, { integrationMode: options.orchestrator.integrationMode });
    return;
  }
  const memory = options.app?.memory ?? options.memory;
  if (memory !== undefined && request.method === "GET" && url.pathname === "/api/memory") {
    sendJson(response, 200, await memory.preflight(options.projectRoot));
    return;
  }
  if (memory !== undefined && options.projectRoot !== undefined && request.method === "POST" && url.pathname === "/api/memory/setup") {
    const body = await readJson(request);
    sendJson(response, 200, await memory.configureCodex(body.confirm === true, options.projectRoot));
    return;
  }
  const projects = options.app?.projects ?? options.projects;
  if (projects !== undefined && await routeProjects(request, response, url, projects, memory, currentPreflight(options), cleanup)) return;
  if (options.repository !== undefined && request.method === "GET" && url.pathname === "/api/tickets") {
    const repository = options.repository;
    sendJson(response, 200, {
      tickets: repository.list().map((ticket) => ({
        ...ticket,
        integrationAttempt: repository.latestIntegrationAttempt(ticket.id),
        ...(executionErrors.has(ticket.id) ? { error: executionErrors.get(ticket.id) } : {}),
      })),
    });
    return;
  }
  if (options.repository !== undefined && options.orchestrator !== undefined && options.baseBranch !== undefined
    && options.projectRoot !== undefined && request.method === "POST" && url.pathname === "/api/demo") {
    if (!currentPreflight(options).canExecute) {
      sendJson(response, 503, { error: "Preflight does not allow agent execution" });
      return;
    }
    const body = await readJson(request);
    const dirtyPolicy = body.dirtyPolicy;
    if (dirtyPolicy !== "cancel" && dirtyPolicy !== "committed-head") {
      sendJson(response, 400, { error: "dirtyPolicy must be an explicit cancel or committed-head choice" });
      return;
    }
    const id = `demo-${randomUUID()}`;
    const ticket = options.repository.create(createTicket({
      id,
      title: "Codex engine demonstration",
      description: "Create raycoder-demo.txt with a short success message, verify it, and commit the change.",
      baseBranch: options.baseBranch,
      hasPredecessors: false,
    }));
    void options.orchestrator
      .dispatch({ ticketId: id, projectRoot: options.projectRoot, dirtyPolicy })
      .catch((error: unknown) => {
        executionErrors.set(id, error instanceof Error ? error.message : String(error));
      });
    sendJson(response, 202, { ticket });
    return;
  }
  const integrationMatch = /^\/api\/tickets\/([^/]+)\/integration$/u.exec(url.pathname);
  if (options.orchestrator !== undefined && request.method === "POST" && integrationMatch !== null) {
    const encodedTicketId = integrationMatch[1];
    if (encodedTicketId === undefined) throw new Error("Missing ticket id");
    const ticketId = decodeURIComponent(encodedTicketId);
    const body = await readJson(request);
    if (body.action === "confirm" && typeof body.attemptId === "string") {
      sendJson(response, 200, await options.orchestrator.confirm(body.attemptId, ticketId));
      return;
    }
    if (body.action === "retry") {
      sendJson(response, 200, await options.orchestrator.retryIntegration(ticketId));
      return;
    }
    sendJson(response, 400, { error: "action must be confirm with an attemptId, or retry" });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

async function routeProjects(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  projects: ProjectManager,
  memory?: MemoryService,
  preflight?: PreflightReport,
  cleanup?: ProjectCleanupService,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, { projects: projects.list() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(request);
    if (body.action === "register" && typeof body.path === "string") {
      await projects.register(body.path, typeof body.name === "string" ? body.name : undefined);
    } else if (body.action === "create" && typeof body.path === "string" && body.confirmGitInit === true) {
      await projects.create({
        path: body.path,
        confirmGitInit: true,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
      });
    } else if (body.action === "initialize" && typeof body.path === "string" && body.confirmGitInit === true) {
      await projects.initialize({
        path: body.path,
        confirmGitInit: true,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
      });
    } else {
      sendError(response, 400, "project.invalid_action", new Error("Use register, create, or initialize with the required confirmation"));
      return true;
    }
    sendJson(response, 201, { projects: projects.list() });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/projects/inspect") {
    const body = await readJson(request);
    if (typeof body.path !== "string") {
      sendError(response, 400, "project.path_required", new Error("path is required"));
      return true;
    }
    sendJson(response, 200, await projects.inspect(body.path));
    return true;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
  if (projectMatch === null) return false;
  const encodedProjectId = projectMatch[1];
  if (encodedProjectId === undefined) return false;
  const projectId = decodeURIComponent(encodedProjectId);
  const tail = projectMatch[2] ?? "";
  if (request.method === "DELETE" && tail === "") {
    projects.remove(projectId);
    sendJson(response, 200, { projects: projects.list() });
    return true;
  }
  if (request.method === "POST" && tail === "open") {
    await projects.open(projectId);
    sendJson(response, 200, { project: projects.list().find((entry) => entry.project.id === projectId) });
    return true;
  }
  if (request.method === "POST" && tail === "cleanup/plan") {
    if (cleanup === undefined) throw new Error("Project cleanup is unavailable");
    sendJson(response, 200, await cleanup.plan(projectId));
    return true;
  }
  if (request.method === "POST" && tail === "cleanup/execute") {
    if (cleanup === undefined) throw new Error("Project cleanup is unavailable");
    const body = await readJson(request);
    if (typeof body.planId !== "string" || typeof body.fingerprint !== "string" || typeof body.confirmationPhrase !== "string") {
      sendError(response, 400, "cleanup.invalid_request", new Error("planId, fingerprint and confirmationPhrase are required"));
      return true;
    }
    if (body.selectedTargetIds !== undefined && (!Array.isArray(body.selectedTargetIds) || !body.selectedTargetIds.every((id) => typeof id === "string"))) {
      sendError(response, 400, "cleanup.invalid_targets", new Error("selectedTargetIds must be a string array"));
      return true;
    }
    sendJson(response, 200, await cleanup.execute({
      projectId,
      planId: body.planId,
      fingerprint: body.fingerprint,
      confirmationPhrase: body.confirmationPhrase,
      ...(body.selectedTargetIds === undefined ? {} : { selectedTargetIds: body.selectedTargetIds as string[] }),
      ...(body.force === true ? { force: true } : {}),
    }));
    return true;
  }
  const runtime = projects.get(projectId);
  if (request.method === "GET" && tail === "inspection") {
    sendJson(response, 200, await projects.inspect(runtime.projectRoot));
    return true;
  }
  if (request.method === "GET" && tail === "capabilities") {
    sendJson(response, 200, await runtime.capabilities());
    return true;
  }
  if (request.method === "GET" && tail === "settings") {
    sendJson(response, 200, runtime.settings === null ? null : {
      override: runtime.settings.projectOverride(),
      effective: await runtime.settings.effective([await runtime.capabilities()]),
    });
    return true;
  }
  if (request.method === "POST" && tail === "settings") {
    if (runtime.settings === null) {
      sendJson(response, 409, { error: "This runtime has no global configuration store" });
      return true;
    }
    const body = await readJson(request);
    const override = body.override;
    if (typeof override !== "object" || override === null || Array.isArray(override)) {
      sendJson(response, 400, { error: "override must be an object" });
      return true;
    }
    const capabilities = [await runtime.capabilities()];
    const typedOverride = override as ProjectConfigOverride;
    const effective = await runtime.settings.validateProjectOverride(typedOverride, capabilities);
    runtime.settings.setProjectOverride(typedOverride);
    await projects.reopen(projectId);
    sendJson(response, 200, { override, effective });
    return true;
  }
  if (request.method === "GET" && tail === "memory") {
    sendJson(response, 200, memory?.connection(projectId, runtime.projectRoot) ?? null);
    return true;
  }
  if (request.method === "GET" && tail === "planning") {
    const thread = runtime.repository.latestPlanningThread();
    const sessions = thread === null ? [] : runtime.repository.listPlanningSessions(thread.id);
    sendJson(response, 200, {
      artifacts: runtime.repository.listPlanningArtifacts(),
      thread,
      messages: thread === null ? [] : runtime.repository.planningMessages(thread.id),
      sessions,
      events: sessions.flatMap((session) => runtime.repository.planningEvents(session.id)),
      confirmation: runtime.repository.latestPlanningDagConfirmation(),
      recovery: runtime.planningRecovery,
      providerAvailable: preflight?.canExecute ?? true,
    });
    return true;
  }
  if (request.method === "POST" && tail === "planning/thread") {
    const capabilities = await runtime.capabilities();
    sendJson(response, 200, { thread: runtime.planning.ensureThread(capabilities.provider) });
    return true;
  }
  if (request.method === "GET" && tail === "planning/messages") {
    const thread = runtime.repository.latestPlanningThread();
    sendJson(response, 200, { messages: thread === null ? [] : runtime.repository.planningMessages(thread.id) });
    return true;
  }
  if (request.method === "GET" && tail === "planning/sessions") {
    sendJson(response, 200, { sessions: runtime.repository.listPlanningSessions() });
    return true;
  }
  if (request.method === "GET" && tail === "planning/recovery") {
    sendJson(response, 200, {
      interrupted: runtime.repository.listPlanningSessions().filter((session) => session.status === "interrupted"),
      recoveredAtOpen: runtime.planningRecovery,
    });
    return true;
  }
  const planningEvents = /^planning\/sessions\/([^/]+)\/events$/u.exec(tail);
  if (request.method === "GET" && planningEvents?.[1] !== undefined) {
    const sessionId = decodeURIComponent(planningEvents[1]);
    runtime.repository.getPlanningSession(sessionId);
    sendJson(response, 200, { events: runtime.repository.planningEvents(sessionId) });
    return true;
  }
  if (request.method === "POST" && tail === "planning/messages") {
    if (!providerAvailable(preflight, response)) return true;
    const body = await readJson(request);
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      sendError(response, 400, "planning.message_invalid", new Error("content is required"));
      return true;
    }
    const session = await runtime.planning.prepareMessage(body.content);
    schedulePlanning(runtime, session.id);
    sendJson(response, 202, { session });
    return true;
  }
  if (request.method === "POST" && tail === "planning/generations") {
    if (!providerAvailable(preflight, response)) return true;
    const body = await readJson(request);
    if (body.stage !== "spec" && body.stage !== "tickets") {
      sendError(response, 400, "planning.stage_invalid", new Error("stage must be spec or tickets"));
      return true;
    }
    const session = await runtime.planning.prepareGeneration(
      body.stage,
      typeof body.predecessorArtifactId === "string" ? body.predecessorArtifactId : undefined,
    );
    schedulePlanning(runtime, session.id);
    sendJson(response, 202, { session });
    return true;
  }
  const planningSessionAction = /^planning\/sessions\/([^/]+)\/actions$/u.exec(tail);
  if (request.method === "POST" && planningSessionAction?.[1] !== undefined) {
    const sessionId = decodeURIComponent(planningSessionAction[1]);
    const body = await readJson(request);
    if (body.action === "cancel") {
      sendJson(response, 200, { session: await runtime.scheduler.controlPlanning(async () => (
        await runtime.planning.cancel(sessionId)
      )) });
      return true;
    }
    if (body.action === "resume") {
      if (!providerAvailable(preflight, response)) return true;
      const session = await runtime.planning.prepareResume(sessionId);
      schedulePlanning(runtime, session.id);
      sendJson(response, 202, { session });
      return true;
    }
    sendError(response, 400, "planning.action_invalid", new Error("action must be cancel or resume"));
    return true;
  }
  if (request.method === "POST" && tail === "planning/specs") {
    const body = await readJson(request);
    if (typeof body.predecessorArtifactId !== "string" || typeof body.content !== "object" || body.content === null) {
      sendError(response, 400, "planning.spec_invalid", new Error("predecessorArtifactId and structured content are required"));
      return true;
    }
    sendJson(response, 201, {
      artifact: runtime.planning.editSpec(
        body.content as unknown as SpecContent,
        body.predecessorArtifactId,
        typeof body.replacesArtifactId === "string" ? body.replacesArtifactId : undefined,
      ),
    });
    return true;
  }
  if (request.method === "POST" && tail === "planning/ticket-plans") {
    const body = await readJson(request);
    if (!Array.isArray(body.tickets) || typeof body.predecessorArtifactId !== "string") {
      sendError(response, 400, "planning.ticket_plan_invalid", new Error("tickets and predecessorArtifactId are required"));
      return true;
    }
    sendJson(response, 201, {
      artifact: runtime.planning.proposeTickets(
        body.tickets as PlannedTicket[],
        body.predecessorArtifactId,
        typeof body.replacesArtifactId === "string" ? body.replacesArtifactId : undefined,
      ),
    });
    return true;
  }
  if (request.method === "POST" && tail === "planning/artifacts") {
    const body = await readJson(request);
    if (body.kind === "interrogation" && typeof body.markdown === "string") {
      sendJson(response, 201, { artifact: runtime.planning.recordInterrogation(body.markdown) });
      return true;
    }
    if (body.kind === "spec" && typeof body.markdown === "string" && typeof body.predecessorArtifactId === "string") {
      sendJson(response, 201, { artifact: runtime.planning.recordSpec(body.markdown, body.predecessorArtifactId) });
      return true;
    }
    if (body.kind === "tickets" && Array.isArray(body.tickets) && typeof body.predecessorArtifactId === "string") {
      sendJson(response, 201, { artifact: runtime.planning.proposeTickets(body.tickets as PlannedTicket[], body.predecessorArtifactId) });
      return true;
    }
    sendError(response, 400, "planning.artifact_invalid", new Error("Invalid planning artifact payload"));
    return true;
  }
  if (request.method === "POST" && tail === "planning/generate") {
    if (!providerAvailable(preflight, response)) return true;
    const body = await readJson(request);
    if ((body.kind !== "interrogation" && body.kind !== "spec") || typeof body.instruction !== "string") {
      sendError(response, 400, "planning.generation_invalid", new Error("kind interrogation|spec and instruction are required"));
      return true;
    }
    const session = body.kind === "interrogation"
      ? await runtime.planning.prepareMessage(body.instruction)
      : await runtime.planning.prepareGeneration("spec", typeof body.predecessorArtifactId === "string" ? body.predecessorArtifactId : undefined);
    schedulePlanning(runtime, session.id);
    sendJson(response, 202, { session });
    return true;
  }
  const planningAction = /^planning\/artifacts\/([^/]+)\/actions$/u.exec(tail);
  if (request.method === "POST" && planningAction?.[1] !== undefined) {
    const artifactId = decodeURIComponent(planningAction[1]);
    const body = await readJson(request);
    if (body.action === "approve") {
      sendJson(response, 200, { artifact: runtime.planning.approve(artifactId) });
      return true;
    }
    if (body.action === "confirm_tickets") {
      sendJson(response, 200, await runtime.scheduler.serialize(async () => runtime.planning.confirmTickets(artifactId)));
      return true;
    }
    sendError(response, 400, "planning.action_invalid", new Error("Unknown planning action"));
    return true;
  }
  if (request.method === "POST" && tail === "planning/dag/confirm") {
    const body = await readJson(request);
    if (typeof body.artifactId !== "string") {
      sendError(response, 400, "planning.revision_invalid", new Error("artifactId is required"));
      return true;
    }
    const artifactId = body.artifactId;
    sendJson(response, 200, await runtime.scheduler.serialize(async () => runtime.planning.confirmTickets(artifactId)));
    return true;
  }
  if (request.method === "GET" && tail === "skills") {
    sendJson(response, 200, await runtime.skills.ensureProjectSkills(runtime.projectRoot));
    return true;
  }
  if (request.method === "GET" && tail === "preview") {
    sendJson(response, 200, await runtime.preview.status(url.searchParams.get("ticketId") ?? undefined));
    return true;
  }
  if (request.method === "POST" && tail === "preview") {
    const body = await readJson(request);
    if (body.action === "start") {
      sendJson(response, 200, await runtime.preview.start(typeof body.ticketId === "string" ? body.ticketId : undefined));
      return true;
    }
    if (body.action === "stop") {
      runtime.preview.stop();
      sendJson(response, 200, await runtime.preview.status());
      return true;
    }
    sendJson(response, 400, { error: "Preview action must be start or stop" });
    return true;
  }
  if (request.method === "POST" && tail === "skills/restore") {
    const body = await readJson(request);
    if (body.confirm !== true) {
      sendJson(response, 400, { error: "Restoring the pinned skill bundle requires confirm=true" });
      return true;
    }
    sendJson(response, 200, await runtime.skills.restoreProjectSkills(runtime.projectRoot));
    return true;
  }
  if (request.method === "GET" && tail === "tickets") {
    sendJson(response, 200, { tickets: serializeTickets(runtime) });
    return true;
  }
  if (request.method === "POST" && tail === "tickets") {
    const body = await readJson(request);
    if (typeof body.title !== "string" || typeof body.description !== "string") {
      sendJson(response, 400, { error: "title and description are required" });
      return true;
    }
    const predecessorIds = Array.isArray(body.predecessorIds) && body.predecessorIds.every((id) => typeof id === "string")
      ? body.predecessorIds as string[]
      : [];
    const ticket = runtime.tickets.create({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      title: body.title,
      description: body.description,
      predecessorIds,
    });
    sendJson(response, 201, { ticket });
    return true;
  }
  if (request.method === "GET" && tail === "dependencies") {
    sendJson(response, 200, { dependencies: runtime.repository.dependencies() });
    return true;
  }

  const ticketMatch = /^tickets\/([^/]+)\/(history|sessions|dependencies|actions)$/u.exec(tail);
  if (ticketMatch === null) return false;
  const encodedTicketId = ticketMatch[1];
  const resource = ticketMatch[2];
  if (encodedTicketId === undefined || resource === undefined) return false;
  const ticketId = decodeURIComponent(encodedTicketId);
  if (request.method === "GET" && resource === "history") {
    sendJson(response, 200, {
      history: runtime.repository.history(ticketId),
      reviews: runtime.repository.reviewDecisions(ticketId),
      git: runtime.repository.gitObservations(ticketId),
    });
    return true;
  }
  if (request.method === "GET" && resource === "sessions") {
    sendJson(response, 200, {
      sessions: runtime.repository.listAgentSessions(ticketId).map((session) => ({
        ...session,
        processObservations: runtime.repository.processObservations(session.id),
      })),
    });
    return true;
  }
  if (request.method === "POST" && resource === "dependencies") {
    const body = await readJson(request);
    if (!Array.isArray(body.predecessorIds) || !body.predecessorIds.every((id) => typeof id === "string")) {
      sendJson(response, 400, { error: "predecessorIds must be a string array" });
      return true;
    }
    sendJson(response, 200, { ticket: runtime.tickets.replaceDependencies(ticketId, body.predecessorIds as string[]) });
    return true;
  }
  if (request.method === "POST" && resource === "actions") {
    const body = await readJson(request);
    if (body.action === "run") {
      if (preflight !== undefined && !preflight.canExecute) {
        sendError(response, 503, "provider.unavailable", new Error("No provider is currently available for agent execution"));
        return true;
      }
      if (!(await projects.inspect(runtime.projectRoot)).hasBaseCommit) {
        sendError(response, 409, "project.baseline_required", new Error("Create the first Git commit before running tickets"));
        return true;
      }
      const dirtyPolicy = body.dirtyPolicy === "committed-head" ? "committed-head" : "cancel";
      sendJson(response, 202, await runtime.scheduler.enqueue(ticketId, { dirtyPolicy }));
      return true;
    }
    if (body.action === "retry") {
      if (preflight !== undefined && !preflight.canExecute) {
        sendError(response, 503, "provider.unavailable", new Error("No provider is currently available for agent execution"));
        return true;
      }
      if (!(await projects.inspect(runtime.projectRoot)).hasBaseCommit) {
        sendError(response, 409, "project.baseline_required", new Error("Create the first Git commit before retrying tickets"));
        return true;
      }
      sendJson(response, 200, await runtime.tickets.retry(ticketId, body.dirtyPolicy === "committed-head" ? "committed-head" : "cancel"));
      return true;
    }
    if (body.action === "cancel") {
      sendJson(response, 200, { ticket: await runtime.tickets.cancel(ticketId) });
      return true;
    }
    if (body.action === "request_changes") {
      sendJson(response, 200, { ticket: runtime.tickets.requestChanges(ticketId, typeof body.reason === "string" ? body.reason : undefined) });
      return true;
    }
    if (body.action === "confirm" && typeof body.attemptId === "string") {
      sendJson(response, 200, await runtime.tickets.confirm(body.attemptId, ticketId));
      return true;
    }
    sendJson(response, 400, { error: "Unknown ticket action" });
    return true;
  }
  return false;
}

function serializeTickets(runtime: ProjectRuntime): unknown[] {
  return runtime.repository.list().map((ticket) => ({
    ...ticket,
    planningArtifactId: runtime.repository.ticketPlanningArtifactId(ticket.id),
    integrationAttempt: runtime.repository.latestIntegrationAttempt(ticket.id),
    review: runtime.repository.reviewDecisions(ticket.id).at(-1) ?? null,
  }));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const normalized = status >= 400 && typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string"
    ? { code: `http.${status}`, ...(value as Record<string, unknown>) }
    : value;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(normalized));
}

function sendError(response: ServerResponse, status: number, code: string, error: unknown, details?: unknown): void {
  sendJson(response, status, {
    error: error instanceof Error ? error.message : String(error),
    code,
    ...(details === undefined ? {} : { details }),
  });
}

function schedulePlanning(runtime: ProjectRuntime, sessionId: string): void {
  void runtime.scheduler.schedulePlanning(sessionId, async () => await runtime.planning.runSession(sessionId)).catch(() => undefined);
}

function providerAvailable(preflight: PreflightReport | undefined, response: ServerResponse): boolean {
  if (preflight === undefined || preflight.canExecute) return true;
  sendError(
    response,
    503,
    "provider.unavailable",
    new Error("No provider is currently available for planning generation"),
    { providers: preflight.providers },
  );
  return false;
}

function httpError(error: unknown): { status: number; code: string; details?: unknown } {
  if (error instanceof DependencyCycleError) return { status: 409, code: "planning.cycle" };
  if (error instanceof UnknownTicketError) return { status: 409, code: "planning.ticket_reference_invalid" };
  if (error instanceof PlanningBusyError) return { status: 409, code: "planning.operation_busy" };
  if (error instanceof PlanningResumeUnsupportedError) return { status: 409, code: "planning.resume_unsupported" };
  if (error instanceof PlanningInvalidStateError) return { status: 409, code: "planning.revision_invalid" };
  if (error instanceof PlanningGenerationError) {
    return { status: 502, code: "planning.generation_failed", details: { providerCode: error.providerCode } };
  }
  if (error instanceof SyntaxError) return { status: 400, code: "request.invalid_json" };
  if (error instanceof Error && /cannot be replaced|outside the previous plan depend|has started/u.test(error.message)) {
    return { status: 409, code: "planning.unsafe_replacement" };
  }
  if (error instanceof Error && /Unknown planning (artifact|session|thread)/u.test(error.message)) {
    return { status: 404, code: "planning.revision_invalid" };
  }
  return { status: 500, code: errorCode(error) };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "internal.error";
  return error.name.replace(/Error$/u, "").replace(/([a-z])([A-Z])/gu, "$1.$2").toLowerCase() || "internal.error";
}

function currentPreflight(options: RaycoderServerOptions): PreflightReport {
  const report = options.app?.preflight ?? options.preflight;
  if (report === undefined) throw new Error("Server requires a preflight report or application host");
  return report;
}

function isMutation(method: string | undefined): boolean {
  return method !== undefined && method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function validHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function validOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const value = new URL(origin);
    return value.protocol === "http:" && value.host === host;
  } catch {
    return false;
  }
}

async function sendUiAsset(response: ServerResponse, pathname: string, uiRoot?: string): Promise<void> {
  const root = uiRoot ?? fileURLToPath(new URL("./assets/ui", import.meta.url));
  const [file, contentType] = pathname === "/"
    ? ["index.html", "text/html; charset=utf-8"]
    : pathname === "/app.js" ? ["app.js", "text/javascript; charset=utf-8"] : ["styles.css", "text/css; charset=utf-8"];
  const contents = await readFile(join(root, file));
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(contents);
}
