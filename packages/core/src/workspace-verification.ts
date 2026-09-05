import { createHash, randomUUID } from "node:crypto";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { isPathInside } from "./git-workspace.js";
import { ProcessExecutionError, type ProcessRunner } from "./process.js";
import type { TicketRepository, WorkspaceVerificationAttempt, WorkspaceVerificationPurpose } from "./ticket-repository.js";
import { sanitizeOutput } from "./workspace-preparation.js";

export type BuiltinVerificationStrategy = "pnpm" | "npm" | "yarn" | "bun" | "uv" | "poetry" | "pipenv" | "cargo" | "go";
export type WorkspaceVerificationUnitConfig =
  | { readonly root: string; readonly strategy: BuiltinVerificationStrategy }
  | { readonly root: string; readonly strategy: "bash" | "pwsh"; readonly script: string; readonly args?: readonly string[] };

export interface WorkspaceVerificationConfig {
  readonly mode: "auto" | "explicit";
  readonly units?: readonly WorkspaceVerificationUnitConfig[];
}

export interface WorkspaceVerificationCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface WorkspaceVerificationUnit {
  readonly root: string;
  readonly strategy: WorkspaceVerificationUnitConfig["strategy"];
  readonly executablePath: string | null;
  readonly toolVersion: string;
  readonly toolAvailable: boolean;
  readonly inputs: readonly { path: string; sha256: string }[];
  readonly commands: readonly WorkspaceVerificationCommand[];
}

export interface WorkspaceVerificationPlan {
  readonly fingerprint: string;
  readonly platform: string;
  readonly architecture: string;
  readonly applicable: boolean;
  readonly units: readonly WorkspaceVerificationUnit[];
  readonly executesProjectCode: boolean;
}

export interface WorkspaceVerificationApproval {
  readonly fingerprint: string;
  readonly allowVerification: true;
  readonly rememberForProject: true;
}

export class WorkspaceVerificationError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  public constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "WorkspaceVerificationError";
    this.code = code;
    this.details = details;
  }
}

interface ActiveVerification {
  readonly ticketId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly markSettled: () => void;
}

const configKey = "workspace_verification_config";
const approvalKey = "workspace_verification_approval_v2";

export class WorkspaceVerificationService {
  readonly #repository: TicketRepository;
  readonly #runner: ProcessRunner;
  #active: ActiveVerification | null = null;

  public constructor(repository: TicketRepository, runner: ProcessRunner) {
    this.#repository = repository;
    this.#runner = runner;
  }

  public config(): WorkspaceVerificationConfig {
    const raw = this.#repository.projectSettings()[configKey];
    return raw === undefined ? { mode: "auto" } : validateConfig(raw);
  }

  public setConfig(config: WorkspaceVerificationConfig): WorkspaceVerificationConfig {
    const validated = validateConfig(config);
    this.#repository.setProjectSetting(configKey, validated);
    this.revokeApproval();
    return validated;
  }

  public approval(): WorkspaceVerificationApproval | null {
    const raw = this.#repository.projectSettings()[approvalKey];
    return isApproval(raw) ? raw : null;
  }

  public revokeApproval(): void {
    this.#repository.deleteProjectSetting(approvalKey);
  }

  public recoverInterrupted(): WorkspaceVerificationAttempt[] {
    return this.#repository.interruptWorkspaceVerifications();
  }

