import { NodeProcessRunner, ProcessExecutionError, type ProcessRunner } from "@raycoder/core";

export interface DirectoryPickerResult {
  readonly status: "selected" | "cancelled" | "unavailable";
  readonly path?: string;
  readonly diagnostic?: string;
}

export interface DirectoryPicker {
  selectDirectory(): Promise<DirectoryPickerResult>;
}

export class NativeDirectoryPicker implements DirectoryPicker {
  readonly #platform: NodeJS.Platform;
  readonly #runner: ProcessRunner;

  public constructor(platform = process.platform, runner: ProcessRunner = new NodeProcessRunner()) {
    this.#platform = platform;
    this.#runner = runner;
  }

  public async selectDirectory(): Promise<DirectoryPickerResult> {
    if (this.#platform === "win32") return await this.#windows();
    if (this.#platform === "darwin") return await this.#macos();
    if (this.#platform === "linux") return await this.#linux();
    return { status: "unavailable", diagnostic: `No directory picker is available for ${this.#platform}.` };
  }

  async #windows(): Promise<DirectoryPickerResult> {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Select a project folder for raycoder'",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
    ].join("; ");
    try {
      const output = await this.#runner.run("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        cwd: process.cwd(),
        timeoutMs: 300_000,
      });
      return selected(output.stdout);
    } catch (error) {
      return { status: "unavailable", diagnostic: errorMessage(error) };
    }
  }

  async #macos(): Promise<DirectoryPickerResult> {
    try {
      const output = await this.#runner.run("osascript", ["-e", "POSIX path of (choose folder with prompt \"Select a project folder for raycoder\")"], {
        cwd: process.cwd(),
        timeoutMs: 300_000,
      });
      return selected(output.stdout);
    } catch (error) {
      if (error instanceof ProcessExecutionError && /cancel/iu.test(error.result.stderr)) return { status: "cancelled" };
      return { status: "unavailable", diagnostic: errorMessage(error) };
    }
  }

  async #linux(): Promise<DirectoryPickerResult> {
    for (const [command, args] of [
      ["zenity", ["--file-selection", "--directory", "--title=Select a project folder for raycoder"]],
      ["kdialog", ["--getexistingdirectory", process.cwd(), "--title", "Select a project folder for raycoder"]],
    ] as const) {
      try {
        const output = await this.#runner.run(command, args, { cwd: process.cwd(), timeoutMs: 300_000 });
        return selected(output.stdout);
      } catch (error) {
        if (error instanceof ProcessExecutionError && error.result.exitCode === 1) return { status: "cancelled" };
      }
    }
    return { status: "unavailable", diagnostic: "Install zenity or kdialog, or enter the path manually." };
  }
}

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export class NativeBrowserOpener implements BrowserOpener {
  readonly #platform: NodeJS.Platform;
  readonly #runner: ProcessRunner;

  public constructor(platform = process.platform, runner: ProcessRunner = new NodeProcessRunner()) {
    this.#platform = platform;
    this.#runner = runner;
  }

  public async open(url: string): Promise<void> {
    const command = this.#platform === "win32" ? "explorer.exe" : this.#platform === "darwin" ? "open" : "xdg-open";
    await this.#runner.run(command, [url], { cwd: process.cwd(), timeoutMs: 15_000 });
  }
}

function selected(output: string): DirectoryPickerResult {
  const path = output.trim();
  return path.length === 0 ? { status: "cancelled" } : { status: "selected", path };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
