import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Dispatcher, PreflightReport, TicketRepository } from "@raycoder/core";
import { createTicket } from "@raycoder/core";
import { UI_HTML } from "./ui.js";

export interface RaycoderServerOptions {
  readonly repository: TicketRepository;
  readonly dispatcher: Dispatcher;
  readonly preflight: PreflightReport;
  readonly projectRoot: string;
  readonly baseBranch: string;
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
  if (request.method === "GET" && url.pathname === "/api/tickets") {
    sendJson(response, 200, {
      tickets: options.repository.list().map((ticket) => ({
        ...ticket,
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
    void options.dispatcher.dispatch({ ticketId: id, projectRoot: options.projectRoot, dirtyPolicy }).catch((error: unknown) => {
      executionErrors.set(id, error instanceof Error ? error.message : String(error));
    });
    sendJson(response, 202, { ticket });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
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
