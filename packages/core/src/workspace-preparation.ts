import { createHash, randomUUID } from "node:crypto";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import type { DirtyWorkspacePolicy, GitWorkspaceManager } from "./git-workspace.js";
import { isPathInside } from "./git-workspace.js";
import { ProcessExecutionError, type ProcessRunner } from "./process.js";
import type { TicketRepository, WorkspacePreparationAttempt } from "./ticket-repository.js";

export type BuiltinPreparationStrategy =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "uv"
  | "poetry"
  | "pipenv"
  | "cargo"
  | "go";

export type WorkspacePreparationUnitConfig =
  | { readonly root: string; readonly strategy: BuiltinPreparationStrategy }
  | { readonly root: string; readonly strategy: "bash" | "pwsh"; readonly script: string; readonly args?: readonly string[] };

export interface WorkspacePreparationConfig {
  readonly mode: "auto" | "explicit";
  readonly units?: readonly WorkspacePreparationUnitConfig[];
}

export interface WorkspacePreparationCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface WorkspacePreparationUnit {
  readonly root: string;
  readonly strategy: BuiltinPreparationStrategy | "bash" | "pwsh";
  readonly executablePath: string | null;
  readonly toolVersion: string;
  readonly toolAvailable: boolean;
  readonly inputs: readonly { path: string; sha256: string }[];
  readonly commands: readonly WorkspacePreparationCommand[];
}

export interface WorkspacePreparationPlan {
  readonly fingerprint: string;
  readonly platform: string;
  readonly architecture: string;
  readonly applicable: boolean;
  readonly units: readonly WorkspacePreparationUnit[];
  readonly mayUseNetwork: boolean;
  readonly executesProjectCode: boolean;
}

export interface WorkspacePreparationApproval {
  readonly fingerprint: string;
  readonly allowNetwork: true;
  readonly allowInstallScripts: true;
  readonly rememberForProject: true;
}

export class WorkspacePreparationError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  public constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "WorkspacePreparationError";
    this.code = code;
    this.details = details;
  }
}

interface ActivePreparation {
  readonly ticketId: string;
  readonly attemptId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly markSettled: () => void;
}

const configKey = "workspace_preparation_config";
const approvalKey = "workspace_preparation_approval";

export class WorkspacePreparationService {
  readonly #repository: TicketRepository;
  readonly #workspaces: GitWorkspaceManager;
  readonly #runner: ProcessRunner;
  #active: ActivePreparation | null = null;

  public constructor(repository: TicketRepository, workspaces: GitWorkspaceManager, runner: ProcessRunner) {
    this.#repository = repository;
    this.#workspaces = workspaces;
    this.#runner = runner;
  }

  public config(): WorkspacePreparationConfig {
    const raw = this.#repository.projectSettings()[configKey];
    if (raw === undefined) return { mode: "auto" };
    return validateConfig(raw);
  }

  public setConfig(config: WorkspacePreparationConfig): WorkspacePreparationConfig {
    const validated = validateConfig(config);
    this.#repository.setProjectSetting(configKey, validated);
    this.revokeApproval();
    return validated;
  }

  public approval(): WorkspacePreparationApproval | null {
    const raw = this.#repository.projectSettings()[approvalKey];
    return isApproval(raw) ? raw : null;
  }

  public revokeApproval(): void {
    this.#repository.deleteProjectSetting(approvalKey);
  }

  public recoverInterrupted(): WorkspacePreparationAttempt[] {
    return this.#repository.interruptWorkspacePreparations();
  }

