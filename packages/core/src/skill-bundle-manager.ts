import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillBundleInfo {
  readonly source: string;
  readonly commit: string;
  readonly bundle: string;
  readonly license: string;
}

export class SkillBundleManager {
  readonly #bundleRoots: readonly string[];

  public constructor(bundleRoot?: string) {
    const moduleRoot = dirname(fileURLToPath(import.meta.url));
    this.#bundleRoots = bundleRoot === undefined
      ? [
          join(moduleRoot, "assets", "skills", "mattpocock"),
          join(moduleRoot, "..", "..", "..", "assets", "skills", "mattpocock"),
        ].map((candidate) => resolve(candidate))
      : [resolve(bundleRoot)];
  }

  public async info(): Promise<SkillBundleInfo> {
    const value: unknown = JSON.parse(await readFile(join(await this.#resolveRoot(), "PINNED.json"), "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("Invalid pinned skill bundle manifest");
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.source !== "string"
      || typeof candidate.commit !== "string"
      || typeof candidate.bundle !== "string"
      || typeof candidate.license !== "string"
    ) throw new Error("Incomplete pinned skill bundle manifest");
    return candidate as unknown as SkillBundleInfo;
  }

  public async ensureProjectSkills(projectRoot: string): Promise<{ installed: boolean; path: string; info: SkillBundleInfo }> {
    const target = join(resolve(projectRoot), ".raycoder", "skills");
    const info = await this.info();
    try {
      await access(join(target, "PINNED.json"));
      return { installed: false, path: target, info };
    } catch {
      await this.#copy(target);
      return { installed: true, path: target, info };
    }
  }

  public async restoreProjectSkills(projectRoot: string): Promise<{ path: string; info: SkillBundleInfo }> {
    const target = join(resolve(projectRoot), ".raycoder", "skills");
    await rm(target, { recursive: true, force: true });
    await this.#copy(target);
    return { path: target, info: await this.info() };
  }

  async #copy(target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    await cp(await this.#resolveRoot(), target, { recursive: true, errorOnExist: true, force: false });
  }

  async #resolveRoot(): Promise<string> {
    for (const candidate of this.#bundleRoots) {
      try {
        await access(join(candidate, "PINNED.json"));
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error(`Bundled skills are unavailable; checked: ${this.#bundleRoots.join(", ")}`);
  }
}
