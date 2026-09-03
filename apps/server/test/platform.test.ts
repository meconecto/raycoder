import { describe, expect, it } from "vitest";
import { ProcessExecutionError, type ProcessResult, type ProcessRunner } from "@raycoder/core";
import { NativeBrowserOpener, NativeDirectoryPicker } from "../src/platform.js";

class RecordingRunner implements ProcessRunner {
  public readonly calls: { command: string; args: readonly string[] }[] = [];
  readonly #outputs: (string | Error)[];

  public constructor(outputs: (string | Error)[] = [""]) {
    this.#outputs = [...outputs];
  }

  public async run(command: string, args: readonly string[], options: { cwd: string }): Promise<ProcessResult> {
    this.calls.push({ command, args });
    const output = this.#outputs.shift() ?? "";
    if (output instanceof Error) throw output;
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: output, stderr: "" };
  }
}

function processError(command: string, exitCode: number, stderr = ""): ProcessExecutionError {
  return new ProcessExecutionError({ command, args: [], cwd: process.cwd(), exitCode, stdout: "", stderr });
}

describe("platform adapters", () => {
  it.each([
    ["win32", "explorer.exe"], ["darwin", "open"], ["linux", "xdg-open"],
  ] as const)("opens a browser on %s without shell commands", async (platform, command) => {
    const runner = new RecordingRunner();
    await new NativeBrowserOpener(platform, runner).open("http://127.0.0.1:4317/");
    expect(runner.calls).toEqual([{ command, args: ["http://127.0.0.1:4317/"] }]);
  });

  it("uses the fixed PowerShell directory picker on Windows", async () => {
    const runner = new RecordingRunner(["C:\\work\\project"]);
    await expect(new NativeDirectoryPicker("win32", runner).selectDirectory()).resolves.toEqual({ status: "selected", path: "C:\\work\\project" });
    expect(runner.calls[0]).toMatchObject({ command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", expect.stringContaining("FolderBrowserDialog")] });
  });

  it("distinguishes cancellation from unavailable Linux dialogs", async () => {
    const cancelled = new RecordingRunner([processError("zenity", 1)]);
    await expect(new NativeDirectoryPicker("linux", cancelled).selectDirectory()).resolves.toEqual({ status: "cancelled" });
    const unavailable = new RecordingRunner([processError("zenity", 127), processError("kdialog", 127)]);
    await expect(new NativeDirectoryPicker("linux", unavailable).selectDirectory()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("uses osascript and reports a cancelled macOS picker", async () => {
    const selected = new RecordingRunner(["/Users/test/project/\n"]);
    await expect(new NativeDirectoryPicker("darwin", selected).selectDirectory()).resolves.toEqual({ status: "selected", path: "/Users/test/project/" });
    expect(selected.calls[0]).toMatchObject({ command: "osascript" });
    const cancelled = new RecordingRunner([processError("osascript", 1, "User canceled")]);
    await expect(new NativeDirectoryPicker("darwin", cancelled).selectDirectory()).resolves.toEqual({ status: "cancelled" });
  });
});