  public async inspect(workspace: string): Promise<WorkspacePreparationPlan> {
    return await buildPlan(resolve(workspace), this.config(), this.#runner);
  }

  public async prepareTicket(input: {
    ticketId: string;
    projectRoot: string;
    dirtyPolicy: DirtyWorkspacePolicy;
    approval?: WorkspacePreparationApproval;
    workspace?: string;
    baseCommit?: string;
    purpose?: "dispatch" | "integration";
    integrationAttemptId?: string;
  }): Promise<WorkspacePreparationAttempt> {
    let ticket = this.#repository.get(input.ticketId);
    if (ticket.workspace === null || ticket.branch === null || ticket.baseCommit === null) {
      if (ticket.status !== "READY") {
        throw new WorkspacePreparationError("preparation.invalid_state", `Ticket ${ticket.id} cannot create a workspace from ${ticket.status}`);
      }
      const metadata = await this.#workspaces.create({
        projectRoot: input.projectRoot,
        ticketId: ticket.id,
        baseBranch: ticket.baseBranch,
        dirtyPolicy: input.dirtyPolicy,
      });
      ticket = this.#repository.setGitMetadata(ticket.id, metadata);
      this.#repository.recordGitObservation({
        ticketId: ticket.id,
        workspace: metadata.workspace,
        head: metadata.baseCommit,
        branch: metadata.branch,
        isClean: true,
        source: "workspace_created_for_preparation",
      });
    }
    const workspace = input.workspace ?? ticket.workspace;
    const baseCommit = input.baseCommit ?? ticket.baseCommit;
    const purpose = input.purpose ?? "dispatch";
    if (workspace === null || baseCommit === null) throw new Error("Workspace metadata invariant failed");

    let plan: WorkspacePreparationPlan;
    try {
      plan = await this.inspect(workspace);
    } catch (error) {
      if (!(error instanceof WorkspacePreparationError)) throw error;
      const diagnosticPlan = diagnosticPlanFor(error, this.config(), baseCommit);
      const latestInvalid = this.#repository.latestWorkspacePreparationAttempt(ticket.id);
      const attempt = this.#repository.createWorkspacePreparationAttempt({
        id: randomUUID(), ticketId: ticket.id, purpose, status: "FAILED", strategy: "invalid",
        fingerprint: diagnosticPlan.fingerprint, plan: diagnosticPlan, workspace, baseCommit,
        integrationAttemptId: input.integrationAttemptId ?? null,
        resumedFromAttemptId: latestInvalid?.id ?? null,
      });
      this.#repository.updateWorkspacePreparationAttempt(attempt.id, {
        diagnosticCode: error.code,
        diagnosticDetail: error.message,
        completedAt: new Date().toISOString(),
      });
      if (purpose === "dispatch" && ticket.status === "READY") {
        this.#repository.block(ticket.id, "workspace_preparation_invalid");
      }
      throw new WorkspacePreparationError(error.code, error.message, { plan: diagnosticPlan, purpose });
    }
    const latest = this.#repository.latestWorkspacePreparationAttempt(ticket.id);
    if (latest?.status === "PREPARED" && latest.fingerprint === plan.fingerprint && latest.workspace === workspace) {
      return latest;
    }
    if (!plan.applicable) {
      return this.#repository.createWorkspacePreparationAttempt({
        id: randomUUID(),
        ticketId: ticket.id,
        purpose,
        status: "NOT_APPLICABLE",
        strategy: "none",
        fingerprint: plan.fingerprint,
        plan,
        workspace,
        baseCommit,
        integrationAttemptId: input.integrationAttemptId ?? null,
        resumedFromAttemptId: latest?.id ?? null,
      });
    }

    const unavailable = plan.units.find((unit) => !unit.toolAvailable);
    if (unavailable !== undefined) {
      const attempt = this.#repository.createWorkspacePreparationAttempt({
        id: randomUUID(), ticketId: ticket.id, purpose, status: "FAILED",
        strategy: plan.units.map((unit) => unit.strategy).join("+"), fingerprint: plan.fingerprint,
        plan, workspace, baseCommit, integrationAttemptId: input.integrationAttemptId ?? null, resumedFromAttemptId: latest?.id ?? null,
      });
      this.#repository.updateWorkspacePreparationAttempt(attempt.id, {
        diagnosticCode: "preparation.tool_unavailable",
        diagnosticDetail: `${unavailable.strategy} is not executable on this host.`,
        completedAt: new Date().toISOString(),
      });
      if (purpose === "dispatch" && ticket.status === "READY") this.#repository.block(ticket.id, "workspace_preparation_tool_unavailable");
      throw new WorkspacePreparationError(
        "preparation.tool_unavailable",
        `${unavailable.strategy} is not executable on this host.`,
        { plan },
      );
    }

    const stored = this.approval();
    const supplied = input.approval;
    const accepted = supplied?.fingerprint === plan.fingerprint
      && supplied.allowNetwork === true
      && supplied.allowInstallScripts === true
      && supplied.rememberForProject === true;
    if (supplied !== undefined && !accepted) {
      throw new WorkspacePreparationError(
        "preparation.plan_changed",
        "The workspace preparation plan changed before approval was applied.",
        { plan, purpose },
      );
    }
    if (stored?.fingerprint !== plan.fingerprint && !accepted) {
      if (latest?.status !== "AWAITING_APPROVAL" || latest.fingerprint !== plan.fingerprint) {
        this.#repository.createWorkspacePreparationAttempt({
          id: randomUUID(), ticketId: ticket.id, purpose, status: "AWAITING_APPROVAL",
          strategy: plan.units.map((unit) => unit.strategy).join("+"), fingerprint: plan.fingerprint,
          plan, workspace, baseCommit, integrationAttemptId: input.integrationAttemptId ?? null, resumedFromAttemptId: latest?.id ?? null,
        });
      }
      throw new WorkspacePreparationError(
        "preparation.approval_required",
        "Approve this project's workspace preparation before running the ticket.",
        { plan, purpose },
      );
    }
    const activeApproval = accepted ? supplied : stored;
    if (accepted && supplied !== undefined) this.#repository.setProjectSetting(approvalKey, supplied);

    const attempt = this.#repository.createWorkspacePreparationAttempt({
      id: randomUUID(), ticketId: ticket.id, purpose, status: "QUEUED",
      strategy: plan.units.map((unit) => unit.strategy).join("+"), fingerprint: plan.fingerprint,
      plan, approval: activeApproval, workspace, baseCommit, integrationAttemptId: input.integrationAttemptId ?? null,
      resumedFromAttemptId: latest?.id ?? null,
    });
    const controller = new AbortController();
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => { markSettled = resolve; });
    this.#active = { ticketId: ticket.id, attemptId: attempt.id, controller, settled, markSettled };
    this.#repository.updateWorkspacePreparationAttempt(attempt.id, {
      status: "PREPARING",
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
            env: preparationEnvironment(command.env),
            maxOutputBytes: 100_000,
            onSpawn: (childPid) => this.#repository.updateWorkspacePreparationAttempt(attempt.id, {
              process: { ownerPid: process.pid, childPid, command: command.display, startedAt: new Date().toISOString() },
            }),
          });
          output.push(formatOutput(command.display, result.stdout, result.stderr));
        }
      }
      const status = await this.#runner.run("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: workspace,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      if (status.stdout.trim().length > 0) {
        throw new WorkspacePreparationError(
          "preparation.tracked_files_changed",
          "Workspace preparation modified tracked files; the workspace was preserved for inspection.",
          { files: status.stdout.trim().split(/\r?\n/u) },
        );
      }
      return this.#repository.updateWorkspacePreparationAttempt(attempt.id, {
        status: "PREPARED",
        process: null,
        output: sanitizeOutput(output.join("\n\n")),
        diagnosticCode: null,
        diagnosticDetail: null,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const detail = sanitizeOutput(errorDetail(error));
      this.#repository.updateWorkspacePreparationAttempt(attempt.id, {
        status: cancelled ? "CANCELLED" : "FAILED",
        process: null,
        output: sanitizeOutput([...output, detail].join("\n\n")),
        diagnosticCode: cancelled
          ? "preparation.cancelled"
          : error instanceof WorkspacePreparationError ? error.code : "preparation.failed",
        diagnosticDetail: detail,
        completedAt: new Date().toISOString(),
      });
      const current = this.#repository.get(ticket.id);
      if (purpose === "dispatch" && cancelled && current.status === "READY") this.#repository.transition(ticket.id, "CANCELLED", "workspace_preparation_cancelled");
      else if (purpose === "dispatch" && !cancelled && current.status === "READY") this.#repository.block(ticket.id, "workspace_preparation_failed");
      if (cancelled) throw new WorkspacePreparationError("preparation.cancelled", detail, { attemptId: attempt.id, purpose });
      if (error instanceof WorkspacePreparationError) throw error;
      throw new WorkspacePreparationError("preparation.failed", detail, { attemptId: attempt.id });
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
}

