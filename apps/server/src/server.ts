import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PreflightReport, ProjectManager, ProjectOrchestrator, ProjectRuntime, TicketRepository } from "@raycoder/core";
import { createTicket } from "@raycoder/core";
import { UI_HTML } from "./ui.js";

export interface RaycoderServerOptions {
  readonly repository: TicketRepository;
  readonly orchestrator: ProjectOrchestrator;
  readonly preflight: PreflightReport;
  readonly projectRoot: string;
  readonly baseBranch: string;
  readonly projects?: ProjectManager;
}

export function createRaycoderServer(options: RaycoderServerOptions): Server {
  const executionErrors = new Map<string, string>();
  return createServer((request, response) => {
    void route(request, response, options, executionErrors).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: RaycoderServerOptions,
  executionErrors: Map<string, string>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(UI_HTML);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/preflight") {
    sendJson(response, 200, options.preflight);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { integrationMode: options.orchestrator.integrationMode });
    return;
  }
  if (options.projects !== undefined && await routeProjects(request, response, url, options.projects)) return;
  if (request.method === "GET" && url.pathname === "/api/tickets") {
    sendJson(response, 200, {
      tickets: options.repository.list().map((ticket) => ({
        ...ticket,
        integrationAttempt: options.repository.latestIntegrationAttempt(ticket.id),
        ...(executionErrors.has(ticket.id) ? { error: executionErrors.get(ticket.id) } : {}),
      })),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/demo") {
    if (!options.preflight.canStart) {
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
  if (request.method === "POST" && integrationMatch !== null) {
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
    } else {
      sendJson(response, 400, { error: "Use action register with path, or action create with path and confirmGitInit=true" });
      return true;
    }
    sendJson(response, 201, { projects: projects.list() });
    return true;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
  if (projectMatch === null) return false;
  const encodedProjectId = projectMatch[1];
  if (encodedProjectId === undefined) return false;
  const projectId = decodeURIComponent(encodedProjectId);
  const tail = projectMatch[2] ?? "";
  if (request.method === "POST" && tail === "open") {
    await projects.open(projectId);
    sendJson(response, 200, { project: projects.list().find((entry) => entry.project.id === projectId) });
    return true;
  }
  const runtime = projects.get(projectId);
  if (request.method === "GET" && tail === "capabilities") {
    sendJson(response, 200, await runtime.capabilities());
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
      const dirtyPolicy = body.dirtyPolicy === "committed-head" ? "committed-head" : "cancel";
      sendJson(response, 202, await runtime.scheduler.enqueue(ticketId, { dirtyPolicy }));
      return true;
    }
    if (body.action === "retry") {
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
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
