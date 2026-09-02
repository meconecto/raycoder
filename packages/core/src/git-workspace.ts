import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { NodeProcessRunner, ProcessExecutionError, type ProcessRunner } from "./process.js";
import type { GitMetadata } from "./ticket-repository.js";

export type DirtyWorkspacePolicy = "cancel" | "committed-head";

export class DirtyRepositoryError extends Error {
  public constructor() {
    super(
      "The repository has uncommitted changes. Choose committed-head explicitly to continue without including them, or cancel and prepare the repository first.",
    );
    this.name = "DirtyRepositoryError";
  }
}

export class GitWorkspaceManager {
  readonly #runner: ProcessRunner;

  public constructor(runner: ProcessRunner = new NodeProcessRunner()) {
    this.#runner = runner;
  }

  public async prepareProject(projectPath: string): Promise<string> {
    const requestedPath = resolve(projectPath);
    const projectRoot = await realpath(resolve((await this.#git(requestedPath, ["rev-parse", "--show-toplevel"])).stdout.trim()));
    await this.#excludeMetadata(projectRoot);
    return projectRoot;
  }

  public async create(input: {
    projectRoot: string;
    ticketId: string;
    baseBranch: string;
    dirtyPolicy: DirtyWorkspacePolicy;
  }): Promise<GitMetadata> {
    const projectRoot = await this.prepareProject(input.projectRoot);

    const dirty = (await this.#git(projectRoot, ["status", "--porcelain"])).stdout.trim().length > 0;
    if (dirty && input.dirtyPolicy !== "committed-head") throw new DirtyRepositoryError();

    const baseCommit = (await this.#git(projectRoot, ["rev-parse", input.baseBranch])).stdout.trim();
    const safeTicketId = sanitizeTicketId(input.ticketId);
    const branch = `raycoder/${safeTicketId}`;
    const workspace = join(projectRoot, ".raycoder", "workspaces", safeTicketId);
    await mkdir(join(projectRoot, ".raycoder", "workspaces"), { recursive: true });
    await this.#git(projectRoot, ["worktree", "add", "-b", branch, workspace, baseCommit]);

    return { branch, baseBranch: input.baseBranch, baseCommit, workspace };
  }

  public async hasCommitSince(workspace: string, baseCommit: string): Promise<boolean> {
    const result = await this.#git(workspace, ["rev-list", "--count", `${baseCommit}..HEAD`]);
    return Number.parseInt(result.stdout.trim(), 10) > 0;
  }

  public async head(workspace: string): Promise<string> {
    return (await this.#git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
  }

  public async agentWritableDirectories(workspace: string, branch: string): Promise<readonly string[]> {
    const expectedRef = `refs/heads/${branch}`;
    let currentRef = "";
    try {
      currentRef = (await this.#git(workspace, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
    } catch (error) {
      if (!(error instanceof ProcessExecutionError) || error.result.exitCode !== 1) throw error;
    }
    if (currentRef !== expectedRef) {
      throw new Error(`Workspace is on ${currentRef || "a detached HEAD"}, expected ${expectedRef}`);
    }

    const commonDirectory = canonicalPath(
      (await this.#git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(),
    );
    const candidates = [
      (await this.#git(workspace, ["rev-parse", "--absolute-git-dir"])).stdout.trim(),
      await this.#absoluteGitPath(workspace, "objects"),
      dirname(await this.#absoluteGitPath(workspace, expectedRef)),
      dirname(await this.#absoluteGitPath(workspace, `logs/${expectedRef}`)),
    ].map((path) => canonicalPath(path));

    for (const path of candidates) {
      if (!isPathInsideOrEqual(commonDirectory, path)) {
        throw new Error(`Git metadata path escaped the common Git directory: ${path}`);
      }
    }
    return [...new Set(candidates)];
  }

  async #excludeMetadata(projectRoot: string): Promise<void> {
    const gitPath = (await this.#git(projectRoot, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim();
    const excludePath = isAbsolute(gitPath) ? gitPath : resolve(projectRoot, gitPath);
    let contents = "";
    try {
      contents = await readFile(excludePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lines = contents.split(/\r?\n/u);
    if (!lines.includes("/.raycoder/")) {
      const prefix = contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`;
      await writeFile(excludePath, `${prefix}/.raycoder/\n`, "utf8");
    }
  }

  async #absoluteGitPath(workspace: string, path: string): Promise<string> {
    const output = (await this.#git(workspace, ["rev-parse", "--path-format=absolute", "--git-path", path])).stdout.trim();
    return isAbsolute(output) ? output : resolve(workspace, output);
  }

  async #git(cwd: string, args: readonly string[]) {
    return await this.#runner.run("git", args, { cwd, timeoutMs: 30_000 });
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const path = relative(canonicalPath(parent), canonicalPath(child));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const path = relative(canonicalPath(parent), canonicalPath(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function canonicalPath(input: string): string {
  let current = resolve(input);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(current), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

function sanitizeTicketId(id: string): string {
  const sanitized = id.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (sanitized.length === 0) throw new Error("Ticket id cannot produce an empty Git branch name");
  return sanitized.slice(0, 80);
}