async function buildPlan(root: string, config: WorkspacePreparationConfig, runner: ProcessRunner): Promise<WorkspacePreparationPlan> {
  const configured = config.mode === "explicit" ? config.units ?? [] : undefined;
  const specs = configured === undefined ? await autoDetect(root) : configured;
  const units: WorkspacePreparationUnit[] = [];
  for (const spec of specs) units.push(await buildUnit(root, spec, runner));
  const material = {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    units: units.map((unit) => ({
      root: relative(root, unit.root).replaceAll("\\", "/"),
      strategy: unit.strategy,
      executablePath: unit.executablePath,
      toolVersion: unit.toolVersion,
      inputs: unit.inputs,
      commands: unit.commands.map((command) => ({
        executable: command.executable,
        args: command.args,
        cwd: relative(root, command.cwd).replaceAll("\\", "/"),
        env: command.env,
      })),
    })),
    allowInstallScripts: true,
  };
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    platform: process.platform,
    architecture: process.arch,
    applicable: units.length > 0,
    units,
    mayUseNetwork: units.length > 0,
    executesProjectCode: units.some((unit) => !["cargo", "go"].includes(unit.strategy)),
  };
}

async function autoDetect(root: string): Promise<WorkspacePreparationUnitConfig[]> {
  const candidates: WorkspacePreparationUnitConfig[] = [];
  if (await exists(resolve(root, "package.json"))) {
    const detected = await Promise.all(([
      ["pnpm", "pnpm-lock.yaml"], ["npm", "package-lock.json"], ["npm", "npm-shrinkwrap.json"],
      ["yarn", "yarn.lock"], ["bun", "bun.lock"], ["bun", "bun.lockb"],
    ] as const).map(async ([manager, file]) => await exists(resolve(root, file)) ? { manager, file } : null));
    const matches = detected.filter((match) => match !== null);
    if (matches.length !== 1) throw ambiguous("Node project requires exactly one supported package manager lockfile.");
    const selected = matches[0];
    if (selected === undefined) throw new Error("Node lockfile detection invariant failed");
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { packageManager?: unknown };
    const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
    if (declared !== undefined && declared !== selected.manager) {
      throw ambiguous(`packageManager declares ${declared}, but ${selected.file} selects ${selected.manager}.`);
    }
    candidates.push({ root: ".", strategy: selected.manager });
  }
  const python: BuiltinPreparationStrategy[] = [];
  if (await exists(resolve(root, "uv.lock"))) python.push("uv");
  if (await exists(resolve(root, "poetry.lock"))) python.push("poetry");
  if (await exists(resolve(root, "Pipfile.lock"))) python.push("pipenv");
  if ((await exists(resolve(root, "pyproject.toml")) || await exists(resolve(root, "Pipfile"))) && python.length === 0) {
    throw ambiguous("Python project requires uv.lock, poetry.lock, or Pipfile.lock.");
  }
  if (python.length > 1) throw ambiguous("Multiple Python dependency managers were detected.");
  if (python[0] !== undefined) candidates.push({ root: ".", strategy: python[0] });
  if (await exists(resolve(root, "Cargo.toml"))) {
    if (!await exists(resolve(root, "Cargo.lock"))) throw ambiguous("Rust project requires Cargo.lock for preparation.");
    candidates.push({ root: ".", strategy: "cargo" });
  }
  if (await exists(resolve(root, "go.mod"))) candidates.push({ root: ".", strategy: "go" });
  if (candidates.length > 1) throw ambiguous("Multiple root stacks were detected; configure ordered preparation units.");
  return candidates;
}

