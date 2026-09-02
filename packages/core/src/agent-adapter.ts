export interface AdapterCapabilities {
  readonly provider: string;
  readonly cancellation: boolean;
  readonly resumableSessions: boolean;
  readonly nativeSkills: boolean;
  readonly sandboxModes: readonly string[];
  readonly models: readonly { id: string; efforts: readonly string[] | null }[];
}

export interface ProviderPreflight {
  readonly provider: string;
  readonly executable: boolean;
  readonly diagnostics: readonly {
    level: "ok" | "warning" | "error";
    code: string;
    message: string;
    action?: string;
  }[];
}

export interface AgentSession {
  readonly id: string;
  readonly provider: string;
  readonly providerSessionId?: string;
}

export interface StartSessionInput {
  readonly workspace: string;
  readonly purpose?: "implementation" | "review" | "planning";
  readonly model?: string;
  readonly effort?: string;
  readonly resumeProviderSessionId?: string;
}

interface EventBase {
  readonly timestamp: string;
}

export type AgentEvent =
  | (EventBase & { readonly type: "assistant_message"; readonly text: string })
  | (EventBase & { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: unknown })
  | (EventBase & { readonly type: "tool_result"; readonly callId: string; readonly success: boolean; readonly output: string })
  | (EventBase & { readonly type: "file_change"; readonly paths: readonly string[]; readonly summary?: string })
  | (EventBase & { readonly type: "command"; readonly command: string; readonly cwd?: string; readonly exitCode?: number; readonly output?: string })
  | (EventBase & { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number })
  | (EventBase & { readonly type: "warning"; readonly message: string; readonly code?: string })
  | (EventBase & { readonly type: "review_decision"; readonly verdict: "approved" | "changes_requested"; readonly summary: string; readonly findings: readonly string[] })
  | (EventBase & { readonly type: "error"; readonly message: string; readonly code?: string; readonly recoverable: boolean })
  | (EventBase & { readonly type: "completed"; readonly success: boolean; readonly summary?: string });

export interface AgentAdapter {
  capabilities(): Promise<AdapterCapabilities>;
  preflight(): Promise<ProviderPreflight>;
  startSession(input: StartSessionInput): Promise<AgentSession>;
  send(session: AgentSession, prompt: string): AsyncIterable<AgentEvent>;
  cancel(session: AgentSession): Promise<void>;
}