  public async inspect(workspace: string): Promise<WorkspaceVerificationPlan> {
    return await buildPlan(resolve(workspace), this.config(), this.#runner);
  }

  public async authorize(input: {
    ticketId: string;
    workspace: string;
    targetCommit: string;
    purpose?: WorkspaceVerificationPurpose;
    integrationAttemptId?: string;
    approval?: WorkspaceVerificationApproval;
  }): Promise<WorkspaceVerificationPlan> {
    const workspace = resolve(input.workspace);
    const purpose = input.purpose ?? "dispatch";
    const latest = this.#repository.latestWorkspaceVerificationAttempt(input.ticketId, purpose);
    let plan: WorkspaceVerificationPlan;
    try {
      plan = await this.inspect(workspace);
    } catch (error) {
      if (!(error instanceof WorkspaceVerificationError)) throw error;
      const diagnosticPlan = diagnosticPlanFor(error, this.config(), input.targetCommit);
      const attempt = this.#create(input, diagnosticPlan, "UNAVAILABLE", latest?.id);
      this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
        diagnosticCode: error.code, diagnosticDetail: error.message, completedAt: new Date().toISOString(),
      });
      this.#blockDispatch(input.ticketId, purpose, "workspace_verification_invalid");
      throw new WorkspaceVerificationError(error.code, error.message, { plan: diagnosticPlan, purpose, attemptId: attempt.id });
    }
    if (!plan.applicable) {
      const attempt = this.#create(input, plan, "UNAVAILABLE", latest?.id);
      const message = "No unambiguous verification convention is available. Configure ordered verification units in Settings.";
      this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
        diagnosticCode: "verification.command_missing", diagnosticDetail: message, completedAt: new Date().toISOString(),
      });
      this.#blockDispatch(input.ticketId, purpose, "workspace_verification_unavailable");
      throw new WorkspaceVerificationError("verification.command_missing", message, { plan, purpose });
    }
    const unavailable = plan.units.find((unit) => !unit.toolAvailable);
    if (unavailable !== undefined) {
      const attempt = this.#create(input, plan, "UNAVAILABLE", latest?.id);
      const message = `${unavailable.strategy} is not executable on this host.`;
      this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
        diagnosticCode: "verification.tool_unavailable", diagnosticDetail: message, completedAt: new Date().toISOString(),
      });
      this.#blockDispatch(input.ticketId, purpose, "workspace_verification_tool_unavailable");
      throw new WorkspaceVerificationError("verification.tool_unavailable", message, { plan, purpose });
    }
    const supplied = input.approval;
    const stored = this.approval();
    const accepted = supplied?.fingerprint === plan.fingerprint && supplied.allowVerification === true && supplied.rememberForProject === true;
    if (supplied !== undefined && !accepted) {
      const attempt = this.#create(input, plan, "AWAITING_APPROVAL", latest?.id);
      throw new WorkspaceVerificationError("verification.plan_changed", "The verification plan changed before approval was applied.", { plan, purpose, attemptId: attempt.id });
    }
    if (stored?.fingerprint !== plan.fingerprint && !accepted) {
      const attempt = latest?.status === "AWAITING_APPROVAL" && latest.fingerprint === plan.fingerprint
        ? latest : this.#create(input, plan, "AWAITING_APPROVAL", latest?.id);
      throw new WorkspaceVerificationError("verification.approval_required", "Approve this project's verification plan before continuing.", { plan, purpose, attemptId: attempt.id });
    }
    if (accepted && supplied !== undefined) this.#repository.setProjectSetting(approvalKey, supplied);
    return plan;
  }

  public async verify(input: {
    ticketId: string;
    workspace: string;
    targetCommit: string;
    purpose?: WorkspaceVerificationPurpose;
    integrationAttemptId?: string;
    approval?: WorkspaceVerificationApproval;
  }): Promise<WorkspaceVerificationAttempt> {
    const workspace = resolve(input.workspace);
    const purpose = input.purpose ?? "dispatch";
    let plan: WorkspaceVerificationPlan;
    try {
      plan = await this.authorize(input);
    } catch (error) {
      if (error instanceof WorkspaceVerificationError) {
        const ticket = this.#repository.get(input.ticketId);
        if (purpose === "dispatch" && (ticket.status === "RUNNING" || ticket.status === "REVIEW")) {
          this.#repository.block(ticket.id, "workspace_verification_approval_required");
        }
      }
      throw error;
    }
    const latest = this.#repository.latestWorkspaceVerificationAttempt(input.ticketId, purpose);
    if (latest?.status === "PASSED" && latest.fingerprint === plan.fingerprint && latest.targetCommit === input.targetCommit) return latest;
    const activeApproval = input.approval ?? this.approval();

    const attempt = this.#create(input, plan, "QUEUED", latest?.id, activeApproval);
    const controller = new AbortController();
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((done) => { markSettled = done; });
    this.#active = { ticketId: input.ticketId, controller, settled, markSettled };
    this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
      status: "VERIFYING",
      process: { ownerPid: process.pid, startedAt: new Date().toISOString() },
    });
    const output: string[] = [];
    try {
      for (const unit of plan.units) {
        for (const command of unit.commands) {
          const result = await this.#runner.run(command.executable, command.args, {
            cwd: command.cwd,
            timeoutMs: 10 * 60_000,
            signal: controller.signal,
            env: verificationEnvironment(command.env),
            maxOutputBytes: 100_000,
            onSpawn: (childPid) => this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
              process: { ownerPid: process.pid, childPid, command: command.display, startedAt: new Date().toISOString() },
            }),
          });
          output.push(formatOutput(command.display, result.stdout, result.stderr));
        }
      }
      const status = await this.#runner.run("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: workspace, timeoutMs: 30_000, signal: controller.signal,
      });
      if (status.stdout.trim().length > 0) {
        throw new WorkspaceVerificationError(
          "verification.tracked_files_changed",
          "Workspace verification modified tracked files; the workspace was preserved for inspection.",
          { files: status.stdout.trim().split(/\r?\n/u) },
        );
      }
      return this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
        status: "PASSED", process: null, output: sanitizeOutput(output.join("\n\n")),
        diagnosticCode: null, diagnosticDetail: null, completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const detail = sanitizeOutput(errorDetail(error));
      this.#repository.updateWorkspaceVerificationAttempt(attempt.id, {
        status: cancelled ? "CANCELLED" : "FAILED",
        process: null,
        output: sanitizeOutput([...output, detail].join("\n\n")),
        diagnosticCode: cancelled ? "verification.cancelled" : error instanceof WorkspaceVerificationError ? error.code : "verification.failed",
        diagnosticDetail: detail,
        completedAt: new Date().toISOString(),
      });
      if (cancelled && purpose === "dispatch") {
        const ticket = this.#repository.get(input.ticketId);
        if (["READY", "RUNNING", "REVIEW"].includes(ticket.status)) {
          this.#repository.transition(ticket.id, "CANCELLED", "workspace_verification_cancelled");
        }
      } else {
        this.#blockDispatch(input.ticketId, purpose, "workspace_verification_failed");
      }
      throw error instanceof WorkspaceVerificationError
        ? error
        : new WorkspaceVerificationError(cancelled ? "verification.cancelled" : "verification.failed", detail, { attemptId: attempt.id, purpose });
    } finally {
      this.#active?.markSettled();
      this.#active = null;
    }
  }

  public async cancel(ticketId: string): Promise<boolean> {
    const active = this.#active;
    if (active?.ticketId !== ticketId) return false;
    active.controller.abort();
    await active.settled;
    return true;
  }

  #create(
    input: { ticketId: string; workspace: string; targetCommit: string; purpose?: WorkspaceVerificationPurpose; integrationAttemptId?: string },
    plan: WorkspaceVerificationPlan,
    status: WorkspaceVerificationAttempt["status"],
    resumedFromAttemptId?: string,
    approval?: WorkspaceVerificationApproval | null,
  ): WorkspaceVerificationAttempt {
    return this.#repository.createWorkspaceVerificationAttempt({
      id: randomUUID(), ticketId: input.ticketId, purpose: input.purpose ?? "dispatch", status,
      strategy: plan.units.map((unit) => unit.strategy).join("+") || "none", fingerprint: plan.fingerprint,
      plan, workspace: resolve(input.workspace), targetCommit: input.targetCommit,
      integrationAttemptId: input.integrationAttemptId ?? null,
      resumedFromAttemptId: resumedFromAttemptId ?? null,
      approval: approval ?? null,
    });
  }

  #blockDispatch(ticketId: string, purpose: WorkspaceVerificationPurpose, reason: string): void {
    if (purpose !== "dispatch") return;
    const ticket = this.#repository.get(ticketId);
    if (["READY", "RUNNING", "REVIEW", "READY_TO_MERGE"].includes(ticket.status)) this.#repository.block(ticketId, reason);
  }
}