async function buildUnit(root: string, spec: WorkspacePreparationUnitConfig, runner: ProcessRunner): Promise<WorkspacePreparationUnit> {
  const unitRoot = resolve(root, spec.root);
  if (unitRoot !== root && !isPathInside(root, unitRoot)) throw invalid("Preparation unit root escapes the workspace.");
  const rootInfo = await stat(unitRoot).catch(() => null);
  if (rootInfo?.isDirectory() !== true) throw invalid(`Preparation unit root is not a directory: ${spec.root}`);
  const canonicalRoot = await realpath(root);
  const canonicalUnitRoot = await realpath(unitRoot);
  if (canonicalUnitRoot !== canonicalRoot && !isPathInside(canonicalRoot, canonicalUnitRoot)) {
    throw invalid(`Preparation unit root resolves outside the workspace: ${spec.root}`);
  }
  await assertStrategyInputs(unitRoot, spec.strategy);
  const commands = commandsFor(spec, unitRoot);
  const inputPaths = inputsFor(spec);
  if (spec.strategy === "bash" || spec.strategy === "pwsh") {
    const script = resolve(unitRoot, spec.script);
    if (!isPathInside(root, script)) throw invalid("Preparation script escapes the workspace.");
    const info = await lstat(script).catch(() => null);
    if (info?.isFile() !== true || info.isSymbolicLink()) throw invalid(`Preparation script is not a regular file: ${spec.script}`);
    try {
      await runner.run("git", ["ls-files", "--error-unmatch", relative(root, script)], { cwd: root, timeoutMs: 30_000 });
    } catch {
      throw invalid(`Preparation script must be tracked by Git: ${spec.script}`);
    }
  }
  const inputs = await hashInputs(unitRoot, inputPaths);
  const executable = commands[0]?.executable;
  if (executable === undefined) throw invalid(`No commands are defined for ${spec.strategy}.`);
  const executablePath = await findExecutable(executable);
  let toolVersion = "unavailable";
  let toolAvailable = executablePath !== null;
  try {
    if (executablePath === null) throw new Error(`${executable} was not found on PATH`);
    const version = await runner.run(executable, versionArgs(spec.strategy), { cwd: unitRoot, timeoutMs: 15_000 });
    toolVersion = sanitizeOutput(`${version.stdout}\n${version.stderr}`).trim().slice(0, 500) || "unknown";
  } catch {
    toolAvailable = false;
  }
  return { root: unitRoot, strategy: spec.strategy, executablePath, toolVersion, toolAvailable, inputs, commands };
}

