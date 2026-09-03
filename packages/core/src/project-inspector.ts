import { readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";

export type ProjectPathKind =
  | "git_repository"
  | "empty_directory"
  | "non_git_directory"
  | "missing"
  | "inaccessible";

export interface ProjectDiagnostic {
  readonly level: "ok" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

export interface ProjectInspection {
  readonly requestedPath: string;
  readonly canonicalPath: string | null;
  readonly kind: ProjectPathKind;
  readonly repositoryRoot: string | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly hasBaseCommit: boolean;
  readonly canRegister: boolean;
  readonly canInitialize: boolean;
  readonly canCreate: boolean;
  readonly diagnostics: readonly ProjectDiagnostic[];
}

export class ProjectInspector {
  readonly #runner: ProcessRunner;

  public constructor(runner: ProcessRunner = new NodeProcessRunner()) {
    this.#runner = runner;
  }

  public async inspect(path: string): Promise<ProjectInspection> {
    const requestedPath = resolve(path);
    let info;
    try {
      info = await stat(requestedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return result(requestedPath, null, "missing", {
          canCreate: true,
          diagnostics: [{ level: "warning", code: "project.path_missing", message: "The directory does not exist yet." }],
        });
      }
      return result(requestedPath, null, "inaccessible", {
        diagnostics: [{ level: "error", code: "project.path_inaccessible", message: errorMessage(error) }],
      });
    }

    if (!info.isDirectory()) {
      return result(requestedPath, null, "inaccessible", {
        diagnostics: [{ level: "error", code: "project.not_directory", message: "The selected path is not a directory." }],
      });
    }

    let canonicalPath: string;
    try {
      canonicalPath = resolve(await realpath(requestedPath));
    } catch (error) {
      return result(requestedPath, null, "inaccessible", {
        diagnostics: [{ level: "error", code: "project.path_inaccessible", message: errorMessage(error) }],
      });
    }
    try {
      const repositoryRoot = resolve((await this.#runner.run("git", ["rev-parse", "--show-toplevel"], {
        cwd: canonicalPath,
        timeoutMs: 10_000,
      })).stdout.trim());
      const [branch, head, status] = await Promise.all([
        this.#optionalGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        this.#optionalGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
        this.#runner.run("git", ["status", "--porcelain"], { cwd: repositoryRoot, timeoutMs: 10_000 }),
      ]);
      const hasBaseCommit = head !== null;
      return result(requestedPath, canonicalPath, "git_repository", {
        repositoryRoot,
        branch,
        head,
        dirty: status.stdout.trim().length > 0,
        hasBaseCommit,
        canRegister: true,
        diagnostics: hasBaseCommit
          ? [{ level: "ok", code: "project.git_ready", message: `Git repository on ${branch ?? "detached HEAD"}.` }]
          : [{ level: "warning", code: "project.base_commit_missing", message: "Create the first commit before running tickets." }],
      });
    } catch {
      try {
        await this.#runner.run("git", ["--version"], { cwd: canonicalPath, timeoutMs: 10_000 });
      } catch (error) {
        return result(requestedPath, canonicalPath, "inaccessible", {
          diagnostics: [{ level: "error", code: "git.unavailable", message: errorMessage(error) }],
        });
      }
    }

    let entries: string[];
    try {
      entries = await readdir(canonicalPath);
    } catch (error) {
      return result(requestedPath, canonicalPath, "inaccessible", {
        diagnostics: [{ level: "error", code: "project.path_inaccessible", message: errorMessage(error) }],
      });
    }
    if (entries.length === 0) {
      return result(requestedPath, canonicalPath, "empty_directory", {
        canCreate: true,
        diagnostics: [{ level: "ok", code: "project.empty_directory", message: "The empty directory can become a new project." }],
      });
    }
    return result(requestedPath, canonicalPath, "non_git_directory", {
      canInitialize: true,
      diagnostics: [{
        level: "warning",
        code: "project.git_initialization_required",
        message: "Git can be initialized here, but existing files will not be staged or committed.",
      }],
    });
  }

  async #optionalGit(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      const value = (await this.#runner.run("git", args, { cwd, timeoutMs: 10_000 })).stdout.trim();
      return value.length === 0 ? null : value;
    } catch {
      return null;
    }
  }
}

function result(
  requestedPath: string,
  canonicalPath: string | null,
  kind: ProjectPathKind,
  overrides: Partial<Omit<ProjectInspection, "requestedPath" | "canonicalPath" | "kind">>,
): ProjectInspection {
  return {
    requestedPath,
    canonicalPath,
    kind,
    repositoryRoot: null,
    branch: null,
    head: null,
    dirty: null,
    hasBaseCommit: false,
    canRegister: false,
    canInitialize: false,
    canCreate: false,
    diagnostics: [],
    ...overrides,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
