import { access, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const knownGlobalFiles = [
  "config.json",
  "projects.db",
  "projects.db-shm",
  "projects.db-wal",
  "instance.json",
  "instance.lock",
] as const;

export interface GlobalCleanupInventory {
  readonly root: string;
  readonly knownFiles: readonly string[];
  readonly preservedEntries: readonly string[];
}

export async function inspectGlobalCleanup(root: string): Promise<GlobalCleanupInventory> {
  const canonicalRoot = resolve(root);
  let entries: string[];
  try {
    entries = await readdir(canonicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: canonicalRoot, knownFiles: [], preservedEntries: [] };
    throw error;
  }
  const known = new Set<string>(knownGlobalFiles);
  const isKnown = (entry: string): boolean => known.has(entry) || /^\.instance-[a-f0-9]+\.tmp$/u.test(entry);
  return {
    root: canonicalRoot,
    knownFiles: entries.filter(isKnown),
    preservedEntries: entries.filter((entry) => !isKnown(entry)),
  };
}

export async function executeGlobalCleanup(inventory: GlobalCleanupInventory): Promise<GlobalCleanupInventory> {
  for (const file of inventory.knownFiles) {
    const path = join(inventory.root, file);
    await access(path).then(() => rm(path, { force: true })).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  try {
    await rmdir(inventory.root);
  } catch (error) {
    if (!(["ENOENT", "ENOTEMPTY"] as (string | undefined)[]).includes((error as NodeJS.ErrnoException).code)) throw error;
  }
  return await inspectGlobalCleanup(inventory.root);
}
