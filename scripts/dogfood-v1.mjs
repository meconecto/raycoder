import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-dogfood-"));
const projectRoot = join(fixtureRoot, "raycoder-copy");
const installedRoot = join(fixtureRoot, "installed-package");
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(workspaceRoot, process.argv[2]);
let succeeded = false;

try {
  mkdirSync(installedRoot, { recursive: true });
  if (suppliedTarball === undefined) {
    exec("pnpm", ["build"], workspaceRoot);
    exec("pnpm", ["pack", "--pack-destination", installedRoot], packageRoot);
  }
  const tarball = suppliedTarball ?? join(installedRoot, `raycoder-${packageManifest.version}.tgz`);
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({
    private: true,
    dependencies: { raycoder: `file:${tarball}` },
  }), "utf8");
  writeFileSync(join(installedRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  exec("pnpm", ["install"], installedRoot);
  exec("git", ["clone", "--no-local", workspaceRoot, projectRoot], fixtureRoot);
  exec("git", ["switch", "-c", "dogfood"], projectRoot);
  exec("git", ["config", "user.name", "raycoder dogfood"], projectRoot);
  exec("git", ["config", "user.email", "dogfood@raycoder.local"], projectRoot);
  const core = await import(pathToFileURL(join(installedRoot, "node_modules", "raycoder", "dist", "runtime.js")).href);
  let runtime = await core.ProjectRuntime.open(projectRoot, {
    adapter: new core.FakeAgentAdapter({ fileName: "dogfood-parent.txt" }),
  });
  runtime.tickets.create({ id: "dogfood-parent", title: "Dogfood parent", description: "First V1 slice" });
  runtime.tickets.create({
    id: "dogfood-child",
    title: "Dogfood child",
    description: "Second dependent V1 slice",
    predecessorIds: ["dogfood-parent"],
  });
  await runtime.scheduler.enqueue("dogfood-parent", { dirtyPolicy: "cancel" });
  if (runtime.repository.get("dogfood-parent").status !== "DONE") throw new Error("Parent did not reach DONE");
  if (runtime.repository.get("dogfood-child").status !== "READY") throw new Error("Child was not promoted to READY");
  runtime.close();

  runtime = await core.ProjectRuntime.open(projectRoot, {
    adapter: new core.FakeAgentAdapter({ fileName: "dogfood-child.txt" }),
  });
  if (runtime.repository.get("dogfood-child").status !== "READY") throw new Error("READY did not survive restart");
  await runtime.scheduler.enqueue("dogfood-child", { dirtyPolicy: "cancel" });
  if (runtime.repository.get("dogfood-child").status !== "DONE") throw new Error("Child did not reach DONE after restart");
  runtime.close();
  succeeded = true;
  console.log(`PASS V1 dogfood from installed raycoder ${packageManifest.version}: separate source copy, dependent DAG, restart, READY promotion, and DONE integration.`);
} finally {
  if (succeeded) rmSync(fixtureRoot, { recursive: true, force: true });
  else console.error(`Dogfood fixture preserved for inspection: ${fixtureRoot}`);
}

function exec(command, args, cwd) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true" } });
}
