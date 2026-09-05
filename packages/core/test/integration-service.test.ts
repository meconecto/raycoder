import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTicket } from "../src/domain.js";
import { GitWorkspaceManager } from "../src/git-workspace.js";
import { GitIntegrationRecoveryEvidence, IntegrationService } from "../src/integration-service.js";
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from "../src/process.js";
import type { ProjectVerifier, VerificationResult } from "../src/project-verifier.js";
import { RecoveryService } from "../src/recovery.js";
import { TicketRepository } from "../src/ticket-repository.js";
import { WorkspacePreparationService, type WorkspacePreparationError } from "../src/workspace-preparation.js";
import { WorkspaceVerificationService, type WorkspaceVerificationError } from "../src/workspace-verification.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("IntegrationService", () => {
  it("fast-forwards an unchanged base to DONE without invoking verification", async () => {
    const fixture = await createFixture();
    const verifier = new StaticVerifier(passedVerification());
    const integration = new IntegrationService(fixture.repository, fixture.projectRoot, "auto", { verifier });

    const outcome = await integration.prepare(fixture.ticketId);

    expect(outcome.kind).toBe("integrated");
    expect(outcome.ticket.status).toBe("DONE");
    expect(outcome.attempt.verificationStatus).toBe("SKIPPED");
    expect(verifier.calls).toBe(0);
    expect(await head(fixture.projectRoot)).toBe(await head(fixture.workspace));
    expect(existsSync(fixture.workspace)).toBe(true);
    fixture.repository.close();
  });

  it("reconciles an advanced base, verifies the result, and fast-forwards the base", async () => {
    const fixture = await createFixture();
    await commitBaseChange(fixture.projectRoot, "base.txt", "advanced\n");
    const verifier = new StaticVerifier(passedVerification());
    const integration = new IntegrationService(fixture.repository, fixture.projectRoot, "auto", { verifier });

    const outcome = await integration.prepare(fixture.ticketId);

    expect(outcome.kind).toBe("integrated");
    expect(outcome.attempt.baseMoved).toBe(true);
    expect(outcome.attempt.verificationStatus).toBe("PASSED");
    expect(verifier.calls).toBe(1);
    expect(await head(fixture.projectRoot)).toBe(outcome.attempt.targetCommit);
    expect((await git(fixture.projectRoot, ["show", "-s", "--format=%P", "HEAD"])).stdout.trim().split(" ")).toHaveLength(2);
    fixture.repository.close();
  });

  it("preserves both workspaces and blocks without moving the base on conflict", async () => {
    const fixture = await createFixture({ ticketFile: "README.md", ticketContents: "ticket\n" });
    await commitBaseChange(fixture.projectRoot, "README.md", "base advanced\n");
    const baseBefore = await head(fixture.projectRoot);
    const integration = new IntegrationService(
      fixture.repository,
      fixture.projectRoot,
      "auto",
      { verifier: new StaticVerifier(passedVerification()) },
    );

    const outcome = await integration.prepare(fixture.ticketId);

    expect(outcome.kind).toBe("blocked");
    expect(outcome.ticket).toMatchObject({ status: "BLOCKED", blockedFrom: "READY_TO_MERGE" });
    expect(outcome.attempt.diagnosticCode).toBe("merge_conflict");
    expect(await head(fixture.projectRoot)).toBe(baseBefore);
    expect(existsSync(fixture.workspace)).toBe(true);
    expect(existsSync(outcome.attempt.reconciliationWorkspace ?? "missing")).toBe(true);
    fixture.repository.close();
  });

  it.each([
    ["FAILED", "verification_failed"],
    ["UNAVAILABLE", "verification_unavailable"],
  ] as const)("blocks an advanced base when verification is %s", async (status, code) => {
    const fixture = await createFixture();
    await commitBaseChange(fixture.projectRoot, "base.txt", "advanced\n");
    const baseBefore = await head(fixture.projectRoot);
    const verifier = new StaticVerifier({
      status,
      commands: ["pnpm test"],
      output: "verification result",
      diagnosticCode: code,
      diagnosticDetail: `Verification is ${status}`,
    });

    const outcome = await new IntegrationService(fixture.repository, fixture.projectRoot, "auto", { verifier })
      .prepare(fixture.ticketId);

    expect(outcome.kind).toBe("blocked");
    expect(outcome.attempt).toMatchObject({ verificationStatus: status, diagnosticCode: code });
    expect(await head(fixture.projectRoot)).toBe(baseBefore);
    fixture.repository.close();
  });

  it("waits for confirmation and rejects a stale approval after the base moves", async () => {
    const fixture = await createFixture();
    const integration = new IntegrationService(
      fixture.repository,
      fixture.projectRoot,
      "confirm",
      { verifier: new StaticVerifier(passedVerification()) },
    );
    const baseBefore = await head(fixture.projectRoot);

    const prepared = await integration.prepare(fixture.ticketId);
    expect(prepared.kind).toBe("awaiting_confirmation");
    expect(await head(fixture.projectRoot)).toBe(baseBefore);

    await commitBaseChange(fixture.projectRoot, "later.txt", "later\n");
    const movedHead = await head(fixture.projectRoot);
    const confirmed = await integration.confirm(prepared.attempt.id);

    expect(confirmed.kind).toBe("blocked");
    expect(confirmed.attempt.diagnosticCode).toBe("base_moved_during_integration");
    expect(await head(fixture.projectRoot)).toBe(movedHead);
    fixture.repository.close();
  });

  it("integrates only the prepared target after an explicit confirmation", async () => {
    const fixture = await createFixture();
    const integration = new IntegrationService(
      fixture.repository,
      fixture.projectRoot,
      "confirm",
      { verifier: new StaticVerifier(passedVerification()) },
    );

    const prepared = await integration.prepare(fixture.ticketId);
    const confirmed = await integration.confirm(prepared.attempt.id, fixture.ticketId);

    expect(prepared.kind).toBe("awaiting_confirmation");
    expect(confirmed.kind).toBe("integrated");
    expect(await head(fixture.projectRoot)).toBe(prepared.attempt.targetCommit);
    fixture.repository.close();
  });

  it("blocks integration while the primary checkout is on another branch", async () => {
    const fixture = await createFixture();
    await git(fixture.projectRoot, ["switch", "-c", "other"]);

    const outcome = await new IntegrationService(
      fixture.repository,
      fixture.projectRoot,
      "auto",
      { verifier: new StaticVerifier(passedVerification()) },
    ).prepare(fixture.ticketId);

    expect(outcome.kind).toBe("blocked");
    expect(outcome.attempt.diagnosticCode).toBe("base_branch_not_checked_out");
    fixture.repository.close();
  });

  it("recovers DONE from real Git ancestry after a crash-window merge", async () => {
    const fixture = await createFixture();
    const ticketHead = await head(fixture.workspace);
    fixture.repository.createIntegrationAttempt({
      id: "crash-window",
      ticketId: fixture.ticketId,
      mode: "auto",
      originalBaseCommit: (fixture.repository.get(fixture.ticketId).baseCommit) ?? "missing",
      ticketHead,
    });
    fixture.repository.updateIntegrationAttempt("crash-window", {
      status: "APPLYING",
      observedBaseHead: await head(fixture.projectRoot),
      targetCommit: ticketHead,
      verificationStatus: "SKIPPED",
    });
    await git(fixture.projectRoot, ["merge", "--ff-only", ticketHead]);

    await new RecoveryService(
      fixture.repository,
      undefined,
      new GitIntegrationRecoveryEvidence(fixture.projectRoot, runner),
    ).recoverUncontrolledShutdown();

    expect(fixture.repository.get(fixture.ticketId).status).toBe("DONE");
    expect(fixture.repository.getIntegrationAttempt("crash-window").status).toBe("INTEGRATED");
    fixture.repository.close();
  });

  it("blocks a dirty primary checkout and succeeds through an explicit retry after cleanup", async () => {
    const fixture = await createFixture();
    writeFileSync(join(fixture.projectRoot, "dirty.txt"), "dirty\n", "utf8");
    const integration = new IntegrationService(
      fixture.repository,
      fixture.projectRoot,
      "auto",
      { verifier: new StaticVerifier(passedVerification()) },
    );

    const blocked = await integration.prepare(fixture.ticketId);
    expect(blocked.attempt.diagnosticCode).toBe("base_checkout_dirty");
    rmSync(join(fixture.projectRoot, "dirty.txt"));

    const retried = await integration.retry(fixture.ticketId);
    expect(retried.kind).toBe("integrated");
    expect(retried.ticket.status).toBe("DONE");
    fixture.repository.close();
  });

  it("applies the same preparation approval policy to a moved-base reconciliation worktree", async () => {
    const fixture = await createFixture({ nodeStack: true });
    await commitBaseChange(fixture.projectRoot, "base.txt", "advanced\n");
    const verifier = new StaticVerifier(passedVerification());
    const preparationRunner = new IntegrationPreparationRunner();
    const preparation = new WorkspacePreparationService(
      fixture.repository,
      new GitWorkspaceManager(preparationRunner),
      preparationRunner,
    );
    const integration = new IntegrationService(fixture.repository, fixture.projectRoot, "auto", {
      runner: preparationRunner,
      verifier,
      preparation,
    });

    let fingerprint = "";
    await integration.prepare(fixture.ticketId).catch((error: WorkspacePreparationError) => {
      expect(error.code).toBe("preparation.approval_required");
      fingerprint = (error.details as { plan: { fingerprint: string } }).plan.fingerprint;
    });
    expect(verifier.calls).toBe(0);
    expect(fixture.repository.get(fixture.ticketId)).toMatchObject({ status: "BLOCKED", blockedFrom: "READY_TO_MERGE" });
    expect(fixture.repository.latestWorkspacePreparationAttempt(fixture.ticketId)).toMatchObject({
      purpose: "integration",
      status: "AWAITING_APPROVAL",
    });

    const outcome = await integration.retry(fixture.ticketId, {
      fingerprint,
      allowNetwork: true,
      allowInstallScripts: true,
      rememberForProject: true,
    });

    expect(outcome.kind).toBe("integrated");
    expect(preparationRunner.dependencies).toEqual(["pnpm install --frozen-lockfile"]);
    expect(verifier.calls).toBe(1);
    fixture.repository.close();
  }, 20_000);

  it("applies durable verification approval to a moved-base reconciliation worktree", async () => {
    const fixture = await createFixture({ nodeStack: true });
    await commitBaseChange(fixture.projectRoot, "base.txt", "advanced\n");
    const workspaceRunner = new IntegrationPreparationRunner();
    const preparation = new WorkspacePreparationService(
      fixture.repository,
      new GitWorkspaceManager(workspaceRunner),
      workspaceRunner,
    );
    const verification = new WorkspaceVerificationService(fixture.repository, workspaceRunner);
    const integration = new IntegrationService(fixture.repository, fixture.projectRoot, "auto", {
      runner: workspaceRunner,
      preparation,
      verification,
    });

    let preparationFingerprint = "";
    await integration.prepare(fixture.ticketId).catch((error: WorkspacePreparationError) => {
      expect(error.code).toBe("preparation.approval_required");
      preparationFingerprint = (error.details as { plan: { fingerprint: string } }).plan.fingerprint;
    });
    let verificationFingerprint = "";
    await integration.retry(fixture.ticketId, {
      fingerprint: preparationFingerprint,
      allowNetwork: true,
      allowInstallScripts: true,
      rememberForProject: true,
    }).catch((error: WorkspaceVerificationError) => {
      expect(error.code).toBe("verification.approval_required");
      verificationFingerprint = (error.details as { plan: { fingerprint: string } }).plan.fingerprint;
    });

    const outcome = await integration.retry(fixture.ticketId, undefined, {
      fingerprint: verificationFingerprint,
      allowVerification: true,
      rememberForProject: true,
    });

    expect(outcome.kind).toBe("integrated");
    expect(outcome.attempt.verificationStatus).toBe("PASSED");
    expect(fixture.repository.latestWorkspaceVerificationAttempt(fixture.ticketId, "integration")).toMatchObject({
      status: "PASSED",
      integrationAttemptId: outcome.attempt.id,
    });
    expect(workspaceRunner.dependencies).toContain("pnpm run verify");
    fixture.repository.close();
  }, 20_000);
});

