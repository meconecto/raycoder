import type { RegisteredProject, ProjectRegistry } from "./project-registry.js";
import { ProjectInspector, type ProjectInspection } from "./project-inspector.js";
import { ProjectRuntime, type ProjectRuntimeOptions } from "./project-runtime.js";
import { ProjectActivityService, type ProjectActivityPage, type ProjectAttentionSummary } from "./project-activity.js";

export class ProjectManager {
  readonly #registry: ProjectRegistry;
  readonly #options: (project: RegisteredProject) => ProjectRuntimeOptions;
  readonly #runtimes = new Map<string, ProjectRuntime>();
  readonly #opening = new Map<string, Promise<ProjectRuntime>>();
  readonly #errors = new Map<string, string>();
  readonly #inspector: ProjectInspector;

  public constructor(
    registry: ProjectRegistry,
    options: (project: RegisteredProject) => ProjectRuntimeOptions,
    inspector = new ProjectInspector(),
  ) {
    this.#registry = registry;
    this.#options = options;
    this.#inspector = inspector;
  }

  public list(): { project: RegisteredProject; open: boolean; state: "closed" | "opening" | "open" | "error"; error: string | null; attention: ProjectAttentionSummary }[] {
    return this.#registry.list().map((project) => {
      const runtime = this.#runtimes.get(project.id);
      if (runtime !== undefined) this.#registry.setAttention(project.id, new ProjectActivityService(runtime.repository).summary());
      return {
      project,
      open: runtime !== undefined,
      state: runtime !== undefined
        ? "open"
        : this.#opening.has(project.id) ? "opening" : this.#errors.has(project.id) ? "error" : "closed",
      error: this.#errors.get(project.id) ?? null,
      attention: this.#registry.attention(project.id),
    };
    });
  }

  public activity(projectId: string, input: { before?: string; limit?: number; severity?: "info" | "warning" | "error" } = {}): ProjectActivityPage {
    const page = new ProjectActivityService(this.get(projectId).repository).list(input);
    this.#registry.setAttention(projectId, page.summary);
    return page;
  }

  public async inspect(path: string): Promise<ProjectInspection> {
    return await this.#inspector.inspect(path);
  }

  public async register(path: string, name?: string): Promise<ProjectRuntime> {
    const inspection = await this.inspect(path);
    if (!inspection.canRegister || inspection.repositoryRoot === null) {
      throw new Error(`Cannot register ${inspection.kind}: ${inspection.diagnostics.map((item) => item.message).join(" ")}`);
    }
    const project = await this.#registry.register(inspection.repositoryRoot, name);
    return await this.open(project.id);
  }

  public async create(input: { path: string; name?: string; confirmGitInit: boolean }): Promise<ProjectRuntime> {
    const inspection = await this.inspect(input.path);
    if (!inspection.canCreate) {
      throw new Error(`Cannot create project from ${inspection.kind}: ${inspection.diagnostics.map((item) => item.message).join(" ")}`);
    }
    const project = await this.#registry.create(input);
    return await this.open(project.id);
  }

  public async initialize(input: { path: string; name?: string; confirmGitInit: boolean }): Promise<ProjectRuntime> {
    const inspection = await this.inspect(input.path);
    if (!inspection.canInitialize) {
      throw new Error(`Cannot initialize project from ${inspection.kind}: ${inspection.diagnostics.map((item) => item.message).join(" ")}`);
    }
    const project = await this.#registry.initialize(input);
    return await this.open(project.id);
  }

  public async open(projectId: string): Promise<ProjectRuntime> {
    const existing = this.#runtimes.get(projectId);
    if (existing !== undefined) return existing;
    const pending = this.#opening.get(projectId);
    if (pending !== undefined) return await pending;
    const operation = this.#open(projectId);
    this.#opening.set(projectId, operation);
    try {
      return await operation;
    } finally {
      this.#opening.delete(projectId);
    }
  }

  async #open(projectId: string): Promise<ProjectRuntime> {
    const project = this.#registry.get(projectId);
    try {
      const runtime = await ProjectRuntime.open(project.path, this.#options(project));
      this.#runtimes.set(projectId, runtime);
      this.#errors.delete(projectId);
      this.#registry.touch(projectId);
      return runtime;
    } catch (error) {
      this.#errors.set(projectId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  public get(projectId: string): ProjectRuntime {
    const runtime = this.#runtimes.get(projectId);
    if (runtime === undefined) throw new Error(`Project ${projectId} is not open`);
    return runtime;
  }

  public closeProject(projectId: string): void {
    const runtime = this.#runtimes.get(projectId);
    if (runtime === undefined) return;
    runtime.close();
    this.#runtimes.delete(projectId);
  }

  public remove(projectId: string): void {
    this.closeProject(projectId);
    this.#errors.delete(projectId);
    this.#registry.remove(projectId);
  }

  public async reopen(projectId: string): Promise<ProjectRuntime> {
    this.closeProject(projectId);
    return await this.open(projectId);
  }

  public close(): void {
    for (const runtime of this.#runtimes.values()) runtime.close();
    this.#runtimes.clear();
    this.#registry.close();
  }
}