async function buildPlan(root: string, config: WorkspaceVerificationConfig, runner: ProcessRunner): Promise<WorkspaceVerificationPlan> {
  const specs = config.mode === "explicit" ? config.units ?? [] : await autoDetect(root);
  const units: WorkspaceVerificationUnit[] = [];
  for (const spec of specs) units.push(await buildUnit(root, spec, runner));
  const material = {
    version: 2, platform: process.platform, architecture: process.arch,
    units: units.map((unit) => ({
      root: relative(root, unit.root).replaceAll("\\", "/"), strategy: unit.strategy,
      executablePath: unit.executablePath, toolVersion: unit.toolVersion, inputs: unit.inputs,
      commands: unit.commands.map((command) => ({ executable: command.executable, args: command.args, cwd: relative(root, command.cwd).replaceAll("\\", "/"), env: command.env })),
    })),
  };
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    platform: process.platform, architecture: process.arch, applicable: units.length > 0, units,
    executesProjectCode: units.length > 0,
  };
}

async function autoDetect(root: string): Promise<WorkspaceVerificationUnitConfig[]> {
  const candidates: WorkspaceVerificationUnitConfig[] = [];
  if (await exists(resolve(root, "package.json"))) {
    const locks = await matchingNodeManagers(root);
    if (locks.length !== 1) throw ambiguous("Node verification requires exactly one supported package-manager lockfile.");
    candidates.push({ root: ".", strategy: locks[0] as "pnpm" | "npm" | "yarn" | "bun" });
  }
  const python: BuiltinVerificationStrategy[] = [];
  if (await exists(resolve(root, "uv.lock"))) python.push("uv");
  if (await exists(resolve(root, "poetry.lock"))) python.push("poetry");
  if (await exists(resolve(root, "Pipfile.lock"))) python.push("pipenv");
  if (python.length > 1) throw ambiguous("Multiple Python verification strategies were detected.");
  if (python[0] !== undefined) candidates.push({ root: ".", strategy: python[0] });
  if (await exists(resolve(root, "Cargo.toml"))) candidates.push({ root: ".", strategy: "cargo" });
  if (await exists(resolve(root, "go.mod"))) candidates.push({ root: ".", strategy: "go" });
  if (candidates.length > 1) throw ambiguous("Multiple root stacks were detected; configure ordered verification units.");
  return candidates;
}

