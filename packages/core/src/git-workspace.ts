import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { NodeProcessRunner, type ProcessRunner } from "./process.js";
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
    const projectRoot = resolve((await this.#git(requestedPath, ["rev-parse", "--show-toplevel"])).stdout.trim());
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

  async #git(cwd: string, args: readonly string[]) {
    return await this.#runner.run("git", args, { cwd, timeoutMs: 30_000 });
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function sanitizeTicketId(id: string): string {
  const sanitized = id.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (sanitized.length === 0) throw new Error("Ticket id cannot produce an empty Git branch name");
  return sanitized.slice(0, 80);
}