class StaticVerifier implements ProjectVerifier {
  public calls = 0;

  public constructor(readonly result: VerificationResult) {}

  public async verify(): Promise<VerificationResult> {
    this.calls += 1;
    return this.result;
  }
}

async function createFixture(
  options: { ticketFile?: string; ticketContents?: string; nodeStack?: boolean } = {},
): Promise<{ projectRoot: string; repository: TicketRepository; ticketId: string; workspace: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), "raycoder-integration-"));
  temporaryDirectories.push(projectRoot);
  await git(projectRoot, ["init", "-b", "main"]);
  await git(projectRoot, ["config", "user.name", "raycoder tests"]);
  await git(projectRoot, ["config", "user.email", "tests@raycoder.local"]);
  writeFileSync(join(projectRoot, "README.md"), "base\n", "utf8");
  if (options.nodeStack === true) {
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
      private: true,
      packageManager: "pnpm@11.19.0",
      scripts: { verify: "fixture" },
    }), "utf8");
    writeFileSync(join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "test: base"]);

  const repository = new TicketRepository(":memory:");
  const ticketId = "ticket-1";
  repository.create(createTicket({
    id: ticketId,
    title: "Integration fixture",
    description: "test",
    baseBranch: "main",
    hasPredecessors: false,
  }));
  const metadata = await new GitWorkspaceManager(runner).create({
    projectRoot,
    ticketId,
    baseBranch: "main",
    dirtyPolicy: "cancel",
  });
  repository.setGitMetadata(ticketId, metadata);
  repository.transition(ticketId, "RUNNING", "test");
  const ticketFile = options.ticketFile ?? "feature.txt";
  writeFileSync(join(metadata.workspace, ticketFile), options.ticketContents ?? "feature\n", "utf8");
  await git(metadata.workspace, ["add", ticketFile]);
  await git(metadata.workspace, ["commit", "-m", "feat: ticket"]);
  repository.transition(ticketId, "REVIEW", "test");
  repository.transition(ticketId, "READY_TO_MERGE", "test");
  return { projectRoot, repository, ticketId, workspace: metadata.workspace };
}

async function commitBaseChange(projectRoot: string, file: string, contents: string): Promise<void> {
  writeFileSync(join(projectRoot, file), contents, "utf8");
  await git(projectRoot, ["add", file]);
  await git(projectRoot, ["commit", "-m", "test: advance base"]);
}

async function head(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

async function git(cwd: string, args: readonly string[]) {
  return runner.run("git", args, { cwd, timeoutMs: 30_000 });
}

function passedVerification(): VerificationResult {
  return {
    status: "PASSED",
    commands: ["pnpm test"],
    output: "ok",
    diagnosticCode: null,
    diagnosticDetail: null,
  };
}

class IntegrationPreparationRunner implements ProcessRunner {
  public readonly dependencies: string[] = [];

  public async run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Readonly<Record<string, string>> }): Promise<ProcessResult> {
    if (command === "git") return await runner.run(command, args, options);
    if (args.includes("--version")) return { command, args, cwd: options.cwd, exitCode: 0, stdout: `${command} 11.19.0\n`, stderr: "" };
    this.dependencies.push([command, ...args].join(" "));
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: "prepared\n", stderr: "" };
  }
}
