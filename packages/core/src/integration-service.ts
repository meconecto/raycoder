import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IntegrationMode, Ticket } from "./domain.js";
import { isPathInside } from "./git-workspace.js";
import { NodeProcessRunner, ProcessExecutionError, type ProcessRunner } from "./process.js";
import { NodeProjectVerifier, type ProjectVerifier } from "./project-verifier.js";
import type { IntegrationAttempt, TicketRepository } from "./ticket-repository.js";

export type IntegrationOutcomeKind = "integrated" | "awaiting_confirmation" | "blocked";

export interface IntegrationOutcome {
  readonly kind: IntegrationOutcomeKind;
  readonly ticket: Ticket;
  readonly attempt: IntegrationAttempt;
}

interface PrimaryCheckout {
  readonly safe: boolean;
  readonly branch: string | null;
  readonly head: string;
  readonly baseHead: string;
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
}

export class IntegrationService {
  readonly #repository: TicketRepository;
  readonly #projectRoot: string;
  readonly #mode: IntegrationMode;
  readonly #runner: ProcessRunner;
  readonly #verifier: ProjectVerifier;

  public constructor(
    repository: TicketRepository,
    projectRoot: string,
    mode: IntegrationMode,
    options: { runner?: ProcessRunner; verifier?: ProjectVerifier } = {},
  ) {
    this.#repository = repository;
    this.#projectRoot = resolve(projectRoot);
    this.#mode = mode;
    this.#runner = options.runner ?? new NodeProcessRunner();
    this.#verifier = options.verifier ?? new NodeProjectVerifier(this.#runner);
  }

  public get mode(): IntegrationMode {
    return this.#mode;
  }