async function assertStrategyInputs(root: string, strategy: WorkspacePreparationUnitConfig["strategy"]): Promise<void> {
  const groups: readonly (readonly string[])[] = strategy === "npm"
    ? [["package.json"], ["package-lock.json", "npm-shrinkwrap.json"]]
    : strategy === "bun"
      ? [["package.json"], ["bun.lock", "bun.lockb"]]
      : strategy === "go"
        ? [["go.mod"]]
        : strategy === "bash" || strategy === "pwsh"
          ? []
          : inputsFor({ root: ".", strategy } as WorkspacePreparationUnitConfig).map((path) => [path]);
  for (const alternatives of groups) {
    if (!(await Promise.all(alternatives.map(async (path) => await exists(resolve(root, path))))).some(Boolean)) {
      throw invalid(`${strategy} preparation is missing ${alternatives.join(" or ")}.`);
    }
  }
}

function commandsFor(spec: WorkspacePreparationUnitConfig, cwd: string): WorkspacePreparationCommand[] {
  const make = (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>): WorkspacePreparationCommand => ({
    executable, args, cwd, display: [executable, ...args].join(" "), ...(env === undefined ? {} : { env }),
  });
  switch (spec.strategy) {
    case "pnpm": return [make("pnpm", ["install", "--frozen-lockfile"])];
    case "npm": return [make("npm", ["ci"])];
    case "yarn": return [make("yarn", ["install", "--immutable"])];
    case "bun": return [make("bun", ["install", "--frozen-lockfile"])];
    case "uv": return [make("uv", ["sync", "--locked"])];
    case "poetry": return [
      make("poetry", ["check", "--lock", "--no-interaction"], { POETRY_VIRTUALENVS_IN_PROJECT: "true" }),
      make("poetry", ["sync", "--no-interaction"], { POETRY_VIRTUALENVS_IN_PROJECT: "true" }),
    ];
    case "pipenv": return [
      make("pipenv", ["verify"], { PIPENV_DONT_LOAD_ENV: "1", PIPENV_VENV_IN_PROJECT: "1" }),
      make("pipenv", ["sync", "--dev"], { PIPENV_DONT_LOAD_ENV: "1", PIPENV_VENV_IN_PROJECT: "1" }),
    ];
    case "cargo": return [make("cargo", ["fetch", "--locked"])];
    case "go": return [make("go", ["mod", "download"], { GOFLAGS: "-mod=readonly" }), make("go", ["mod", "verify"], { GOFLAGS: "-mod=readonly" })];
    case "bash": return [make("bash", ["--noprofile", "--norc", spec.script, ...(spec.args ?? [])])];
    case "pwsh": return [make("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", spec.script, ...(spec.args ?? [])])];
  }
}

