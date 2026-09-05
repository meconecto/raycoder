import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-preparation-dogfood-"));
const projectRoot = join(fixtureRoot, "multistack-project");
const installedRoot = join(fixtureRoot, "installed-package");
const fakeBin = join(fixtureRoot, "fake-bin");
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(workspaceRoot, process.argv[2]);
const previousPath = process.env.PATH;
let succeeded = false;

try {
  mkdirSync(installedRoot, { recursive: true });
  if (suppliedTarball === undefined) {
    exec("pnpm", ["build"], workspaceRoot);
    exec("pnpm", ["pack", "--pack-destination", installedRoot], packageRoot);
  }
  const tarball = suppliedTarball ?? join(installedRoot, `raycoder-${packageManifest.version}.tgz`);
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({ private: true, dependencies: { raycoder: `file:${tarball}` } }), "utf8");
  writeFileSync(join(installedRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  exec("pnpm", ["install"], installedRoot);

  mkdirSync(projectRoot, { recursive: true });
  exec("git", ["init", "-b", "main"], projectRoot);
  exec("git", ["config", "user.name", "raycoder dogfood"], projectRoot);
  exec("git", ["config", "user.email", "dogfood@raycoder.local"], projectRoot);
  writeFixture("node/package.json", JSON.stringify({ private: true, packageManager: "pnpm@11.19.0" }));
  writeFixture("node/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  writeFixture("python/pyproject.toml", "[project]\nname='fixture'\nversion='0.0.0'\n");
  writeFixture("python/uv.lock", "version = 1\n");
  writeFixture("rust/Cargo.toml", "[package]\nname='fixture'\nversion='0.0.0'\n");
  writeFixture("rust/Cargo.lock", "version = 4\n");
  writeFixture("go/go.mod", "module example.test/dogfood\n\ngo 1.24\n");
  writeFixture("go/go.sum", "");
  const shellStrategy = process.platform === "win32" ? "pwsh" : "bash";
  const shellScript = process.platform === "win32" ? "prepare.ps1" : "prepare.sh";
  writeFixture(`shell/${shellScript}`, process.platform === "win32" ? "exit 0\n" : "#!/usr/bin/env bash\nexit 0\n");
  exec("git", ["add", "."], projectRoot);
  exec("git", ["commit", "-m", "test: multistack preparation fixture"], projectRoot);

  mkdirSync(fakeBin, { recursive: true });
  for (const tool of ["pnpm", "uv", "cargo", "go", shellStrategy]) {
    const path = join(fakeBin, process.platform === "win32" ? `${tool}.EXE` : tool);
    writeFileSync(path, "fixture", "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;

  const core = await import(pathToFileURL(join(installedRoot, "node_modules", "raycoder", "dist", "runtime.js")).href);
  const nativeRunner = new core.NodeProcessRunner();
  const commands = [];
  const preparationRunner = {
    async run(command, args, options) {
      if (command === "git") return await nativeRunner.run(command, args, options);
      if (args.includes("--version") || (command === "go" && args[0] === "version")) {
        return { command, args, cwd: options.cwd, exitCode: 0, stdout: `${command} fixture-1.0\n`, stderr: "" };
      }
      commands.push([command, ...args].join(" "));
      return { command, args, cwd: options.cwd, exitCode: 0, stdout: "offline fixture prepared\n", stderr: "" };
    },
  };
  let runtime = await core.ProjectRuntime.open(projectRoot, {
    adapter: new core.FakeAgentAdapter({ fileName: "prepared-dogfood.txt" }),
    runner: preparationRunner,
  });
  runtime.preparation.setConfig({
    mode: "explicit",
    units: [
      { root: "node", strategy: "pnpm" },
      { root: "python", strategy: "uv" },
      { root: "rust", strategy: "cargo" },
      { root: "go", strategy: "go" },
      { root: "shell", strategy: shellStrategy, script: shellScript, args: ["literal two words", "$(not-interpolated)"] },
    ],
  });
  runtime.tickets.create({ id: "prepare-all", title: "Prepare all", description: "Exercise durable multistack setup" });
  let fingerprint = "";
  try {
    await runtime.scheduler.enqueue("prepare-all", { dirtyPolicy: "cancel" });
    throw new Error("Preparation unexpectedly ran without project approval");
  } catch (error) {
    if (error?.code !== "preparation.approval_required") throw error;
    fingerprint = error.details.plan.fingerprint;
  }
  if (runtime.repository.listAgentSessions("prepare-all").length !== 0) throw new Error("Adapter started before preparation approval");
  await runtime.scheduler.enqueue("prepare-all", {
    dirtyPolicy: "cancel",
    preparationApproval: { fingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true },
  });
  if (runtime.repository.get("prepare-all").status !== "DONE") throw new Error("Prepared ticket did not reach DONE");
  const prepared = runtime.repository.latestWorkspacePreparationAttempt("prepare-all");
  if (prepared?.status !== "PREPARED" || prepared.output?.includes("fixture prepared") !== true) {
    throw new Error("Preparation attempt was not persisted with sanitized output");
  }
  const expected = [
    "pnpm install --frozen-lockfile",
    "uv sync --locked",
    "cargo fetch --locked",
    "go mod download",
    "go mod verify",
    `${shellStrategy} ${process.platform === "win32" ? "-NoLogo -NoProfile -NonInteractive -File" : "--noprofile --norc"} ${shellScript} literal two words $(not-interpolated)`,
  ];
  if (JSON.stringify(commands) !== JSON.stringify(expected)) throw new Error(`Unexpected preparation order: ${JSON.stringify(commands)}`);
  runtime.close();

  runtime = await core.ProjectRuntime.open(projectRoot, { adapter: new core.FakeAgentAdapter(), runner: preparationRunner });
  if (runtime.preparation.approval()?.fingerprint !== fingerprint) throw new Error("Project approval did not survive restart");
  if (runtime.repository.latestWorkspacePreparationAttempt("prepare-all")?.status !== "PREPARED") throw new Error("Prepared status did not survive restart");
  runtime.close();
  if (execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" }).trim() !== "") {
    throw new Error("Preparation dogfood changed tracked project files");
  }
  succeeded = true;
  console.log(`PASS workspace preparation dogfood from installed raycoder ${packageManifest.version}: approval, Node, Python, Rust, Go, shell, execution, and restart.`);
} finally {
  process.env.PATH = previousPath;
  if (succeeded) rmSync(fixtureRoot, { recursive: true, force: true });
  else console.error(`Workspace preparation dogfood fixture preserved for inspection: ${fixtureRoot}`);
}

function writeFixture(path, contents) {
  const absolute = join(projectRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function exec(command, args, cwd) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd, stdio: "inherit", env: { ...process.env, CI: "true" },
    });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true" } });
}
