import type { GlobalConfigStore, MemoryService, PreflightReport, ProjectManager } from "@raycoder/core";

export class RaycoderApplicationHost {
  public readonly projects: ProjectManager;
  public readonly memory: MemoryService;
  public readonly config: GlobalConfigStore;
  readonly #runPreflight: () => Promise<PreflightReport>;
  #preflight: PreflightReport;

  public constructor(input: {
    projects: ProjectManager;
    memory: MemoryService;
    config: GlobalConfigStore;
    preflight: PreflightReport;
    runPreflight: () => Promise<PreflightReport>;
  }) {
    this.projects = input.projects;
    this.memory = input.memory;
    this.config = input.config;
    this.#preflight = input.preflight;
    this.#runPreflight = input.runPreflight;
  }

  public get preflight(): PreflightReport {
    return this.#preflight;
  }

  public async refreshPreflight(): Promise<PreflightReport> {
    this.#preflight = await this.#runPreflight();
    return this.#preflight;
  }

  public close(): void {
    this.projects.close();
  }
}