  public async prepare(ticketId: string): Promise<IntegrationOutcome> {
    const ticket = this.#repository.get(ticketId);
    assertIntegrableTicket(ticket);
    const ticketHead = await this.#revParse(ticket.workspace, "HEAD");
    const attempt = this.#repository.createIntegrationAttempt({
      id: randomUUID(),
      ticketId,
      mode: this.#mode,
      originalBaseCommit: ticket.baseCommit,
      ticketHead,
    });

    const primary = await this.#inspectPrimary(ticket.baseBranch);
    if (!primary.safe) {
      return this.#block(
        attempt.id,
        primary.diagnosticCode ?? "integration_checkout_unsafe",
        primary.diagnosticDetail ?? "The primary checkout is not safe for integration.",
      );
    }

    const baseMoved = primary.baseHead !== ticket.baseCommit;
    this.#repository.updateIntegrationAttempt(attempt.id, {
      observedBaseHead: primary.baseHead,
      baseMoved,
    });

    if (!baseMoved) {
      const ancestor = await this.#isAncestor(ticket.baseCommit, ticketHead);
      if (!ancestor) {
        return this.#block(
          attempt.id,
          "ticket_not_descended_from_base",
          `Ticket commit ${ticketHead} is not descended from recorded base ${ticket.baseCommit}.`,
        );
      }
      this.#repository.updateIntegrationAttempt(attempt.id, {
        targetCommit: ticketHead,
        verificationStatus: "SKIPPED",
        verificationCommands: [],
        verificationOutput: "Base HEAD is unchanged; verification was skipped by policy.",
      });
      return this.#readyOrApply(attempt.id);
    }

    const reconciliationWorkspace = join(this.#projectRoot, ".raycoder", "integrations", attempt.id);
    await mkdir(join(this.#projectRoot, ".raycoder", "integrations"), { recursive: true });
    this.#repository.updateIntegrationAttempt(attempt.id, { reconciliationWorkspace });
    try {
      await this.#git(this.#projectRoot, ["worktree", "add", "--detach", reconciliationWorkspace, primary.baseHead]);
      await this.#git(reconciliationWorkspace, ["merge", "--no-ff", "--no-edit", ticketHead]);
    } catch (error) {
      const conflicts = await this.#unmergedFiles(reconciliationWorkspace);
      const detail = conflicts.length > 0
        ? `Reconciliation has conflicts in: ${conflicts.join(", ")}. The integration worktree was preserved.`
        : processErrorDetail(error);
      return this.#block(attempt.id, conflicts.length > 0 ? "merge_conflict" : "integration_git_error", detail);
    }

    const targetCommit = await this.#revParse(reconciliationWorkspace, "HEAD");
    const verification = await this.#verifier.verify(reconciliationWorkspace);
    this.#repository.updateIntegrationAttempt(attempt.id, {
      targetCommit,
      verificationStatus: verification.status,
      verificationCommands: verification.commands,
      verificationOutput: verification.output,
      ...(verification.diagnosticCode === null ? {} : { diagnosticCode: verification.diagnosticCode }),
      ...(verification.diagnosticDetail === null ? {} : { diagnosticDetail: verification.diagnosticDetail }),
    });
    if (verification.status !== "PASSED") {
      return this.#block(
        attempt.id,
        verification.diagnosticCode ?? (verification.status === "FAILED" ? "verification_failed" : "verification_unavailable"),
        verification.diagnosticDetail ?? `Verification finished as ${verification.status}.`,
      );
    }
    return this.#readyOrApply(attempt.id);
  }

  public async confirm(attemptId: string, ticketId?: string): Promise<IntegrationOutcome> {
    const attempt = this.#repository.getIntegrationAttempt(attemptId);
    if (ticketId !== undefined && attempt.ticketId !== ticketId) {
      throw new Error(`Integration attempt ${attemptId} does not belong to ticket ${ticketId}`);
    }
    if (attempt.mode !== "confirm" || attempt.status !== "AWAITING_CONFIRMATION") {
      throw new Error(`Integration attempt ${attemptId} is not awaiting confirmation`);
    }
    const now = new Date().toISOString();
    this.#repository.updateIntegrationAttempt(attemptId, { confirmedAt: now }, now);
    return this.#apply(attemptId);
  }

  public async retry(ticketId: string): Promise<IntegrationOutcome> {
    const ticket = this.#repository.get(ticketId);
    const latest = this.#repository.latestIntegrationAttempt(ticketId);
    if (
      ticket.status !== "BLOCKED"
      || ticket.blockedFrom !== "READY_TO_MERGE"
      || latest === null
      || latest.status !== "BLOCKED"
    ) {
      throw new Error(`Ticket ${ticketId} is not blocked by an integration attempt`);
    }
    this.#repository.resolveBlocked(ticketId, "integration_retry_requested", "READY_TO_MERGE");
    return this.prepare(ticketId);
  }

  async #readyOrApply(attemptId: string): Promise<IntegrationOutcome> {
    if (this.#mode === "confirm") {
      const attempt = this.#repository.updateIntegrationAttempt(attemptId, { status: "AWAITING_CONFIRMATION" });
      return { kind: "awaiting_confirmation", ticket: this.#repository.get(attempt.ticketId), attempt };
    }
    return this.#apply(attemptId);
  }

  async #apply(attemptId: string): Promise<IntegrationOutcome> {
    const attempt = this.#repository.getIntegrationAttempt(attemptId);
    if (attempt.status !== "PREPARING" && attempt.status !== "AWAITING_CONFIRMATION") {
      throw new Error(`Integration attempt ${attemptId} cannot be applied from ${attempt.status}`);
    }
    if (attempt.observedBaseHead === null || attempt.targetCommit === null) {
      throw new Error(`Integration attempt ${attemptId} is missing its observed base or target commit`);
    }
    const ticket = this.#repository.get(attempt.ticketId);
    const primary = await this.#inspectPrimary(ticket.baseBranch);
    if (!primary.safe) {
      return this.#block(
        attempt.id,
        primary.diagnosticCode ?? "integration_checkout_unsafe",
        primary.diagnosticDetail ?? "The primary checkout is not safe for integration.",
      );
    }
    if (primary.baseHead !== attempt.observedBaseHead || primary.head !== attempt.observedBaseHead) {
      return this.#block(
        attempt.id,
        "base_moved_during_integration",
        `Base moved from ${attempt.observedBaseHead} to ${primary.baseHead}; prepare a new integration attempt.`,
      );
    }

    this.#repository.updateIntegrationAttempt(attempt.id, { status: "APPLYING" });
    try {
      await this.#git(this.#projectRoot, ["merge", "--ff-only", attempt.targetCommit]);
    } catch (error) {
      if (await this.#isAncestor(attempt.targetCommit, ticket.baseBranch)) {
        const integrated = this.#repository.completeIntegration(attempt.id);
        const completedAttempt = this.#repository.getIntegrationAttempt(attempt.id);
        await this.#cleanupSuccessfulReconciliation(completedAttempt);
        return { kind: "integrated", ticket: integrated, attempt: completedAttempt };
      }
      return this.#block(attempt.id, "integration_apply_failed", processErrorDetail(error));
    }
    const integrated = this.#repository.completeIntegration(attempt.id);
    const completedAttempt = this.#repository.getIntegrationAttempt(attempt.id);
    await this.#cleanupSuccessfulReconciliation(completedAttempt);
    return { kind: "integrated", ticket: integrated, attempt: completedAttempt };
  }

  #block(attemptId: string, code: string, detail: string): IntegrationOutcome {
    const ticket = this.#repository.blockIntegration(attemptId, code, detail);
    return { kind: "blocked", ticket, attempt: this.#repository.getIntegrationAttempt(attemptId) };
  }

  async #inspectPrimary(baseBranch: string): Promise<PrimaryCheckout> {
    const status = await this.#git(this.#projectRoot, ["status", "--porcelain"]);
    const head = await this.#revParse(this.#projectRoot, "HEAD");
    const baseHead = await this.#revParse(this.#projectRoot, baseBranch);
    let branch: string | null = null;
    try {
      branch = (await this.#git(this.#projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    } catch (error) {
      if (!(error instanceof ProcessExecutionError)) throw error;
    }
    if (branch !== baseBranch) {
      return {
        safe: false,
        branch,
        head,
        baseHead,
        diagnosticCode: "base_branch_not_checked_out",
        diagnosticDetail: branch === null
          ? `The primary checkout is detached; check out ${baseBranch} before retrying.`
          : `The primary checkout is on ${branch}, not ${baseBranch}.`,
      };
    }
    if (status.stdout.trim().length > 0) {
      return {
        safe: false,
        branch,
        head,
        baseHead,
        diagnosticCode: "base_checkout_dirty",
        diagnosticDetail: "The primary checkout has uncommitted changes; commit or remove them before retrying.",
      };
    }
    return { safe: true, branch, head, baseHead, diagnosticCode: null, diagnosticDetail: null };
  }

  async #cleanupSuccessfulReconciliation(attempt: IntegrationAttempt): Promise<void> {
    const workspace = attempt.reconciliationWorkspace;
    const integrationRoot = join(this.#projectRoot, ".raycoder", "integrations");
    if (workspace === null || !isPathInside(integrationRoot, workspace)) return;
    try {
      await this.#git(this.#projectRoot, ["worktree", "remove", "--force", workspace]);
    } catch {
      // Integration is already durable. A stale successful worktree is safe to prune manually later.
    }
  }

  async #unmergedFiles(workspace: string): Promise<string[]> {
    try {
      const result = await this.#git(workspace, ["diff", "--name-only", "--diff-filter=U"]);
      return result.stdout.split(/\r?\n/u).map((name) => name.trim()).filter((name) => name.length > 0);
    } catch {
      return [];
    }
  }

  async #isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.#git(this.#projectRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.result.exitCode === 1) return false;
      throw error;
    }
  }

  async #revParse(cwd: string, ref: string): Promise<string> {
    return (await this.#git(cwd, ["rev-parse", ref])).stdout.trim();
  }

  async #git(cwd: string, args: readonly string[]) {
    return this.#runner.run("git", args, { cwd, timeoutMs: 60_000 });
  }
}

