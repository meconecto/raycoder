import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterCapabilities, AgentAdapter } from "./agent-adapter.js";
import { Dispatcher } from "./dispatcher.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import type { IntegrationMode } from "./domain.js";
import type { GlobalConfigStore, ReviewMode } from "./global-config.js";
import { GitIntegrationRecoveryEvidence, IntegrationService } from "./integration-service.js";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";
import { PlanningPipeline } from "./planning-pipeline.js";
import { PreviewManager } from "./preview-manager.js";
import { ProjectOrchestrator } from "./project-orchestrator.js";
import type { ProjectVerifier } from "./project-verifier.js";
import { RecoveryService, type RecoveryResult } from "./recovery.js";
import { Scheduler } from "./scheduler.js";
import { SettingsService } from "./settings-service.js";
import { SkillBundleManager } from "./skill-bundle-manager.js";
import { TicketActions } from "./ticket-actions.js";
import { TicketRepository, type PlanningSession } from "./ticket-repository.js";
import { WorkspacePreparationService } from "./workspace-preparation.js";

export interface ProjectRuntimeOptions {
  readonly adapter: AgentAdapter;
  readonly reviewer?: AgentAdapter;
  readonly integrationMode?: IntegrationMode;
  readonly runner?: ProcessRunner;
  readonly verifier?: ProjectVerifier;
  readonly reviewMode?: ReviewMode;
  readonly skillBundle?: SkillBundleManager;
  readonly globalConfigStore?: GlobalConfigStore;
}

export class ProjectRuntime {
  public readonly projectRoot: string;
  public readonly baseBranch: string;
  public readonly repository: TicketRepository;
  public readonly orchestrator: ProjectOrchestrator;
  public readonly scheduler: Scheduler;
  public readonly tickets: TicketActions;
  public readonly planning: PlanningPipeline;
  public readonly preview: PreviewManager;
  public readonly skills: SkillBundleManager;
  public readonly settings: SettingsService | null;
  public readonly preparation: WorkspacePreparationService;
  public readonly recovery: readonly RecoveryResult[];
  public readonly planningRecovery: readonly PlanningSession[];
  readonly #adapter: AgentAdapter;

  private constructor(input: {
    projectRoot: string;
    baseBranch: string;
    repository: TicketRepository;
    orchestrator: ProjectOrchestrator;
    scheduler: Scheduler;
    tickets: TicketActions;
    planning: PlanningPipeline;
    preview: PreviewManager;
    skills: SkillBundleManager;
    settings: SettingsService | null;
    preparation: WorkspacePreparationService;
    recovery: readonly RecoveryResult[];
    planningRecovery: readonly PlanningSession[];
    adapter: AgentAdapter;
  }) {
    this.projectRoot = input.projectRoot;
    this.baseBranch = input.baseBranch;
    this.repository = input.repository;
    this.orchestrator = input.orchestrator;
    this.scheduler = input.scheduler;
    this.tickets = input.tickets;
    this.planning = input.planning;
    this.preview = input.preview;
    this.skills = input.skills;
    this.settings = input.settings;
    this.preparation = input.preparation;
    this.recovery = input.recovery;
    this.planningRecovery = input.planningRecovery;
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
    const skills = options.skillBundle ?? new SkillBundleManager();
    await skills.ensureProjectSkills(projectRoot);
    const settings = options.globalConfigStore === undefined
      ? null
      : new SettingsService(options.globalConfigStore, repository);
    const effective = settings === null ? null : await settings.effective([await options.adapter.capabilities()]);
    const recovery = await new RecoveryService(
      repository,
      undefined,
      new GitIntegrationRecoveryEvidence(projectRoot, runner),
    ).recoverUncontrolledShutdown();
    const preparation = new WorkspacePreparationService(repository, workspaces, runner);
    preparation.recoverInterrupted();
    const dispatcher = new Dispatcher(
      repository,
      workspaces,
      options.adapter,
      options.reviewer ?? options.adapter,
      options.reviewMode ?? effective?.reviewMode ?? "independent",
    );
    const integration = new IntegrationService(repository, projectRoot, options.integrationMode ?? effective?.integrationMode ?? "auto", {
      runner,
      preparation,
      ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    });
    const orchestrator = new ProjectOrchestrator(repository, dispatcher, integration, preparation);
    const scheduler = new Scheduler(repository, orchestrator, projectRoot);
    const tickets = new TicketActions(repository, orchestrator, scheduler, baseBranch, projectRoot);
    const planning = new PlanningPipeline(repository, options.adapter, projectRoot, baseBranch);
    const planningRecovery = planning.recoverInterruptedSessions();
    const preview = new PreviewManager(repository, projectRoot, runner);
    return new ProjectRuntime({
      projectRoot,
      baseBranch,
      repository,
      orchestrator,
      scheduler,
      tickets,
      planning,
      preview,
      skills,
      settings,
      preparation,
      recovery,
      planningRecovery,
      adapter: options.adapter,
    });
  }

  public async capabilities(): Promise<AdapterCapabilities> {
    return await this.#adapter.capabilities();
  }

  public close(): void {
    this.preview.stop();
    this.repository.close();
  }
}
