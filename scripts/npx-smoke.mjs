import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "raycoder-npx-"));

try {
  exec("pnpm", ["build"], workspaceRoot);
  exec("pnpm", ["pack", "--pack-destination", fixture], packageRoot);
  const tarball = join(fixture, `raycoder-${manifest.version}.tgz`);
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["exec", "--yes", `--package=${tarball}`, "--", "raycoder", "--version"],
    { cwd: fixture, encoding: "utf8" },
  ).trim();
  if (output !== manifest.version) throw new Error(`Unexpected npx version: ${output}`);
  console.log(`PASS npx installed and executed raycoder ${output}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function exec(command, args, cwd) {
  const executable = process.platform === "win32" && (command === "pnpm" || command === "npm")
    ? `${command}.cmd`
    : command;
  execFileSync(executable, args, { cwd, stdio: "inherit" });
}