export interface IntegrationRecoveryEvidence {
  isTargetIntegrated(ticket: Ticket, attempt: IntegrationAttempt): Promise<boolean>;
}

export class GitIntegrationRecoveryEvidence implements IntegrationRecoveryEvidence {
  readonly #projectRoot: string;
  readonly #runner: ProcessRunner;

  public constructor(projectRoot: string, runner: ProcessRunner = new NodeProcessRunner()) {
    this.#projectRoot = resolve(projectRoot);
    this.#runner = runner;
  }

  public async isTargetIntegrated(ticket: Ticket, attempt: IntegrationAttempt): Promise<boolean> {
    if (attempt.targetCommit === null) return false;
    try {
      await this.#runner.run(
        "git",
        ["merge-base", "--is-ancestor", attempt.targetCommit, ticket.baseBranch],
        { cwd: this.#projectRoot, timeoutMs: 30_000 },
      );
      return true;
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.result.exitCode === 1) return false;
      throw error;
    }
  }
}

function assertIntegrableTicket(
  ticket: Ticket,
): asserts ticket is Ticket & { branch: string; baseCommit: string; workspace: string } {
  if (ticket.status !== "READY_TO_MERGE") throw new Error(`Ticket ${ticket.id} is ${ticket.status}, not READY_TO_MERGE`);
  if (ticket.branch === null || ticket.baseCommit === null || ticket.workspace === null) {
    throw new Error(`Ticket ${ticket.id} has incomplete Git metadata`);
  }
}

function processErrorDetail(error: unknown): string {
  if (error instanceof ProcessExecutionError) {
    const detail = [error.result.stderr.trim(), error.result.stdout.trim()].filter((part) => part.length > 0).join("\n");
    return detail.length > 0 ? detail : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