async function matchingNodeManagers(root: string): Promise<BuiltinVerificationStrategy[]> {
  const pairs = [["pnpm", "pnpm-lock.yaml"], ["npm", "package-lock.json"], ["npm", "npm-shrinkwrap.json"], ["yarn", "yarn.lock"], ["bun", "bun.lock"], ["bun", "bun.lockb"]] as const;
  const found = await Promise.all(pairs.map(async ([manager, path]) => await exists(resolve(root, path)) ? manager : null));
  return [...new Set(found.filter((value) => value !== null))];
}

async function buildUnit(root: string, spec: WorkspaceVerificationUnitConfig, runner: ProcessRunner): Promise<WorkspaceVerificationUnit> {
  const unitRoot = resolve(root, spec.root);
  if (unitRoot !== root && !isPathInside(root, unitRoot)) throw invalid("Verification unit root escapes the workspace.");
  if (!(await stat(unitRoot).catch(() => null))?.isDirectory()) throw invalid(`Verification unit root is not a directory: ${spec.root}`);
  const canonicalRoot = await realpath(root);
  const canonicalUnit = await realpath(unitRoot);
  if (canonicalUnit !== canonicalRoot && !isPathInside(canonicalRoot, canonicalUnit)) throw invalid(`Verification unit root resolves outside the workspace: ${spec.root}`);
  await assertInputs(unitRoot, spec);
  const commands = await commandsFor(unitRoot, spec);
  if (spec.strategy === "bash" || spec.strategy === "pwsh") await assertTrackedScript(root, unitRoot, spec.script, runner);
  const inputs = await hashInputs(unitRoot, inputsFor(spec));
  const executable = commands[0]?.executable;
  if (executable === undefined) throw invalid(`No commands are defined for ${spec.strategy}.`);
  const executablePath = await findExecutable(executable);
  let toolVersion = "unavailable";
  let toolAvailable = executablePath !== null;
  try {
    if (executablePath === null) throw new Error("missing tool");
    const version = await runner.run(executable, spec.strategy === "go" ? ["version"] : ["--version"], { cwd: unitRoot, timeoutMs: 15_000 });
    toolVersion = sanitizeOutput(`${version.stdout}\n${version.stderr}`).trim().slice(0, 500) || "unknown";
  } catch { toolAvailable = false; }
  return { root: unitRoot, strategy: spec.strategy, executablePath, toolVersion, toolAvailable, inputs, commands };
}

