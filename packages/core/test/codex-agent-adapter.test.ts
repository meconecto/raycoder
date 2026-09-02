import { describe, expect, it } from "vitest";
import { CodexAgentAdapter } from "../src/codex-agent-adapter.js";
import type { CodexRuntime, CodexRuntimeEvent, CodexRuntimeThread } from "../src/codex-runtime.js";

class FixtureThread implements CodexRuntimeThread {
  public providerSessionId: string | null = null;
  readonly #events: readonly CodexRuntimeEvent[];

  public constructor(events: readonly CodexRuntimeEvent[]) {
    this.#events = events;
  }

  public async *run(): AsyncIterable<CodexRuntimeEvent> {
    for (const event of this.#events) {
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        this.providerSessionId = event.thread_id;
      }
      yield event;
    }
  }
}

class FixtureRuntime implements CodexRuntime {
  readonly #thread: CodexRuntimeThread;

  public constructor(thread: CodexRuntimeThread) {
    this.#thread = thread;
  }

  public createThread(): CodexRuntimeThread {
    return this.#thread;
  }
}

describe("CodexAgentAdapter", () => {
  it("translates sessions and native SDK events without leaking their shapes", async () => {
    const thread = new FixtureThread([
      { type: "thread.started", thread_id: "provider-thread-1" },
      { type: "item.started", item: { id: "tool-1", type: "mcp_tool_call", server: "demo", tool: "read", arguments: { id: 1 } } },
      { type: "item.completed", item: { id: "tool-1", type: "mcp_tool_call", status: "completed", result: { value: 1 } } },
      { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "implemented" } },
      { type: "item.completed", item: { id: "file-1", type: "file_change", status: "completed", changes: [{ path: "src/demo.ts", kind: "add" }] } },
      { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "pnpm test", exit_code: 0, aggregated_output: "ok" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 } },
    ]);
    const adapter = new CodexAgentAdapter(new FixtureRuntime(thread));
    const session = await adapter.startSession({ workspace: "C:\\fixture" });
    const events = [];
    for await (const event of adapter.send(session, "test")) events.push(event);

    expect(session.providerSessionId).toBe("provider-thread-1");
    expect(events.map((event) => event.type)).toEqual([
      "tool_call",
      "tool_result",
      "assistant_message",
      "file_change",
      "command",
      "usage",
      "completed",
    ]);
    expect(events.find((event) => event.type === "file_change")).toMatchObject({ paths: ["src/demo.ts"] });
  });

  it("maps quota failures to a blocked-capable normalized error", async () => {
    const adapter = new CodexAgentAdapter(new FixtureRuntime(new FixtureThread([
      { type: "turn.failed", error: { message: "ChatGPT usage limit reached" } },
    ])));
    const session = await adapter.startSession({ workspace: "C:\\fixture" });
    const events = [];
    for await (const event of adapter.send(session, "test")) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "quota_exhausted", recoverable: true }),
      expect.objectContaining({ type: "completed", success: false }),
    ]);
  });

  it("cancels the active SDK turn through AbortSignal", async () => {
    let observedSignal: AbortSignal | undefined;
    const thread: CodexRuntimeThread = {
      providerSessionId: null,
      async *run(_prompt, signal) {
        observedSignal = signal;
        yield { type: "item.completed", item: { id: "message", type: "agent_message", text: "started" } };
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        throw new Error("aborted");
      },
    };
    const adapter = new CodexAgentAdapter(new FixtureRuntime(thread));
    const session = await adapter.startSession({ workspace: "C:\\fixture" });
    const iterator = adapter.send(session, "test")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "assistant_message" });
    await adapter.cancel(session);
    expect(observedSignal?.aborted).toBe(true);
    expect((await iterator.next()).value).toMatchObject({ type: "error", code: "cancelled" });
  });
});
