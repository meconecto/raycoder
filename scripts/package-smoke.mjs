import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const fixture = mkdtempSync(join(tmpdir(), "raycoder-package-"));
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

try {
  exec("pnpm", ["build"], workspaceRoot);
  exec("pnpm", ["pack", "--pack-destination", fixture], packageRoot);
  const tarball = join(fixture, `raycoder-${packageManifest.version}.tgz`);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    private: true,
    dependencies: { raycoder: `file:${tarball}` },
  }), "utf8");
  writeFileSync(join(fixture, "pnpm-workspace.yaml"), "allowBuilds:\n  better-sqlite3: true\n", "utf8");
  exec("pnpm", ["install"], fixture);
  const cli = join(fixture, "node_modules", "raycoder", "dist", "cli.js");
  const version = execFileSync(process.execPath, [cli, "--version"], { cwd: fixture, encoding: "utf8" }).trim();
  if (version !== packageManifest.version) throw new Error(`Unexpected packaged version: ${version}`);
  const help = execFileSync(process.execPath, [cli, "--help"], { cwd: fixture, encoding: "utf8" });
  if (!help.includes("npx raycoder")) throw new Error("Packaged CLI help is unavailable");
  exec("git", ["init", "-b", "main"], fixture);
  const doctor = spawnSync(process.execPath, [cli, "doctor", fixture], { cwd: fixture, encoding: "utf8" });
  const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
  if (!doctorOutput.includes("Git repository") || !doctorOutput.includes(" on main")) {
    throw new Error(`Packaged CLI could not inspect a clean Git fixture:\n${doctorOutput}`);
  }
  const installedPackage = JSON.parse(readFileSync(join(fixture, "node_modules", "raycoder", "package.json"), "utf8"));
  if (installedPackage.dependencies?.["@raycoder/core"] !== undefined) {
    throw new Error("Published package still depends on the private workspace core");
  }
  console.log(`PASS packaged raycoder ${version} from ${tarball}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function exec(command, args, cwd) {
  const executable = process.platform === "win32" && (command === "pnpm" || command === "npm")
    ? `${command}.cmd`
    : command;
  execFileSync(executable, args, { cwd, stdio: "inherit" });
}
