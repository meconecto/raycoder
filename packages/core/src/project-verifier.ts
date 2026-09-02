import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeProcessRunner, ProcessExecutionError, type ProcessRunner } from "./process.js";

export interface VerificationResult {
  readonly status: "PASSED" | "FAILED" | "UNAVAILABLE";
  readonly commands: readonly string[];
  readonly output: string;
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
}

export interface VerificationStrategy {
  verify(projectRoot: string): Promise<VerificationResult>;
}

export type ProjectVerifier = VerificationStrategy;

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

interface PackageJson {
  readonly packageManager?: unknown;
  readonly scripts?: unknown;
}

const lockfiles: Readonly<Record<PackageManager, readonly string[]>> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

const verificationScriptOrder = ["typecheck", "lint", "test", "build"] as const;

export class NodeProjectVerifier implements VerificationStrategy {
  readonly #runner: ProcessRunner;

  public constructor(runner: ProcessRunner = new NodeProcessRunner()) {
    this.#runner = runner;
  }

  public async verify(projectRoot: string): Promise<VerificationResult> {
    let manifest: PackageJson;
    try {
      manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as PackageJson;
    } catch (error) {
      const detail = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "No package.json was found in the reconciled project."
        : `package.json could not be read: ${error instanceof Error ? error.message : String(error)}`;
      return unavailable("verification_not_node_project", detail);
    }

    const detected = await this.#detectPackageManager(projectRoot, manifest.packageManager);
    if (detected.error !== null) return unavailable(detected.error.code, detected.error.detail);

    const scripts = readScripts(manifest.scripts);
    const selectedScripts = typeof scripts.verify === "string" && scripts.verify.trim().length > 0
      ? ["verify"]
      : verificationScriptOrder.filter((name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0);
    if (selectedScripts.length === 0) {
      return unavailable("verification_scripts_missing", "No verify, typecheck, lint, test, or build script is available.");
    }
    if (selectedScripts.length === 1 && selectedScripts[0] === "test" && /no test specified/iu.test(scripts.test ?? "")) {
      return unavailable("verification_placeholder_test", "The only verification script is the default placeholder test.");
    }

    const manager = detected.manager;
    const commands = [installCommand(manager), ...selectedScripts.map((script) => scriptCommand(manager, script))];
    const output: string[] = [];
    for (const command of commands) {
      try {
        const result = await this.#runner.run(command.command, command.args, { cwd: projectRoot, timeoutMs: 10 * 60_000 });
        output.push(formatOutput(command.display, result.stdout, result.stderr));
      } catch (error) {
        if (error instanceof ProcessExecutionError) {
          output.push(formatOutput(command.display, error.result.stdout, error.result.stderr));
          return {
            status: "FAILED",
            commands: commands.map((candidate) => candidate.display),
            output: output.join("\n\n"),
            diagnosticCode: "verification_failed",
            diagnosticDetail: `${command.display} exited with code ${error.result.exitCode}.`,
          };
        }
        return unavailable(
          "verification_unavailable",
          `${command.command} could not be executed: ${error instanceof Error ? error.message : String(error)}`,
          commands.map((candidate) => candidate.display),
          output.join("\n\n"),
        );
      }
    }

    return {
      status: "PASSED",
      commands: commands.map((command) => command.display),
      output: output.join("\n\n"),
      diagnosticCode: null,
      diagnosticDetail: null,
    };
  }

  async #detectPackageManager(
    projectRoot: string,
    declaredValue: unknown,
  ): Promise<{ manager: PackageManager; error: null } | { manager: null; error: { code: string; detail: string } }> {
    const matches: PackageManager[] = [];
    for (const [manager, names] of Object.entries(lockfiles) as [PackageManager, readonly string[]][]) {
      if (await anyExists(projectRoot, names)) matches.push(manager);
    }
    if (matches.length === 0) {
      return { manager: null, error: { code: "verification_lockfile_missing", detail: "No supported lockfile was found." } };
    }
    if (matches.length > 1) {
      return {
        manager: null,
        error: { code: "verification_lockfile_ambiguous", detail: `Multiple package managers were detected: ${matches.join(", ")}.` },
      };
    }

    const manager = matches[0];
    if (manager === undefined) throw new Error("Package-manager detection invariant failed");
    const declared = typeof declaredValue === "string" ? declaredValue.split("@")[0] : undefined;
    if (declared !== undefined && declared !== manager) {
      return {
        manager: null,
        error: {
          code: "verification_package_manager_mismatch",
          detail: `packageManager declares ${declared}, but the lockfile selects ${manager}.`,
        },
      };
    }
    return { manager, error: null };
  }
}

async function anyExists(projectRoot: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    try {
      await access(join(projectRoot, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

function readScripts(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function installCommand(manager: PackageManager): { command: string; args: readonly string[]; display: string } {
  switch (manager) {
    case "pnpm": return command("pnpm", ["install", "--frozen-lockfile"]);
    case "npm": return command("npm", ["ci"]);
    case "yarn": return command("yarn", ["install", "--immutable"]);
    case "bun": return command("bun", ["install", "--frozen-lockfile"]);
  }
}

function scriptCommand(manager: PackageManager, script: string): { command: string; args: readonly string[]; display: string } {
  return manager === "npm" ? command(manager, ["run", script]) : command(manager, ["run", script]);
}

function command(executable: string, args: readonly string[]): { command: string; args: readonly string[]; display: string } {
  return { command: executable, args, display: [executable, ...args].join(" ") };
}

function unavailable(
  code: string,
  detail: string,
  commands: readonly string[] = [],
  output = "",
): VerificationResult {
  return { status: "UNAVAILABLE", commands, output, diagnosticCode: code, diagnosticDetail: detail };
}

function formatOutput(display: string, stdout: string, stderr: string): string {
  const content = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join("\n");
  return `$ ${display}${content.length > 0 ? `\n${content}` : ""}`.slice(0, 100_000);
}
