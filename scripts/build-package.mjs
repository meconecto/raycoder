import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const outdir = join(packageRoot, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    cli: join(packageRoot, "src", "cli.ts"),
    "smoke-codex": join(packageRoot, "src", "smoke-codex.ts"),
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  alias: {
    "@raycoder/core": join(workspaceRoot, "packages", "core", "src", "index.ts"),
  },
  external: ["@openai/codex-sdk", "better-sqlite3"],
  logLevel: "info",
});
await copyFile(join(workspaceRoot, "README.md"), join(outdir, "README.md"));
await copyFile(join(workspaceRoot, "LICENSE"), join(outdir, "LICENSE"));
await cp(join(workspaceRoot, "assets"), join(outdir, "assets"), { recursive: true });
