import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Codex, type ModelReasoningEffort, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import type { StartSessionInput } from "./agent-adapter.js";

export type CodexRuntimeEvent = Readonly<Record<string, unknown>> & { readonly type: string };

export interface CodexRuntimeThread {
  readonly providerSessionId: string | null;
  run(prompt: string, signal: AbortSignal): AsyncIterable<CodexRuntimeEvent>;
}

export interface CodexRuntime {
  createThread(input: StartSessionInput): CodexRuntimeThread;
}

export class SdkCodexRuntime implements CodexRuntime {
  readonly #codex: Codex;

  public constructor(codex = new Codex()) {
    this.#codex = codex;
  }

  public createThread(input: StartSessionInput): CodexRuntimeThread {
    const options = {
      workingDirectory: input.workspace,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: false,
      skipGitRepoCheck: false,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { modelReasoningEffort: input.effort as ModelReasoningEffort }),
    };
    const thread = input.resumeProviderSessionId === undefined
      ? this.#codex.startThread(options)
      : this.#codex.resumeThread(input.resumeProviderSessionId, options);
    return new SdkRuntimeThread(thread);
  }
}

class SdkRuntimeThread implements CodexRuntimeThread {
  readonly #thread: Thread;

  public constructor(thread: Thread) {
    this.#thread = thread;
  }

  public get providerSessionId(): string | null {
    return this.#thread.id;
  }

  public async *run(prompt: string, signal: AbortSignal): AsyncIterable<CodexRuntimeEvent> {
    const result = await this.#thread.runStreamed(prompt, { signal });
    for await (const event of result.events) yield event as ThreadEvent as CodexRuntimeEvent;
  }
}

const runtimePackages: Readonly<Record<string, { packageName: string; triple: string; binary: string }>> = {
  "win32-x64": { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc", binary: "codex.exe" },
  "win32-arm64": { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc", binary: "codex.exe" },
  "darwin-x64": { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin", binary: "codex" },
  "darwin-arm64": { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin", binary: "codex" },
  "linux-x64": { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl", binary: "codex" },
  "linux-arm64": { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl", binary: "codex" },
};

export async function resolveCodexRuntimePath(): Promise<string> {
  const target = runtimePackages[`${process.platform}-${process.arch}`];
  if (target === undefined) throw new Error(`Codex SDK does not support ${process.platform}-${process.arch}`);
  const require = createRequire(import.meta.url);
  const codexPackage = require.resolve("@openai/codex/package.json");
  const packageRequire = createRequire(codexPackage);
  const platformPackage = packageRequire.resolve(`${target.packageName}/package.json`);
  const modern = join(dirname(platformPackage), "vendor", target.triple, "bin", target.binary);
  try {
    await access(modern);
    return modern;
  } catch {
    const legacy = join(dirname(platformPackage), "vendor", target.triple, "codex", target.binary);
    await access(legacy);
    return legacy;
  }
}
