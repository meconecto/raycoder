import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-verification-dogfood-"));
const projectRoot = join(fixtureRoot, "multistack-project");
const fakeBin = join(fixtureRoot, "fake-bin");
const previousPath = process.env.PATH;
let succeeded = false;

try {
  exec("pnpm", ["build"], workspaceRoot);

  mkdirSync(projectRoot, { recursive: true });
  exec("git", ["init", "-b", "main"], projectRoot);
  exec("git", ["config", "user.name", "raycoder dogfood"], projectRoot);
  exec("git", ["config", "user.email", "dogfood@raycoder.local"], projectRoot);
  writeFixture("node/package.json", JSON.stringify({
    private: true,
    packageManager: "pnpm@11.19.0",
    scripts: { verify: "fixture" },
  }));
  writeFixture("node/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  writeFixture("python/pyproject.toml", "[project]\nname='fixture'\nversion='0.0.0'\n");
  writeFixture("python/uv.lock", "version = 1\n");
  writeFixture("rust/Cargo.toml", "[package]\nname='fixture'\nversion='0.0.0'\n");
  writeFixture("rust/Cargo.lock", "version = 4\n");
  writeFixture("go/go.mod", "module example.test/dogfood\n\ngo 1.24\n");
  writeFixture("go/go.sum", "");
  const shellStrategy = process.platform === "win32" ? "pwsh" : "bash";
  const shellScript = process.platform === "win32" ? "verify.ps1" : "verify.sh";
  writeFixture(`shell/${shellScript}`, process.platform === "win32" ? "exit 0\n" : "#!/usr/bin/env bash\nexit 0\n");
  exec("git", ["add", "."], projectRoot);
  exec("git", ["commit", "-m", "test: multistack verification fixture"], projectRoot);

  mkdirSync(fakeBin, { recursive: true });
  for (const tool of ["pnpm", "uv", "cargo", "go", shellStrategy]) {
    const path = join(fakeBin, process.platform === "win32" ? `${tool}.EXE` : tool);
    writeFileSync(path, "fixture", "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o755);
  }
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;

  const core = await import(pathToFileURL(join(workspaceRoot, "apps", "server", "dist", "runtime.js")).href);
  const nativeRunner = new core.NodeProcessRunner();
  const commands = [];
  const verificationRunner = {
    async run(command, args, options) {
      if (command === "git") return await nativeRunner.run(command, args, options);
      if (args.includes("--version") || (command === "go" && args[0] === "version")) {
        return { command, args, cwd: options.cwd, exitCode: 0, stdout: `${command} fixture-1.0\n`, stderr: "" };
      }
      commands.push([command, ...args].join(" "));
      return { command, args, cwd: options.cwd, exitCode: 0, stdout: "offline fixture verified\n", stderr: "" };
    },
  };
  mkdirSync(join(projectRoot, ".raycoder"), { recursive: true });
  let repository = new core.TicketRepository(join(projectRoot, ".raycoder", "raycoder.db"));
  repository.create(core.createTicket({
    id: "verify-all",
    title: "Verify all",
    description: "Exercise durable multistack verification",
    baseBranch: "main",
    hasPredecessors: false,
  }));
  let verification = new core.WorkspaceVerificationService(repository, verificationRunner);
  verification.setConfig({
    mode: "explicit",
    units: [
      { root: "node", strategy: "pnpm" },
      { root: "python", strategy: "uv" },
      { root: "rust", strategy: "cargo" },
      { root: "go", strategy: "go" },
      { root: "shell", strategy: shellStrategy, script: shellScript, args: ["literal two words", "$(not-interpolated)"] },
    ],
  });
  const targetCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  let fingerprint = "";
  try {
    await verification.authorize({ ticketId: "verify-all", workspace: projectRoot, targetCommit });
    throw new Error("Verification unexpectedly ran without project approval");
  } catch (error) {
    if (error?.code !== "verification.approval_required") throw error;
    fingerprint = error.details.plan.fingerprint;
  }
  const passed = await verification.verify({
    ticketId: "verify-all",
    workspace: projectRoot,
    targetCommit,
    approval: { fingerprint, allowVerification: true, rememberForProject: true },
  });
  if (passed.status !== "PASSED" || passed.output?.includes("fixture verified") !== true) {
    throw new Error("Verification attempt was not persisted with sanitized output");
  }
  const expected = [
    "pnpm run verify",
    "uv run --locked pytest",
    "cargo test --locked",
    "go test ./...",
    `${shellStrategy} ${process.platform === "win32" ? "-NoLogo -NoProfile -NonInteractive -File" : "--noprofile --norc"} ${shellScript} literal two words $(not-interpolated)`,
  ];
  if (JSON.stringify(commands) !== JSON.stringify(expected)) throw new Error(`Unexpected verification order: ${JSON.stringify(commands)}`);
  repository.close();

  repository = new core.TicketRepository(join(projectRoot, ".raycoder", "raycoder.db"));
  verification = new core.WorkspaceVerificationService(repository, verificationRunner);
  if (verification.approval()?.fingerprint !== fingerprint) throw new Error("Verification approval did not survive restart");
  if (repository.latestWorkspaceVerificationAttempt("verify-all")?.status !== "PASSED") throw new Error("Passed verification did not survive restart");
  repository.close();
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: projectRoot, encoding: "utf8" }).trim() !== "") {
    throw new Error("Verification dogfood changed tracked project files");
  }
  succeeded = true;
  console.log("PASS workspace verification dogfood: approval, Node, Python, Rust, Go, shell, ordering, and restart.");
} finally {
  process.env.PATH = previousPath;
  if (succeeded) rmSync(fixtureRoot, { recursive: true, force: true });
  else console.error(`Workspace verification dogfood fixture preserved for inspection: ${fixtureRoot}`);
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
