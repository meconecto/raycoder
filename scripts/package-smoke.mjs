import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const fixture = mkdtempSync(join(tmpdir(), "raycoder-package-"));
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(workspaceRoot, process.argv[2]);

try {
  if (suppliedTarball === undefined) {
    exec("pnpm", ["build"], workspaceRoot);
    exec("pnpm", ["pack", "--pack-destination", fixture], packageRoot);
  }
  const tarball = suppliedTarball ?? join(fixture, `raycoder-${packageManifest.version}.tgz`);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    private: true,
    dependencies: { raycoder: `file:${tarball}` },
  }), "utf8");
  writeFileSync(join(fixture, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  exec("pnpm", ["install"], fixture);
  const cli = join(fixture, "node_modules", "raycoder", "dist", "cli.js");
  const version = execFileSync(process.execPath, [cli, "--version"], { cwd: fixture, encoding: "utf8" }).trim();
  if (version !== packageManifest.version) throw new Error(`Unexpected packaged version: ${version}`);
  const help = execFileSync(process.execPath, [cli, "--help"], { cwd: fixture, encoding: "utf8" });
  if (!help.includes("npx raycoder")) throw new Error("Packaged CLI help is unavailable");
  exec("git", ["init", "-b", "main"], fixture);
  const doctor = spawnSync(process.execPath, [cli, "doctor", fixture], { cwd: fixture, encoding: "utf8" });
  const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
  if (!doctorOutput.includes("git_repository") || !doctorOutput.includes("branch: main")) {
    throw new Error(`Packaged CLI could not inspect a clean Git fixture:\n${doctorOutput}`);
  }
  const installedPackage = JSON.parse(readFileSync(join(fixture, "node_modules", "raycoder", "package.json"), "utf8"));
  if (installedPackage.dependencies?.["@raycoder/core"] !== undefined) {
    throw new Error("Published package still depends on the private workspace core");
  }
  const runtime = await import(pathToFileURL(join(fixture, "node_modules", "raycoder", "dist", "runtime.js")).href);
  if (
    typeof runtime.ProjectRuntime?.open !== "function"
    || typeof runtime.FakeAgentAdapter !== "function"
    || typeof runtime.UserLocalInstaller !== "function"
  ) {
    throw new Error("Published package does not expose the bundled runtime");
  }
  const pinnedSkills = join(fixture, "node_modules", "raycoder", "dist", "assets", "skills", "mattpocock");
  const pinned = JSON.parse(readFileSync(join(pinnedSkills, "PINNED.json"), "utf8"));
  if (pinned.commit !== "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76") {
    throw new Error("Published skill bundle is not pinned to the expected commit");
  }
  if (!readFileSync(join(pinnedSkills, "engineering", "implement", "SKILL.md"), "utf8").includes("Implement the work")) {
    throw new Error("Published package is missing the engineering skill bundle");
  }
  console.log(`PASS packaged raycoder ${version} from ${tarball}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function exec(command, args, cwd) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