function inputsFor(spec: WorkspacePreparationUnitConfig): readonly string[] {
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

function versionArgs(strategy: WorkspacePreparationUnitConfig["strategy"]): readonly string[] {
  return strategy === "go" ? ["version"] : ["--version"];
}

async function hashInputs(root: string, paths: readonly string[]): Promise<{ path: string; sha256: string }[]> {
  const results: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!await exists(absolute)) continue;
    const info = await lstat(absolute).catch(() => null);
    if (info?.isFile() !== true || info.isSymbolicLink()) throw invalid(`Preparation input is not a regular file: ${path}`);
    results.push({ path: path.replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
  }
  return results;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function validateConfig(value: unknown): WorkspacePreparationConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Preparation config must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "auto" && candidate.mode !== "explicit") throw invalid("Preparation mode must be auto or explicit.");
  if (candidate.mode === "auto") return { mode: "auto" };
  if (!Array.isArray(candidate.units) || candidate.units.length === 0) throw invalid("Explicit preparation requires at least one unit.");
  const units = candidate.units.map((unit) => {
    if (typeof unit !== "object" || unit === null || Array.isArray(unit)) throw invalid("Preparation units must be objects.");
    const row = unit as Record<string, unknown>;
    const strategies = ["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pipenv", "cargo", "go", "bash", "pwsh"];
    if (typeof row.root !== "string" || !strategies.includes(String(row.strategy))) throw invalid("Preparation unit root and strategy are required.");
    if (row.strategy === "bash" || row.strategy === "pwsh") {
      if (typeof row.script !== "string" || (row.args !== undefined && (!Array.isArray(row.args) || !row.args.every((arg) => typeof arg === "string")))) {
        throw invalid("Shell units require a script and optional string args.");
      }
      return { root: row.root, strategy: row.strategy, script: row.script, ...(row.args === undefined ? {} : { args: row.args as string[] }) } as WorkspacePreparationUnitConfig;
    }
    return { root: row.root, strategy: row.strategy as BuiltinPreparationStrategy };
  });
  return { mode: "explicit", units };
}

function isApproval(value: unknown): value is WorkspacePreparationApproval {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.fingerprint === "string" && row.allowNetwork === true
    && row.allowInstallScripts === true && row.rememberForProject === true;
}

function ambiguous(message: string): WorkspacePreparationError {
  return new WorkspacePreparationError("preparation.strategy_ambiguous", message);
}

function invalid(message: string): WorkspacePreparationError {
  return new WorkspacePreparationError("preparation.custom_step_invalid", message);
}

function errorDetail(error: unknown): string {
  if (error instanceof ProcessExecutionError) {
    return [error.message, error.result.stdout, error.result.stderr].filter(Boolean).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

function formatOutput(display: string, stdout: string, stderr: string): string {
  const body = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return `$ ${display}${body.length > 0 ? `\n${body}` : ""}`;
}

export function sanitizeOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/\b(?:npm_|pypi_|github_|ghp_|sk-)[A-Za-z0-9_-]{12,}\b/gu, "[redacted]")
    .slice(0, 100_000);
}

function diagnosticPlanFor(
  error: WorkspacePreparationError,
  config: WorkspacePreparationConfig,
  baseCommit: string,
): WorkspacePreparationPlan {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    baseCommit,
    config,
    diagnosticCode: error.code,
    diagnosticDetail: error.message,
  })).digest("hex");
  return {
    fingerprint,
    platform: process.platform,
    architecture: process.arch,
    applicable: false,
    units: [],
    mayUseNetwork: false,
    executesProjectCode: false,
  };
}

async function findExecutable(executable: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const candidates = isAbsolute(executable)
    ? [executable]
    : paths.flatMap((path) => extensions.map((extension) => resolve(path, `${executable}${extension}`)));
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile() === true) return await realpath(candidate);
  }
  return null;
}

function preparationEnvironment(overrides: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const allowed = [
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
  ];
  const environment: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}