async function commandsFor(root: string, spec: WorkspaceVerificationUnitConfig): Promise<WorkspaceVerificationCommand[]> {
  const make = (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>): WorkspaceVerificationCommand => ({
    executable, args, cwd: root, display: [executable, ...args].join(" "), ...(env === undefined ? {} : { env }),
  });
  if (["pnpm", "npm", "yarn", "bun"].includes(spec.strategy)) {
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { scripts?: unknown; packageManager?: unknown };
    const scripts = readScripts(manifest.scripts);
    const selected = typeof scripts.verify === "string" && scripts.verify.trim() !== ""
      ? ["verify"]
      : ["typecheck", "lint", "test", "build"].filter((name) => typeof scripts[name] === "string" && scripts[name]?.trim() !== "");
    if (selected.length === 0 || (selected.length === 1 && selected[0] === "test" && /no test specified/iu.test(scripts.test ?? ""))) {
      throw new WorkspaceVerificationError("verification.command_missing", "Node project has no usable verify, typecheck, lint, test or build script.");
    }
    return selected.map((name) => make(spec.strategy, ["run", name]));
  }
  switch (spec.strategy) {
    case "uv": return [make("uv", ["run", "--locked", "pytest"])];
    case "poetry": return [make("poetry", ["run", "pytest"], { POETRY_VIRTUALENVS_IN_PROJECT: "true" })];
    case "pipenv": return [make("pipenv", ["run", "pytest"], { PIPENV_DONT_LOAD_ENV: "1", PIPENV_VENV_IN_PROJECT: "1" })];
    case "cargo": return [make("cargo", ["test", "--locked"])];
    case "go": return [make("go", ["test", "./..."], { GOFLAGS: "-mod=readonly" })];
    case "bash": return [make("bash", ["--noprofile", "--norc", spec.script, ...(spec.args ?? [])])];
    case "pwsh": return [make("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", spec.script, ...(spec.args ?? [])])];
    default: throw invalid(`Unsupported verification strategy: ${String(spec.strategy)}`);
  }
}

async function assertInputs(root: string, spec: WorkspaceVerificationUnitConfig): Promise<void> {
  const required = spec.strategy === "npm" ? [["package.json"], ["package-lock.json", "npm-shrinkwrap.json"]]
    : spec.strategy === "bun" ? [["package.json"], ["bun.lock", "bun.lockb"]]
      : spec.strategy === "go" ? [["go.mod"]]
        : spec.strategy === "bash" || spec.strategy === "pwsh" ? []
          : inputsFor(spec).filter((path) => path !== "go.sum").map((path) => [path]);
  for (const alternatives of required) if (!(await Promise.all(alternatives.map(async (path) => await exists(resolve(root, path))))).some(Boolean)) {
    throw invalid(`${spec.strategy} verification is missing ${alternatives.join(" or ")}.`);
  }
}

async function assertTrackedScript(root: string, unitRoot: string, scriptPath: string, runner: ProcessRunner): Promise<void> {
  const script = resolve(unitRoot, scriptPath);
  if (!isPathInside(root, script)) throw invalid("Verification script escapes the workspace.");
  const info = await lstat(script).catch(() => null);
  if (info?.isFile() !== true || info.isSymbolicLink()) throw invalid(`Verification script is not a regular file: ${scriptPath}`);
  try { await runner.run("git", ["ls-files", "--error-unmatch", relative(root, script)], { cwd: root, timeoutMs: 30_000 }); }
  catch { throw invalid(`Verification script must be tracked by Git: ${scriptPath}`); }
}

