import type { Codex, Thread, ThreadOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import { SdkCodexRuntime } from "../src/codex-runtime.js";

describe("SdkCodexRuntime", () => {
  it("maps narrowly scoped writable directories to a new Codex thread", () => {
    let observed: ThreadOptions | undefined;
    const thread = { id: "thread-new" } as unknown as Thread;
    const codex = {
      startThread(options: ThreadOptions) {
        observed = options;
        return thread;
      },
    } as unknown as Codex;

    const runtime = new SdkCodexRuntime(codex);
    expect(runtime.createThread({
      workspace: "C:\\fixture\\workspace",
      additionalWritableDirectories: ["C:\\fixture\\.git\\objects", "C:\\fixture\\.git\\refs\\heads\\raycoder"],
    }).providerSessionId).toBe("thread-new");
    expect(observed).toMatchObject({
      workingDirectory: "C:\\fixture\\workspace",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      additionalDirectories: ["C:\\fixture\\.git\\objects", "C:\\fixture\\.git\\refs\\heads\\raycoder"],
    });
  });

  it("keeps the same sandbox boundary when resuming a Codex thread", () => {
    let observedId: string | undefined;
    let observed: ThreadOptions | undefined;
    const codex = {
      resumeThread(id: string, options: ThreadOptions) {
        observedId = id;
        observed = options;
        return { id } as unknown as Thread;
      },
    } as unknown as Codex;

    new SdkCodexRuntime(codex).createThread({
      workspace: "/fixture/workspace",
      additionalWritableDirectories: ["/fixture/.git/worktrees/ticket"],
      resumeProviderSessionId: "thread-existing",
    });
    expect(observedId).toBe("thread-existing");
    expect(observed?.additionalDirectories).toEqual(["/fixture/.git/worktrees/ticket"]);
  });
});
