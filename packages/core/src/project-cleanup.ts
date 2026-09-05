import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Ticket, TicketStatus } from "./domain.js";
import { isPathInside } from "./git-workspace.js";
import { NodeProcessRunner, ProcessExecutionError, type ProcessRunner } from "./process.js";
import type { ProjectManager } from "./project-manager.js";
import type { ProjectRuntime } from "./project-runtime.js";
import type { WorkspacePreparationAttempt, WorkspacePreparationStatus } from "./ticket-repository.js";

export type CleanupTargetKind =
  | "registration"
  | "database"
  | "skills"
  | "ticket_worktree"
  | "integration_worktree"
  | "branch"
  | "metadata";

export interface CleanupTarget {
  readonly id: string;
  readonly kind: CleanupTargetKind;
  readonly label: string;
  readonly path: string | null;
  readonly branch: string | null;
  readonly ticketId: string | null;
  readonly ticketStatus: TicketStatus | null;
  readonly dirty: boolean | null;
  readonly integrated: boolean | null;
  readonly destructive: boolean;
  readonly selectedByDefault: boolean;
  readonly requiresForce: boolean;
}

export interface CleanupWarning {
  readonly code: string;
  readonly message: string;
  readonly targetId?: string;
}

export interface CleanupPlan {
  readonly id: string;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly targets: readonly CleanupTarget[];
  readonly warnings: readonly CleanupWarning[];
  readonly confirmationPhrase: string;
}

export interface CleanupExecutionResult {
  readonly complete: boolean;
  readonly removedTargetIds: readonly string[];
  readonly failedStep: string | null;
  readonly error: string | null;
  readonly inventory: CleanupPlan | null;
}

interface Inventory {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly targets: readonly CleanupTarget[];
  readonly warnings: readonly CleanupWarning[];
}

const planLifetimeMilliseconds = 10 * 60 * 1_000;
const riskyTicketStatuses = new Set<TicketStatus>(["FAILED", "INTERRUPTED"]);
const riskyPreparationStatuses = new Set<WorkspacePreparationStatus>([
  "AWAITING_APPROVAL",
  "QUEUED",
  "PREPARING",
  "FAILED",
  "INTERRUPTED",
]);

export class ProjectCleanupService {
  readonly #projects: ProjectManager;
  readonly #runner: ProcessRunner;
  readonly #plans = new Map<string, CleanupPlan>();

  public constructor(projects: ProjectManager, runner: ProcessRunner = new NodeProcessRunner()) {
    this.#projects = projects;
    this.#runner = runner;
  }

