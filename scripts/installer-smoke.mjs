import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "raycoder-installer-smoke-"));
const packageOutput = join(fixture, "package");
const isolatedHome = join(fixture, "home");
const installRoot = join(isolatedHome, ".raycoder");
const environment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  APPDATA: join(isolatedHome, "AppData", "Roaming"),
  XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
  npm_config_cache: join(fixture, "npm-cache"),
};
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(workspaceRoot, process.argv[2]);

try {
  mkdirSync(packageOutput, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  if (suppliedTarball === undefined) {
    exec("pnpm", ["build"], workspaceRoot, process.env);
    exec("pnpm", ["pack", "--pack-destination", packageOutput], packageRoot, process.env);
  }
  const tarball = suppliedTarball ?? join(packageOutput, `raycoder-${packageManifest.version}.tgz`);
  const bootstrapCli = join(packageRoot, "dist", "cli.js");
  const installOutput = exec(process.execPath, [
    bootstrapCli,
    "install",
    "--root",
    installRoot,
    "--package",
    tarball,
    "--no-path",
  ], fixture, environment);
  if (!installOutput.includes(`Installed raycoder ${packageManifest.version}`)) {
    throw new Error(`Installer did not report success:\n${installOutput}`);
  }

  const launcher = join(installRoot, "bin", "raycoder-launcher.mjs");
  const version = exec(process.execPath, [launcher, "--version"], fixture, environment).trim();
  if (version !== packageManifest.version) throw new Error(`Stable launcher reported ${version}`);
  const pointer = JSON.parse(readFileSync(join(installRoot, "current.json"), "utf8"));
  if (pointer.currentVersion !== packageManifest.version || pointer.previousVersion !== null) {
    throw new Error(`Unexpected current pointer: ${JSON.stringify(pointer)}`);
  }

  const expectedRuntime = join(installRoot, "versions", packageManifest.version, "node_modules", "raycoder", "dist", "cli.js");
  if (!existsSync(expectedRuntime)) throw new Error("Versioned runtime is missing");
  const shortcut = platformShortcut(isolatedHome);
  if (!existsSync(shortcut)) throw new Error(`Platform shortcut is missing: ${shortcut}`);
  writeFileSync(join(installRoot, "config.json"), "preserved-config\n", "utf8");
  writeFileSync(join(installRoot, "projects.db"), "preserved-project-registry\n", "utf8");
  mkdirSync(join(installRoot, "projects"), { recursive: true });
  writeFileSync(join(installRoot, "projects", "metadata.txt"), "preserved-project-metadata\n", "utf8");
  writeFileSync(join(installRoot, "credentials.json"), "credential-sentinel-must-not-change\n", "utf8");

  const uninstallOutput = exec(process.execPath, [launcher, "uninstall", "--root", installRoot, "--yes"], fixture, environment);
  if (!uninstallOutput.includes("Configuration and project data were preserved.")) {
    throw new Error(`Uninstall did not report preservation:\n${uninstallOutput}`);
  }
  for (const owned of ["bin", "versions", "staging", "current.json", "install.json", "install.lock"]) {
    if (existsSync(join(installRoot, owned))) throw new Error(`Uninstall left installer-owned path: ${owned}`);
  }
  if (existsSync(shortcut)) throw new Error(`Uninstall left the platform shortcut: ${shortcut}`);
  const preserved = {
    config: readFileSync(join(installRoot, "config.json"), "utf8"),
    registry: readFileSync(join(installRoot, "projects.db"), "utf8"),
    metadata: readFileSync(join(installRoot, "projects", "metadata.txt"), "utf8"),
    credentials: readFileSync(join(installRoot, "credentials.json"), "utf8"),
  };
  if (
    preserved.config !== "preserved-config\n"
    || preserved.registry !== "preserved-project-registry\n"
    || preserved.metadata !== "preserved-project-metadata\n"
    || preserved.credentials !== "credential-sentinel-must-not-change\n"
  ) throw new Error(`Uninstall changed preserved data: ${JSON.stringify(preserved)}`);
  console.log(`PASS user-local installer ${packageManifest.version}: packaged install, stable launch and preserving uninstall`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function platformShortcut(home) {
  if (process.platform === "win32") {
    return join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "raycoder.lnk");
  }
  if (process.platform === "darwin") return join(home, "Applications", "raycoder.app");
  return join(home, ".local", "share", "applications", "raycoder.desktop");
}

function exec(command, args, cwd, env) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  }
  return execFileSync(command, args, { cwd, env, encoding: "utf8" });
}
