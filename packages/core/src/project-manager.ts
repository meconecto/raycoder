import type { RegisteredProject, ProjectRegistry } from "./project-registry.js";
import { ProjectRuntime, type ProjectRuntimeOptions } from "./project-runtime.js";

export class ProjectManager {
  readonly #registry: ProjectRegistry;
  readonly #options: (project: RegisteredProject) => ProjectRuntimeOptions;
  readonly #runtimes = new Map<string, ProjectRuntime>();

  public constructor(
    registry: ProjectRegistry,
    options: (project: RegisteredProject) => ProjectRuntimeOptions,
  ) {
    this.#registry = registry;
    this.#options = options;
  }

  public list(): { project: RegisteredProject; open: boolean }[] {
    return this.#registry.list().map((project) => ({ project, open: this.#runtimes.has(project.id) }));
  }

  public async register(path: string, name?: string): Promise<ProjectRuntime> {
    const project = await this.#registry.register(path, name);
    return await this.open(project.id);
  }

  public async create(input: { path: string; name?: string; confirmGitInit: boolean }): Promise<ProjectRuntime> {
    const project = await this.#registry.create(input);
    return await this.open(project.id);
  }

  public async open(projectId: string): Promise<ProjectRuntime> {
    const existing = this.#runtimes.get(projectId);
    if (existing !== undefined) return existing;
    const project = this.#registry.get(projectId);
    const runtime = await ProjectRuntime.open(project.path, this.#options(project));
    this.#runtimes.set(projectId, runtime);
    return runtime;
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