  public async plan(projectId: string): Promise<CleanupPlan> {
    const runtime = await this.#projects.open(projectId);
    const inventory = await this.#inventory(projectId, runtime);
    const createdAt = new Date();
    const plan: CleanupPlan = {
      id: randomUUID(),
      projectId,
      fingerprint: fingerprint(inventory),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + planLifetimeMilliseconds).toISOString(),
      targets: inventory.targets,
      warnings: inventory.warnings,
      confirmationPhrase: `DELETE ${inventory.projectName}`,
    };
    this.#plans.set(plan.id, plan);
    return plan;
  }

  public async execute(input: {
    projectId: string;
    planId: string;
    fingerprint: string;
    confirmationPhrase: string;
    selectedTargetIds?: readonly string[];
    force?: boolean;
  }): Promise<CleanupExecutionResult> {
    const plan = this.#plans.get(input.planId);
    if (plan === undefined || plan.projectId !== input.projectId) throw new Error("Cleanup plan was not found");
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error("Cleanup plan expired; generate a new plan");
    if (input.fingerprint !== plan.fingerprint) throw new Error("Cleanup fingerprint did not match the previewed plan");
    if (input.confirmationPhrase !== plan.confirmationPhrase) throw new Error(`Type ${plan.confirmationPhrase} exactly to continue`);

    const runtime = this.#projects.get(input.projectId);
    if (runtime.scheduler.pendingCount !== 0 || runtime.scheduler.activeTicketId !== null) {
      throw new Error("Cleanup requires an idle scheduler with no pending operations");
    }
    if ((await runtime.preview.status()).running) throw new Error("Stop the project preview before cleanup");
    const current = await this.#inventory(input.projectId, runtime);
    if (fingerprint(current) !== plan.fingerprint) throw new Error("Project cleanup inventory changed; generate a new plan");

    const selected = new Set(input.selectedTargetIds ?? plan.targets.filter((target) => target.selectedByDefault).map((target) => target.id));
    for (const id of selected) {
      if (!plan.targets.some((target) => target.id === id)) throw new Error(`Unknown cleanup target: ${id}`);
    }
    const risky = plan.targets.filter((target) => selected.has(target.id) && target.requiresForce);
    if (risky.length > 0 && input.force !== true) {
      throw new Error(`Cleanup targets require force=true: ${risky.map((target) => target.label).join(", ")}`);
    }

    const roots = cleanupRoots(runtime.projectRoot);
    for (const target of plan.targets.filter((candidate) => selected.has(candidate.id) && candidate.path !== null)) {
      assertCleanupPath(runtime.projectRoot, roots, target);
    }

    const removed: string[] = [];
    let failedStep = "close runtime";
    const registrationSelected = selected.has("registration");
    const metadataSelected = selected.has("metadata");
    try {
      runtime.preview.stop();
      this.#projects.closeProject(input.projectId);

      failedStep = "remove worktrees";
      for (const target of orderedTargets(plan.targets, selected, ["ticket_worktree", "integration_worktree"])) {
        if (target.path === null) continue;
        const args = ["worktree", "remove", ...(target.requiresForce ? ["--force"] : []), target.path];
        await this.#git(runtime.projectRoot, args);
        removed.push(target.id);
      }

      failedStep = "remove branches";
      for (const target of orderedTargets(plan.targets, selected, ["branch"])) {
        if (target.branch === null) continue;
        await this.#git(runtime.projectRoot, ["branch", target.requiresForce ? "-D" : "-d", target.branch]);
        removed.push(target.id);
      }

      failedStep = "remove project database";
      if (selected.has("database")) {
        await removeDatabase(join(roots.metadata, "raycoder.db"));
        removed.push("database");
      }
      failedStep = "remove project skills";
      if (selected.has("skills")) {
        await rm(roots.skills, { recursive: true, force: true });
        removed.push("skills");
      }

      failedStep = "remove project metadata";
      if (metadataSelected) {
        const registered = await this.#worktrees(runtime.projectRoot);
        const remaining = registered.filter((worktree) => isPathInside(roots.workspaces, worktree.path) || isPathInside(roots.integrations, worktree.path));
        if (remaining.length > 0) throw new Error(`Cannot remove metadata while Git still registers ${remaining.length} raycoder worktree(s)`);
        await rm(roots.metadata, { recursive: true, force: true });
        removed.push("metadata");
        await this.#removeExcludeLine(runtime.projectRoot);
      }

      failedStep = "remove global registration";
      if (registrationSelected) {
        this.#projects.remove(input.projectId);
        removed.push("registration");
      } else if (!metadataSelected) {
        await this.#projects.open(input.projectId);
      }
      this.#plans.delete(plan.id);
      return { complete: true, removedTargetIds: removed, failedStep: null, error: null, inventory: null };
    } catch (error) {
      let refreshed: CleanupPlan | null = null;
      if (!removed.includes("registration") && !removed.includes("metadata")) {
        try {
          await this.#projects.open(input.projectId);
          refreshed = await this.plan(input.projectId);
        } catch {
          refreshed = null;
        }
      }
      return {
        complete: false,
        removedTargetIds: removed,
        failedStep,
        error: error instanceof Error ? error.message : String(error),
        inventory: refreshed,
      };
    }
  }

  async #inventory(projectId: string, runtime: ProjectRuntime): Promise<Inventory> {
    const registered = this.#projects.list().find((entry) => entry.project.id === projectId)?.project;
    if (registered === undefined) throw new Error(`Unknown project: ${projectId}`);
    const roots = cleanupRoots(runtime.projectRoot);
    const tickets = runtime.repository.list();
    const byWorkspace = new Map(tickets.filter(hasWorkspace).map((ticket) => [resolve(ticket.workspace), ticket]));
    const integrationAttempts = runtime.repository.listIntegrationAttempts();
    const latestPreparationByWorkspace = new Map<string, WorkspacePreparationAttempt>();
    for (const preparation of runtime.repository.listWorkspacePreparationAttempts()) {
      latestPreparationByWorkspace.set(resolve(preparation.workspace), preparation);
    }
    const byIntegrationWorkspace = new Map(integrationAttempts
      .filter((attempt) => attempt.reconciliationWorkspace !== null)
      .map((attempt) => [resolve(attempt.reconciliationWorkspace as string), attempt]));
    const warnings: CleanupWarning[] = [];
    const targets: CleanupTarget[] = [];

    const worktrees = await this.#worktrees(runtime.projectRoot);
    for (const worktree of worktrees) {
      if (resolve(worktree.path) === resolve(runtime.projectRoot)) continue;
      const ticket = byWorkspace.get(resolve(worktree.path));
      const attempt = byIntegrationWorkspace.get(resolve(worktree.path));
      const kind = isPathInside(roots.workspaces, worktree.path)
        ? "ticket_worktree"
        : isPathInside(roots.integrations, worktree.path) ? "integration_worktree" : null;
      if (kind === null) {
        warnings.push({ code: "worktree.outside_roots", message: `Registered worktree is outside raycoder roots and will never be deleted: ${worktree.path}` });
        continue;
      }
      const dirty = await this.#dirty(worktree.path);
      const riskyStatus = ticket !== undefined && riskyTicketStatuses.has(ticket.status);
      const preparation = latestPreparationByWorkspace.get(resolve(worktree.path));
      const riskyPreparation = preparation !== undefined && riskyPreparationStatuses.has(preparation.status);
      const requiresForce = dirty || riskyStatus || riskyPreparation;
      const id = `worktree:${resolve(worktree.path)}`;
      targets.push({
        id,
        kind,
        label: `${kind === "ticket_worktree" ? "Ticket" : "Integration"} worktree ${worktree.path}`,
        path: resolve(worktree.path),
        branch: worktree.branch,
        ticketId: ticket?.id ?? attempt?.ticketId ?? null,
        ticketStatus: ticket?.status ?? null,
        dirty,
        integrated: null,
        destructive: true,
        selectedByDefault: !requiresForce,
        requiresForce,
      });
      if (dirty) warnings.push({ code: "worktree.dirty", message: `Dirty worktree requires force: ${worktree.path}`, targetId: id });
      if (riskyStatus) warnings.push({ code: "ticket.preserved", message: `Ticket ${ticket.id} is ${ticket.status} and is preserved by default`, targetId: id });
      if (riskyPreparation) warnings.push({
        code: "preparation.preserved",
        message: `Workspace preparation ${preparation.id} is ${preparation.status} and is preserved by default`,
        targetId: id,
      });
    }

    const ticketByBranch = new Map(tickets.filter(hasBranch).map((ticket) => [ticket.branch, ticket]));
    for (const branch of await this.#raycoderBranches(runtime.projectRoot)) {
      const ticket = ticketByBranch.get(branch);
      const integrated = await this.#integrated(runtime.projectRoot, branch, runtime.baseBranch);
      const riskyStatus = ticket !== undefined && riskyTicketStatuses.has(ticket.status);
      const requiresForce = !integrated || riskyStatus;
      const id = `branch:${branch}`;
      targets.push({
        id,
        kind: "branch",
        label: `Branch ${branch}`,
        path: null,
        branch,
        ticketId: ticket?.id ?? null,
        ticketStatus: ticket?.status ?? null,
        dirty: null,
        integrated,
        destructive: true,
        selectedByDefault: !requiresForce,
        requiresForce,
      });
      if (!integrated) warnings.push({ code: "branch.unintegrated", message: `Unintegrated branch requires force: ${branch}`, targetId: id });
      if (riskyStatus) warnings.push({ code: "ticket.preserved", message: `Ticket ${ticket.id} is ${ticket.status} and its branch is preserved by default`, targetId: id });
    }

    const destructiveSafe = targets.every((target) => target.selectedByDefault);
    targets.push(
      metadataTarget("database", "Project SQLite database", join(roots.metadata, "raycoder.db"), destructiveSafe),
      metadataTarget("skills", "Project skill bundle", roots.skills, destructiveSafe),
      metadataTarget("metadata", "Complete .raycoder metadata directory", roots.metadata, destructiveSafe),
      {
        id: "registration",
        kind: "registration",
        label: "Global project registration",
        path: null,
        branch: null,
        ticketId: null,
        ticketStatus: null,
        dirty: null,
        integrated: null,
        destructive: false,
        selectedByDefault: destructiveSafe,
        requiresForce: false,
      },
    );
    if (!destructiveSafe) warnings.push({
      code: "metadata.preserved",
      message: "Database, skills, metadata and registration are deselected while risky work remains.",
    });
    return { projectId, projectName: registered.name, projectRoot: runtime.projectRoot, targets, warnings };
  }

  async #worktrees(projectRoot: string): Promise<{ path: string; branch: string | null }[]> {
    const output = (await this.#git(projectRoot, ["worktree", "list", "--porcelain"])).stdout;
    return output.trim().split(/\r?\n\r?\n/u).filter(Boolean).map((block) => {
      const lines = block.split(/\r?\n/u);
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (path === undefined) throw new Error(`Invalid git worktree record: ${block}`);
      const reference = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
      return { path: resolve(path), branch: reference?.replace(/^refs\/heads\//u, "") ?? null };
    });
  }

  async #raycoderBranches(projectRoot: string): Promise<string[]> {
    const output = (await this.#git(projectRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/raycoder/"])).stdout;
    return output.split(/\r?\n/u).map((branch) => branch.trim()).filter(Boolean).sort();
  }

  async #dirty(worktree: string): Promise<boolean> {
    return (await this.#git(worktree, ["status", "--porcelain"])).stdout.trim().length > 0;
  }

  async #integrated(projectRoot: string, branch: string, baseBranch: string): Promise<boolean> {
    try {
      await this.#git(projectRoot, ["merge-base", "--is-ancestor", branch, baseBranch]);
      return true;
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.result.exitCode === 1) return false;
      throw error;
    }
  }

  async #removeExcludeLine(projectRoot: string): Promise<void> {
    const result = await this.#git(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
    const excludePath = isAbsolute(result.stdout.trim()) ? result.stdout.trim() : resolve(projectRoot, result.stdout.trim());
    let contents: string;
    try {
      contents = await readFile(excludePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const hadTrailingNewline = /\r?\n$/u.test(contents);
    const filtered = contents.split(/\r?\n/u).filter((line) => line !== "/.raycoder/");
    while (filtered.at(-1) === "") filtered.pop();
    await writeFile(excludePath, `${filtered.join("\n")}${hadTrailingNewline && filtered.length > 0 ? "\n" : ""}`, "utf8");
  }

  async #git(cwd: string, args: readonly string[]) {
    return await this.#runner.run("git", args, { cwd, timeoutMs: 30_000 });
  }
}

