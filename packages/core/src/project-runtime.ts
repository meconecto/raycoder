import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterCapabilities, AgentAdapter } from "./agent-adapter.js";
import { Dispatcher } from "./dispatcher.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import type { IntegrationMode } from "./domain.js";
import { GitIntegrationRecoveryEvidence, IntegrationService } from "./integration-service.js";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";
import { ProjectOrchestrator } from "./project-orchestrator.js";
import type { ProjectVerifier } from "./project-verifier.js";
import { RecoveryService, type RecoveryResult } from "./recovery.js";
import { Scheduler } from "./scheduler.js";
import { TicketActions } from "./ticket-actions.js";
import { TicketRepository } from "./ticket-repository.js";

export interface ProjectRuntimeOptions {
  readonly adapter: AgentAdapter;
  readonly reviewer?: AgentAdapter;
  readonly integrationMode?: IntegrationMode;
  readonly runner?: ProcessRunner;
  readonly verifier?: ProjectVerifier;
}

export class ProjectRuntime {
  public readonly projectRoot: string;
  public readonly baseBranch: string;
  public readonly repository: TicketRepository;
  public readonly orchestrator: ProjectOrchestrator;
  public readonly scheduler: Scheduler;
  public readonly tickets: TicketActions;
  public readonly recovery: readonly RecoveryResult[];
  readonly #adapter: AgentAdapter;

  private constructor(input: {
    projectRoot: string;
    baseBranch: string;
    repository: TicketRepository;
    orchestrator: ProjectOrchestrator;
    scheduler: Scheduler;
    tickets: TicketActions;
    recovery: readonly RecoveryResult[];
    adapter: AgentAdapter;
  }) {
    this.projectRoot = input.projectRoot;
    this.baseBranch = input.baseBranch;
    this.repository = input.repository;
    this.orchestrator = input.orchestrator;
    this.scheduler = input.scheduler;
    this.tickets = input.tickets;
    this.recovery = input.recovery;
    this.#adapter = input.adapter;
  }

  public static async open(projectPath: string, options: ProjectRuntimeOptions): Promise<ProjectRuntime> {
    const runner = options.runner ?? new NodeProcessRunner();
    const workspaces = new GitWorkspaceManager(runner);
    const projectRoot = await workspaces.prepareProject(projectPath);
    const baseBranch = (await runner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    })).stdout.trim();
    await mkdir(join(projectRoot, ".raycoder"), { recursive: true });
    const repository = new TicketRepository(join(projectRoot, ".raycoder", "raycoder.db"));
    const recovery = await new RecoveryService(
      repository,
      undefined,
      new GitIntegrationRecoveryEvidence(projectRoot, runner),
    ).recoverUncontrolledShutdown();
    const dispatcher = new Dispatcher(repository, workspaces, options.adapter, options.reviewer ?? options.adapter);
    const integration = new IntegrationService(repository, projectRoot, options.integrationMode ?? "auto", {
      runner,
      ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    });
    const orchestrator = new ProjectOrchestrator(repository, dispatcher, integration);
    const scheduler = new Scheduler(repository, orchestrator, projectRoot);
    const tickets = new TicketActions(repository, orchestrator, scheduler, baseBranch, projectRoot);
    return new ProjectRuntime({
      projectRoot,
      baseBranch,
      repository,
      orchestrator,
      scheduler,
      tickets,
      recovery,
      adapter: options.adapter,
    });
  }

  public async capabilities(): Promise<AdapterCapabilities> {
    return await this.#adapter.capabilities();
  }

  public close(): void {
    this.repository.close();
  }
}