function inputsFor(spec: WorkspaceVerificationUnitConfig): readonly string[] {
  switch (spec.strategy) {
    case "pnpm": return ["package.json", "pnpm-lock.yaml"];
    case "npm": return ["package.json", "package-lock.json", "npm-shrinkwrap.json"];
    case "yarn": return ["package.json", "yarn.lock"];
    case "bun": return ["package.json", "bun.lock", "bun.lockb"];
    case "uv": return ["pyproject.toml", "uv.lock"];
    case "poetry": return ["pyproject.toml", "poetry.lock"];
    case "pipenv": return ["Pipfile", "Pipfile.lock"];
    case "cargo": return ["Cargo.toml", "Cargo.lock"];
    case "go": return ["go.mod", "go.sum"];
    case "bash": case "pwsh": return [spec.script];
  }
}

function validateConfig(value: unknown): WorkspaceVerificationConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Verification config must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "auto") return { mode: "auto" };
  if (candidate.mode !== "explicit" || !Array.isArray(candidate.units) || candidate.units.length === 0) throw invalid("Explicit verification requires at least one unit.");
  const strategies = ["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pipenv", "cargo", "go", "bash", "pwsh"];
  return { mode: "explicit", units: candidate.units.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Verification units must be objects.");
    const row = value as Record<string, unknown>;
    if (typeof row.root !== "string" || !strategies.includes(String(row.strategy))) throw invalid("Verification unit root and strategy are required.");
    if (row.strategy === "bash" || row.strategy === "pwsh") {
      if (typeof row.script !== "string" || (row.args !== undefined && (!Array.isArray(row.args) || !row.args.every((arg) => typeof arg === "string")))) throw invalid("Shell verification units require a script and optional string args.");
      return { root: row.root, strategy: row.strategy, script: row.script, ...(row.args === undefined ? {} : { args: row.args as string[] }) };
    }
    return { root: row.root, strategy: row.strategy as BuiltinVerificationStrategy };
  }) };
}

function isApproval(value: unknown): value is WorkspaceVerificationApproval {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.fingerprint === "string" && row.allowVerification === true && row.rememberForProject === true;
}

function diagnosticPlanFor(
  error: WorkspaceVerificationError,
  config: WorkspaceVerificationConfig,
  targetCommit: string,
): WorkspaceVerificationPlan {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 2, platform: process.platform, architecture: process.arch, targetCommit, config,
    diagnosticCode: error.code, diagnosticDetail: error.message,
  })).digest("hex");
  return { fingerprint, platform: process.platform, architecture: process.arch, applicable: false, units: [], executesProjectCode: false };
}

function readScripts(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function hashInputs(root: string, paths: readonly string[]): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!await exists(absolute)) continue;
    const info = await lstat(absolute).catch(() => null);
    if (info?.isFile() !== true || info.isSymbolicLink()) throw invalid(`Verification input is not a regular file: ${path}`);
    result.push({ path: path.replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
  }
  return result;
}

async function findExecutable(executable: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const candidates = isAbsolute(executable) ? [executable] : paths.flatMap((path) => extensions.map((extension) => resolve(path, `${executable}${extension}`)));
  for (const candidate of candidates) if ((await stat(candidate).catch(() => null))?.isFile()) return await realpath(candidate);
  return null;
}

function verificationEnvironment(overrides: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const allowed = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL"];
  const environment: Record<string, string> = {};
  for (const name of allowed) if (process.env[name] !== undefined) environment[name] = process.env[name] as string;
  return { ...environment, ...overrides };
}

function errorDetail(error: unknown): string {
  return error instanceof ProcessExecutionError
    ? [error.message, error.result.stdout, error.result.stderr].filter(Boolean).join("\n")
    : error instanceof Error ? error.message : String(error);
}

function formatOutput(display: string, stdout: string, stderr: string): string {
  const body = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return `$ ${display}${body === "" ? "" : `\n${body}`}`;
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function ambiguous(message: string): WorkspaceVerificationError { return new WorkspaceVerificationError("verification.strategy_ambiguous", message); }
function invalid(message: string): WorkspaceVerificationError { return new WorkspaceVerificationError("verification.custom_step_invalid", message); }
