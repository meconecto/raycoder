import { randomUUID } from "node:crypto";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ProviderPreflight,
  StartSessionInput,
} from "./agent-adapter.js";
import { CodexPreflight } from "./codex-preflight.js";
import {
  SdkCodexRuntime,
  type CodexRuntime,
  type CodexRuntimeEvent,
  type CodexRuntimeThread,
} from "./codex-runtime.js";

interface SessionState {
  readonly thread: CodexRuntimeThread;
  readonly exposed: MutableAgentSession;
  controller: AbortController | null;
}

interface MutableAgentSession extends AgentSession {
  providerSessionId?: string;
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly #runtime: CodexRuntime;
  readonly #preflight: CodexPreflight;
  readonly #sessions = new Map<string, SessionState>();

  public constructor(runtime: CodexRuntime = new SdkCodexRuntime(), preflight = new CodexPreflight()) {
    this.#runtime = runtime;
    this.#preflight = preflight;
  }

  public async capabilities(): Promise<AdapterCapabilities> {
    return {
      provider: "codex",
      cancellation: true,
      resumableSessions: true,
      nativeSkills: true,
      sandboxModes: ["read-only", "workspace-write"],
      models: [
        {
          id: "default",
          efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"],
        },
      ],
    };
  }

  public async preflight(): Promise<ProviderPreflight> {
    return await this.#preflight.check();
  }

  public async startSession(input: StartSessionInput): Promise<AgentSession> {
    const thread = this.#runtime.createThread(input);
    const exposed: MutableAgentSession = {
      id: randomUUID(),
      provider: "codex",
      ...(thread.providerSessionId === null ? {} : { providerSessionId: thread.providerSessionId }),
    };
    this.#sessions.set(exposed.id, { thread, exposed, controller: null });
    return exposed;
  }

  public async *send(session: AgentSession, prompt: string): AsyncIterable<AgentEvent> {
    const state = this.#sessions.get(session.id);
    if (state === undefined) throw new Error(`Unknown Codex session: ${session.id}`);
    const controller = new AbortController();
    state.controller = controller;
    try {
      for await (const nativeEvent of state.thread.run(prompt, controller.signal)) {
        if (nativeEvent.type === "thread.started") {
          const providerSessionId = stringField(nativeEvent, "thread_id");
          if (providerSessionId !== undefined) state.exposed.providerSessionId = providerSessionId;
        }
        for (const event of translateCodexEvent(nativeEvent)) yield event;
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      yield {
        type: "error",
        timestamp: new Date().toISOString(),
        message: cancelled ? "Codex turn cancelled" : error instanceof Error ? error.message : String(error),
        code: cancelled ? "cancelled" : classifyError(error instanceof Error ? error.message : String(error)),
        recoverable: !cancelled && isQuotaError(error instanceof Error ? error.message : String(error)),
      };
      yield { type: "completed", timestamp: new Date().toISOString(), success: false, summary: cancelled ? "cancelled" : "Codex stream failed" };
    } finally {
      state.controller = null;
    }
  }

  public async cancel(session: AgentSession): Promise<void> {
    const state = this.#sessions.get(session.id);
    if (state === undefined) throw new Error(`Unknown Codex session: ${session.id}`);
    state.controller?.abort();
  }
}

export function translateCodexEvent(event: CodexRuntimeEvent, now = new Date().toISOString()): AgentEvent[] {
  if (event.type === "turn.completed") {
    const usage = objectField(event, "usage");
    return [
      {
        type: "usage",
        timestamp: now,
        inputTokens: numberField(usage, "input_tokens") ?? 0,
        outputTokens: numberField(usage, "output_tokens") ?? 0,
        cachedInputTokens: numberField(usage, "cached_input_tokens") ?? 0,
      },
      { type: "completed", timestamp: now, success: true },
    ];
  }
  if (event.type === "turn.failed") {
    const error = objectField(event, "error");
    const message = stringField(error, "message") ?? "Codex turn failed";
    return [
      { type: "error", timestamp: now, message, code: classifyError(message), recoverable: isQuotaError(message) },
      { type: "completed", timestamp: now, success: false, summary: message },
    ];
  }
  if (event.type === "error") {
    const message = stringField(event, "message") ?? "Codex stream error";
    return [
      { type: "error", timestamp: now, message, code: classifyError(message), recoverable: isQuotaError(message) },
      { type: "completed", timestamp: now, success: false, summary: message },
    ];
  }
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return [];
  const item = objectField(event, "item");
  const itemType = stringField(item, "type");
  const itemId = stringField(item, "id") ?? "codex-item";

  if (event.type === "item.started" && itemType === "mcp_tool_call") {
    return [{
      type: "tool_call",
      timestamp: now,
      callId: itemId,
      name: `${stringField(item, "server") ?? "mcp"}.${stringField(item, "tool") ?? "tool"}`,
      input: item.arguments,
    }];
  }
  if (event.type === "item.started" && itemType === "web_search") {
    return [{ type: "tool_call", timestamp: now, callId: itemId, name: "web_search", input: { query: stringField(item, "query") ?? "" } }];
  }
  if (event.type !== "item.completed") return [];

  switch (itemType) {
    case "agent_message":
      return [{ type: "assistant_message", timestamp: now, text: stringField(item, "text") ?? "" }];
    case "command_execution":
      return [{
        type: "command",
        timestamp: now,
        command: stringField(item, "command") ?? "",
        exitCode: numberField(item, "exit_code") ?? -1,
        output: stringField(item, "aggregated_output") ?? "",
      }];
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.flatMap((change) => {
        const path = stringField(change, "path");
        return typeof path === "string" ? [path] : [];
      });
      const summary = stringField(item, "status");
      return [{
        type: "file_change",
        timestamp: now,
        paths,
        ...(summary === undefined ? {} : { summary }),
      }];
    }
    case "mcp_tool_call":
      return [{
        type: "tool_result",
        timestamp: now,
        callId: itemId,
        success: stringField(item, "status") === "completed",
        output: safeJson(item.result ?? item.error ?? null),
      }];
    case "web_search":
      return [{ type: "tool_result", timestamp: now, callId: itemId, success: true, output: stringField(item, "query") ?? "" }];
    case "error":
      return [{ type: "warning", timestamp: now, code: "codex.item_error", message: stringField(item, "message") ?? "Codex item error" }];
    case "reasoning":
      return [{ type: "warning", timestamp: now, code: "codex.reasoning_summary", message: stringField(item, "text") ?? "" }];
    case "todo_list":
      return [{ type: "assistant_message", timestamp: now, text: safeJson(item.items ?? []) }];
    default:
      return [];
  }
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const candidate = value as Record<string, unknown>;
  const field = candidate[key];
  return typeof field === "object" && field !== null ? field as Record<string, unknown> : {};
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isQuotaError(message: string): boolean {
  return /quota|credit|usage limit|rate limit/iu.test(message);
}

function classifyError(message: string): string {
  return isQuotaError(message) ? "quota_exhausted" : "codex.error";
}
