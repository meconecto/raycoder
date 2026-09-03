import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "raycoder-npx-"));
const packageOutput = mkdtempSync(join(tmpdir(), "raycoder-npx-package-"));
const isolatedHome = mkdtempSync(join(tmpdir(), "raycoder-npx-home-"));
const environment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  npm_config_cache: join(isolatedHome, "npm-cache"),
  npm_config_foreground_scripts: "true",
};
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(workspaceRoot, process.argv[2]);
let serverProcess;

try {
  if (suppliedTarball === undefined) {
    exec("pnpm", ["build"], workspaceRoot);
    exec("pnpm", ["pack", "--pack-destination", packageOutput], packageRoot);
  }
  const tarball = suppliedTarball ?? join(packageOutput, `raycoder-${manifest.version}.tgz`);
  stageLocalNpxFixture(tarball);
  const npmExec = ["exec", "--offline", "--yes=false", "--", "raycoder"];
  const version = npm([...npmExec, "--version"], fixture, environment).trim();
  if (version !== manifest.version) throw new Error(`Unexpected npx version: ${version}`);

  serverProcess = spawnNpm([...npmExec, "--no-open", "--port", "0"], fixture, environment);
  const firstOutput = await waitForOutput(serverProcess, /raycoder listening at (http:\/\/127\.0\.0\.1:\d+\/)/u, 60_000);
  const url = firstOutput.match(/raycoder listening at (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
  if (url === undefined) throw new Error(`Could not read server URL:\n${firstOutput}`);

  const [html, preflight] = await Promise.all([
    fetch(url).then(async (response) => await response.text()),
    fetch(new URL("/api/preflight", url)).then(async (response) => await response.json()),
  ]);
  if (!html.includes("Choose where to work") || !html.includes('src="/app.js"')) throw new Error("Packaged UI was not served");
  if (preflight.canServe !== true || typeof preflight.canExecute !== "boolean") throw new Error("Packaged preflight contract is invalid");
  if (existsSync(join(fixture, ".raycoder"))) throw new Error("Starting raycoder created .raycoder metadata in the invocation directory");

  const reused = npm([...npmExec, "--no-open", "--port", "0"], fixture, environment);
  if (!reused.includes("Reusing raycoder") || !reused.includes(url)) throw new Error(`Second invocation did not reuse the instance:\n${reused}`);

  const recordPath = join(isolatedHome, ".raycoder", "instance.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const shutdown = await fetch(new URL("/api/instance/shutdown", url), {
    method: "POST",
    headers: { "x-raycoder-instance-nonce": record.nonce },
  });
  if (shutdown.status !== 202) throw new Error(`Authenticated shutdown returned HTTP ${shutdown.status}`);
  await waitForExit(serverProcess, 15_000);
  serverProcess = undefined;
  if (existsSync(recordPath)) throw new Error("Clean shutdown left the instance descriptor behind");
  console.log(`PASS npx tarball server ${manifest.version}: UI, preflight, CWD isolation, reuse and shutdown`);
} finally {
  if (serverProcess !== undefined && serverProcess.exitCode === null) {
    try {
      const record = JSON.parse(readFileSync(join(isolatedHome, ".raycoder", "instance.json"), "utf8"));
      process.kill(record.pid, "SIGTERM");
    } catch {
      serverProcess.kill();
    }
  }
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(packageOutput, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function stageLocalNpxFixture(tarball) {
  const modules = join(fixture, "node_modules");
  const extraction = join(fixture, "extracted");
  mkdirSync(modules, { recursive: true });
  mkdirSync(extraction, { recursive: true });
  exec("tar", ["-xzf", tarball, "-C", extraction], fixture);
  renameSync(join(extraction, "package"), join(modules, "raycoder"));
  rmSync(extraction, { recursive: true, force: true });

  const codexSdk = realpathSync(join(packageRoot, "node_modules", "@openai", "codex-sdk"));
  const openaiModules = join(modules, "@openai");
  mkdirSync(openaiModules, { recursive: true });
  symlinkSync(codexSdk, join(openaiModules, "codex-sdk"), process.platform === "win32" ? "junction" : "dir");

  const bin = join(modules, ".bin");
  mkdirSync(bin, { recursive: true });
  const posixLauncher = join(bin, "raycoder");
  writeFileSync(posixLauncher, '#!/bin/sh\nexec node "$(dirname "$0")/../raycoder/dist/cli.js" "$@"\n', { mode: 0o755 });
  chmodSync(posixLauncher, 0o755);
  writeFileSync(join(bin, "raycoder.cmd"), '@echo off\r\nnode "%~dp0\\..\\raycoder\\dist\\cli.js" %*\r\n', "utf8");
  writeFileSync(join(fixture, "package.json"), `${JSON.stringify({ private: true })}\n`, "utf8");
}

function exec(command, args, cwd) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], { cwd, stdio: "inherit" });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function npm(args, cwd, env) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const invocation = npmInvocation(args);
      return execFileSync(invocation.command, invocation.args, { cwd, env, encoding: "utf8", timeout: 60_000 });
    } catch (error) {
      lastError = error;
      if (attempt === 1) console.warn("npm exec failed once; retrying with the same isolated cache");
    }
  }
  throw lastError;
}

function spawnNpm(args, cwd, env) {
  const invocation = npmInvocation(args);
  const child = spawn(invocation.command, invocation.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    const npmCli = windowsNpmCli();
    if (npmCli !== undefined) return { command: process.execPath, args: [npmCli, ...args] };
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
  }
  return { command: "npm", args };
}

function windowsNpmCli() {
  const candidates = [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  try {
    const commands = execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8" })
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    candidates.push(...commands.map((command) => join(dirname(command), "node_modules", "npm", "bin", "npm-cli.js")));
  } catch {
    // The cmd.exe fallback below will provide the actionable command error.
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const append = (chunk) => {
      output += chunk;
      if (pattern.test(output)) finish(resolve, output);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for npx server:\n${output}`)), timeoutMs);
    const onExit = (code) => finish(reject, new Error(`npx server exited with ${code}:\n${output}`));
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.stdout.off("data", append);
      child.stderr.off("data", append);
      child.off("exit", onExit);
      callback(value);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for clean raycoder shutdown")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