function cleanupRoots(projectRoot: string): { metadata: string; workspaces: string; integrations: string; skills: string } {
  const metadata = resolve(projectRoot, ".raycoder");
  return {
    metadata,
    workspaces: join(metadata, "workspaces"),
    integrations: join(metadata, "integrations"),
    skills: join(metadata, "skills"),
  };
}

function assertCleanupPath(projectRoot: string, roots: ReturnType<typeof cleanupRoots>, target: CleanupTarget): void {
  const path = resolve(target.path as string);
  if (path === resolve(projectRoot)) throw new Error("Cleanup will never remove the main checkout");
  if (target.kind === "ticket_worktree" && !isPathInside(roots.workspaces, path)) throw new Error(`Ticket worktree escaped its validated root: ${path}`);
  if (target.kind === "integration_worktree" && !isPathInside(roots.integrations, path)) throw new Error(`Integration worktree escaped its validated root: ${path}`);
  if (["database", "skills", "metadata"].includes(target.kind) && path !== roots.metadata && !isPathInside(roots.metadata, path)) {
    throw new Error(`Metadata target escaped .raycoder: ${path}`);
  }
}

function metadataTarget(id: "database" | "skills" | "metadata", label: string, path: string, safe: boolean): CleanupTarget {
  return {
    id,
    kind: id,
    label,
    path,
    branch: null,
    ticketId: null,
    ticketStatus: null,
    dirty: null,
    integrated: null,
    destructive: true,
    selectedByDefault: safe,
    requiresForce: !safe,
  };
}

function orderedTargets(targets: readonly CleanupTarget[], selected: ReadonlySet<string>, kinds: readonly CleanupTargetKind[]): CleanupTarget[] {
  return targets.filter((target) => selected.has(target.id) && kinds.includes(target.kind));
}

function fingerprint(inventory: Inventory): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: inventory.projectId,
    projectRoot: inventory.projectRoot,
    targets: inventory.targets,
    warnings: inventory.warnings,
  })).digest("hex");
}

function hasWorkspace(ticket: Ticket): ticket is Ticket & { workspace: string } {
  return ticket.workspace !== null;
}

function hasBranch(ticket: Ticket): ticket is Ticket & { branch: string } {
  return ticket.branch !== null;
}

async function removeDatabase(databasePath: string): Promise<void> {
  for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) await rm(path, { force: true });
}
