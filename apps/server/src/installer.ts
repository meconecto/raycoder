import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { InstanceCoordinator, type InstanceRecord } from "./instance-manager.js";

const manifestVersion = 1;
const pointerVersion = 1;
const pathBlockStart = "# >>> raycoder managed PATH >>>";
const pathBlockEnd = "# <<< raycoder managed PATH <<<";

export type InstallerChannel = "stable" | "prerelease";

export interface InstallManifest {
  readonly version: 1;
  readonly channel: InstallerChannel;
  readonly platform: NodeJS.Platform;
  readonly pathManaged: boolean;
  readonly shortcutCreated: boolean;
  readonly installedAt: string;
}

export interface CurrentInstallation {
  readonly version: 1;
  readonly currentVersion: string;
  readonly previousVersion: string | null;
  readonly activatedAt: string;
}

export interface InstallResult {
  readonly current: CurrentInstallation;
  readonly manifest: InstallManifest;
  readonly installedVersion: string;
  readonly reusedVersion: boolean;
  readonly prunedVersions: readonly string[];
  readonly pruneWarnings: readonly string[];
  readonly launcherDirectory: string;
  readonly shortcutPath: string | null;
}

export interface InstallerInventory {
  readonly root: string;
  readonly ownedPaths: readonly string[];
  readonly preservedPaths: readonly string[];
  readonly pathEntryManaged: boolean;
}

export interface UninstallResult {
  readonly removedPaths: readonly string[];
  readonly preservedPaths: readonly string[];
}

export interface InstallerSystem {
  installPackage(packageSource: string, destination: string): Promise<void>;
  resolvePublishedVersion(channel: InstallerChannel): Promise<string>;
  runCliVersion(cliPath: string): Promise<string>;
  activeInstance(): Promise<InstanceRecord | null>;
  addToUserPath(binDirectory: string): Promise<boolean>;
  removeFromUserPath(binDirectory: string): Promise<void>;
  createWindowsShortcut(shortcutPath: string, targetPath: string, workingDirectory: string): Promise<void>;
}

export interface UserLocalInstallerOptions {
  readonly root?: string;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly system?: InstallerSystem;
  readonly now?: () => string;
}

export class InstallerBusyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InstallerBusyError";
  }
}

export class InstallerValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InstallerValidationError";
  }
}

export class UserLocalInstaller {
  public readonly root: string;
  readonly #platform: NodeJS.Platform;
  readonly #home: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #system: InstallerSystem;
  readonly #now: () => string;

  public constructor(options: UserLocalInstallerOptions = {}) {
    this.#home = resolve(options.home ?? homedir());
    this.root = resolve(options.root ?? join(this.#home, ".raycoder"));
    if (this.root === parse(this.root).root || this.root === this.#home) {
      throw new InstallerValidationError("The raycoder installation root must be a dedicated directory, not the user home or filesystem root");
    }
    this.#platform = options.platform ?? process.platform;
    if (!(["win32", "darwin", "linux"] as NodeJS.Platform[]).includes(this.#platform)) {
      throw new InstallerValidationError(`User-local installation is not supported on ${this.#platform}`);
    }
    this.#environment = options.environment ?? process.env;
    this.#system = options.system ?? new NodeInstallerSystem(this.root, this.#platform, this.#environment);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async install(input: {
    version: string;
    packageSource?: string;
    channel?: InstallerChannel;
    shortcut?: boolean;
    path?: boolean;
  }): Promise<InstallResult> {
    validateVersion(input.version);
    return await this.#withLock(async () => await this.#installUnlocked({
      version: input.version,
      packageSource: input.packageSource ?? `raycoder@${input.version}`,
      channel: input.channel ?? inferChannel(input.version),
      shortcut: input.shortcut ?? true,
      path: input.path ?? true,
    }));
  }

  public async update(): Promise<InstallResult> {
    return await this.#withLock(async () => {
      const current = await this.#requireCurrent();
      await this.#assertInactive("update", current.currentVersion);
      const manifest = await this.#requireManifest();
      const version = await this.#system.resolvePublishedVersion(manifest.channel);
      validateVersion(version);
      return await this.#installUnlocked({
        version,
        packageSource: `raycoder@${version}`,
        channel: manifest.channel,
        shortcut: manifest.shortcutCreated,
        path: manifest.pathManaged,
      }, true);
    });
  }

  public async rollback(): Promise<CurrentInstallation> {
    return await this.#withLock(async () => {
      const current = await this.#requireCurrent();
      await this.#assertInactive("rollback", current.currentVersion);
      if (current.previousVersion === null) throw new InstallerValidationError("No previous raycoder version is available for rollback");
      await this.#validateInstalledVersion(current.previousVersion);
      const next: CurrentInstallation = {
        version: pointerVersion,
        currentVersion: current.previousVersion,
        previousVersion: current.currentVersion,
        activatedAt: this.#now(),
      };
      await atomicWriteJson(join(this.root, "current.json"), next);
      return next;
    });
  }

  public async inventory(): Promise<InstallerInventory> {
    const manifest = await this.#readManifest();
    const candidates = manifest === null ? [] : [
      ...this.#launcherPaths(),
      join(this.root, "versions"),
      join(this.root, "staging"),
      join(this.root, "current.json"),
      join(this.root, "install.json"),
      ...(manifest?.shortcutCreated === true ? [this.#shortcutPath()] : []),
    ];
    const ownedPaths: string[] = [];
    for (const path of candidates) if (await exists(path)) ownedPaths.push(path);
    const ownedRootNames = manifest === null
      ? new Set(["install.lock"])
      : new Set(["bin", "versions", "staging", "current.json", "install.json", "install.lock"]);
    const preservedPaths = (await listEntries(this.root))
      .filter((name) => !ownedRootNames.has(name))
      .map((name) => join(this.root, name));
    if (manifest !== null) {
      const knownLaunchers = new Set(this.#launcherPaths().map((path) => path.slice(join(this.root, "bin").length + 1)));
      preservedPaths.push(...(await listEntries(join(this.root, "bin")))
        .filter((name) => !knownLaunchers.has(name))
        .map((name) => join(this.root, "bin", name)));
    }
    return {
      root: this.root,
      ownedPaths,
      preservedPaths,
      pathEntryManaged: manifest?.pathManaged ?? false,
    };
  }

  public async uninstall(): Promise<UninstallResult> {
    return await this.#withLock(async () => {
      const pointer = await this.#readCurrent();
      await this.#assertInactive("uninstall", pointer?.currentVersion ?? "unknown");
      const manifest = await this.#readManifest();
      const inventory = await this.inventory();
      if (manifest === null) return { removedPaths: [], preservedPaths: inventory.preservedPaths };
      if (manifest?.pathManaged === true) await this.#system.removeFromUserPath(join(this.root, "bin"));
      if (manifest?.shortcutCreated === true) await this.#removeShortcut();
      const windowsCommandLauncher = join(this.root, "bin", "raycoder.cmd");
      const commandLauncherWillFinishRemoval = this.#platform === "win32"
        && sameWindowsPath(this.#environment.RAYCODER_WINDOWS_CMD_LAUNCHER, windowsCommandLauncher);
      const ownedInsideRoot = [
        ...this.#launcherPaths().filter((path) => !commandLauncherWillFinishRemoval || path !== windowsCommandLauncher),
        join(this.root, "versions"),
        join(this.root, "staging"),
        join(this.root, "current.json"),
        join(this.root, "install.json"),
      ];
      const removedPaths: string[] = [];
      for (const path of ownedInsideRoot) {
        if (!await exists(path)) continue;
        await rm(path, { recursive: true, force: true });
        removedPaths.push(path);
      }
      if (commandLauncherWillFinishRemoval) {
        if (await exists(windowsCommandLauncher)) removedPaths.push(windowsCommandLauncher);
      } else {
        try {
          await rmdir(join(this.root, "bin"));
        } catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      const shortcut = this.#shortcutPath();
      if (inventory.ownedPaths.includes(shortcut)) removedPaths.push(shortcut);
      return { removedPaths, preservedPaths: inventory.preservedPaths };
    });
  }

  async #installUnlocked(
    input: {
      version: string;
      packageSource: string;
      channel: InstallerChannel;
      shortcut: boolean;
      path: boolean;
    },
    inactiveAlreadyChecked = false,
  ): Promise<InstallResult> {
    validatePackageSource(input.packageSource);
    const existing = await this.#readCurrent();
    const previousManifest = await this.#readManifest();
    if (existing !== null && previousManifest === null) {
      throw new InstallerValidationError("raycoder current.json exists but installation ownership metadata is missing");
    }
    if (existing === null && previousManifest === null) await this.#assertUnownedLayoutIsEmpty();
    if (!inactiveAlreadyChecked) await this.#assertInactive("install or update", existing?.currentVersion ?? input.version);
    if (input.shortcut && await exists(this.#shortcutPath()) && previousManifest?.shortcutCreated !== true) {
      throw new InstallerValidationError(`Refusing to overwrite an unowned shortcut at ${this.#shortcutPath()}`);
    }
    const versionsRoot = join(this.root, "versions");
    const stagingRoot = join(this.root, "staging");
    const destination = join(versionsRoot, input.version);
    await mkdir(versionsRoot, { recursive: true });
    await mkdir(stagingRoot, { recursive: true });

    let reusedVersion = false;
    if (await exists(destination)) {
      try {
        await this.#validateInstalledVersion(input.version);
        reusedVersion = true;
      } catch {
        if (existing?.currentVersion === input.version) {
          throw new InstallerValidationError(`Installed current version ${input.version} is invalid; it was not overwritten`);
        }
        await rm(destination, { recursive: true, force: true });
      }
    }

    if (!reusedVersion) {
      const staging = join(stagingRoot, `install-${randomUUID()}`);
      await mkdir(staging, { recursive: false });
      try {
        await writeFile(join(staging, "package.json"), `${JSON.stringify({ private: true })}\n`, { encoding: "utf8", mode: 0o600 });
        await this.#system.installPackage(input.packageSource, staging);
        await this.#validateCli(join(staging, "node_modules", "raycoder", "dist", "cli.js"), input.version);
        await rename(staging, destination);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }

    await this.#writeLaunchers();
    let pathManaged = previousManifest?.pathManaged ?? false;
    if (input.path) pathManaged = (await this.#system.addToUserPath(join(this.root, "bin"))) || pathManaged;
    else if (pathManaged) {
      await this.#system.removeFromUserPath(join(this.root, "bin"));
      pathManaged = false;
    }
    let shortcutCreated = previousManifest?.shortcutCreated ?? false;
    if (input.shortcut) {
      await this.#writeShortcut();
      shortcutCreated = true;
    } else if (shortcutCreated) {
      await this.#removeShortcut();
      shortcutCreated = false;
    }

    const manifest: InstallManifest = {
      version: manifestVersion,
      channel: input.channel,
      platform: this.#platform,
      pathManaged,
      shortcutCreated,
      installedAt: this.#now(),
    };
    await atomicWriteJson(join(this.root, "install.json"), manifest);
    const current: CurrentInstallation = {
      version: pointerVersion,
      currentVersion: input.version,
      previousVersion: existing === null
        ? null
        : existing.currentVersion === input.version ? existing.previousVersion : existing.currentVersion,
      activatedAt: this.#now(),
    };
    await atomicWriteJson(join(this.root, "current.json"), current);
    const prune = await this.#pruneVersions(new Set([
      current.currentVersion,
      ...(current.previousVersion === null ? [] : [current.previousVersion]),
    ]));
    return {
      current,
      manifest,
      installedVersion: input.version,
      reusedVersion,
      prunedVersions: prune.removed,
      pruneWarnings: prune.warnings,
      launcherDirectory: join(this.root, "bin"),
      shortcutPath: shortcutCreated ? this.#shortcutPath() : null,
    };
  }

  async #validateInstalledVersion(version: string): Promise<void> {
    validateVersion(version);
    await this.#validateCli(join(this.root, "versions", version, "node_modules", "raycoder", "dist", "cli.js"), version);
  }

  async #validateCli(cliPath: string, expectedVersion: string): Promise<void> {
    if (!await exists(cliPath)) throw new InstallerValidationError(`Installed package has no CLI at ${cliPath}`);
    const observed = (await this.#system.runCliVersion(cliPath)).trim();
    if (observed !== expectedVersion) {
      throw new InstallerValidationError(`Installed package reported ${observed || "no version"}; expected ${expectedVersion}`);
    }
  }

  async #writeLaunchers(): Promise<void> {
    const bin = join(this.root, "bin");
    await mkdir(bin, { recursive: true });
    const launcher = join(bin, "raycoder-launcher.mjs");
    const launcherSource = `import { readFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nimport { dirname, join, resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst root = resolve(dirname(fileURLToPath(import.meta.url)), "..");\nconst pointer = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));\nif (typeof pointer.currentVersion !== "string" || !/^[0-9A-Za-z.+-]+$/.test(pointer.currentVersion)) throw new Error("Invalid raycoder current pointer");\nconst cli = join(root, "versions", pointer.currentVersion, "node_modules", "raycoder", "dist", "cli.js");\nconst child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });\nif (child.error) throw child.error;\nprocess.exitCode = child.status ?? 1;\n`;
    await writeFile(launcher, launcherSource, { encoding: "utf8", mode: 0o755 });
    const shellLauncher = join(bin, "raycoder");
    await writeFile(shellLauncher, `#!/bin/sh\nexec node "$(dirname "$0")/raycoder-launcher.mjs" "$@"\n`, { encoding: "utf8", mode: 0o755 });
    await chmod(shellLauncher, 0o755);
    if (this.#platform === "win32") {
      const commandLauncher = "@echo off\r\nsetlocal\r\nset \"RAYCODER_WINDOWS_CMD_LAUNCHER=%~f0\"\r\nnode \"%~dp0raycoder-launcher.mjs\" %*\r\nset \"RAYCODER_EXIT_CODE=%ERRORLEVEL%\"\r\nif /I \"%~1\"==\"uninstall\" if \"%RAYCODER_EXIT_CODE%\"==\"0\" goto raycoder_self_delete\r\nexit /b %RAYCODER_EXIT_CODE%\r\n:raycoder_self_delete\r\n(goto) 2>nul & del /f /q \"%~f0\" >nul 2>&1 & rd \"%~dp0\" >nul 2>&1\r\n";
      await writeFile(join(bin, "raycoder.cmd"), commandLauncher, "utf8");
    }
  }

  #launcherPaths(): string[] {
    const bin = join(this.root, "bin");
    return [
      join(bin, "raycoder-launcher.mjs"),
      join(bin, "raycoder"),
      ...(this.#platform === "win32" ? [join(bin, "raycoder.cmd")] : []),
    ];
  }

  #shortcutPath(): string {
    if (this.#platform === "win32") {
      const appData = this.#environment.APPDATA ?? join(this.#home, "AppData", "Roaming");
      return resolve(appData, "Microsoft", "Windows", "Start Menu", "Programs", "raycoder.lnk");
    }
    if (this.#platform === "darwin") return join(this.#home, "Applications", "raycoder.app");
    const dataHome = this.#environment.XDG_DATA_HOME ?? join(this.#home, ".local", "share");
    return resolve(dataHome, "applications", "raycoder.desktop");
  }

  async #writeShortcut(): Promise<void> {
    const shortcut = this.#shortcutPath();
    const stableLauncher = join(this.root, "bin", this.#platform === "win32" ? "raycoder.cmd" : "raycoder");
    if (this.#platform === "win32") {
      await mkdir(dirname(shortcut), { recursive: true });
      await this.#system.createWindowsShortcut(shortcut, stableLauncher, this.#home);
      return;
    }
    if (this.#platform === "darwin") {
      const executable = join(shortcut, "Contents", "MacOS", "raycoder");
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(stableLauncher)}\n`, { encoding: "utf8", mode: 0o755 });
      await chmod(executable, 0o755);
      await writeFile(join(shortcut, "Contents", "Info.plist"), macInfoPlist(), "utf8");
      return;
    }
    await mkdir(dirname(shortcut), { recursive: true });
    await writeFile(shortcut, `[Desktop Entry]\nType=Application\nName=raycoder\nComment=Local coding-agent orchestrator\nExec=${desktopQuote(stableLauncher)}\nTerminal=true\nCategories=Development;\n`, "utf8");
  }

  async #removeShortcut(): Promise<void> {
    await rm(this.#shortcutPath(), { recursive: true, force: true });
  }

  async #assertUnownedLayoutIsEmpty(): Promise<void> {
    for (const directory of [join(this.root, "bin"), join(this.root, "versions"), join(this.root, "staging")]) {
      if ((await listEntries(directory)).length > 0) {
        throw new InstallerValidationError(`Refusing to claim an existing unowned installer directory at ${directory}`);
      }
    }
  }

  async #pruneVersions(retain: ReadonlySet<string>): Promise<{ removed: string[]; warnings: string[] }> {
    const versionsRoot = join(this.root, "versions");
    const removed: string[] = [];
    const warnings: string[] = [];
    for (const entry of await listEntries(versionsRoot)) {
      if (retain.has(entry)) continue;
      const path = join(versionsRoot, entry);
      try {
        const details = await stat(path);
        if (!details.isDirectory()) continue;
        await rm(path, { recursive: true, force: true });
        removed.push(entry);
      } catch (error) {
        warnings.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { removed, warnings };
  }

  async #assertInactive(operation: string, installedVersion: string): Promise<void> {
    const active = await this.#system.activeInstance();
    if (active !== null) {
      throw new InstallerBusyError(
        `Refusing to ${operation} while raycoder ${active.appVersion || installedVersion} is running at http://127.0.0.1:${active.port}`,
      );
    }
  }

  async #readCurrent(): Promise<CurrentInstallation | null> {
    let value: Record<string, unknown> | null;
    try {
      value = await readJson(join(this.root, "current.json"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new InstallerValidationError("Invalid raycoder current.json");
      throw error;
    }
    if (value === null) return null;
    if (
      value.version !== pointerVersion
      || typeof value.currentVersion !== "string"
      || (value.previousVersion !== null && typeof value.previousVersion !== "string")
      || typeof value.activatedAt !== "string"
    ) throw new InstallerValidationError("Invalid raycoder current.json");
    validateVersion(value.currentVersion);
    if (value.previousVersion !== null) validateVersion(value.previousVersion);
    return value as unknown as CurrentInstallation;
  }

  async #requireCurrent(): Promise<CurrentInstallation> {
    const current = await this.#readCurrent();
    if (current === null) throw new InstallerValidationError("raycoder is not installed in this user account");
    return current;
  }

  async #readManifest(): Promise<InstallManifest | null> {
    let value: Record<string, unknown> | null;
    try {
      value = await readJson(join(this.root, "install.json"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new InstallerValidationError("Invalid raycoder install.json");
      throw error;
    }
    if (value === null) return null;
    if (
      value.version !== manifestVersion
      || (value.channel !== "stable" && value.channel !== "prerelease")
      || value.platform !== this.#platform
      || typeof value.pathManaged !== "boolean"
      || typeof value.shortcutCreated !== "boolean"
      || typeof value.installedAt !== "string"
    ) throw new InstallerValidationError("Invalid raycoder install.json");
    return value as unknown as InstallManifest;
  }

  async #requireManifest(): Promise<InstallManifest> {
    const manifest = await this.#readManifest();
    if (manifest === null) throw new InstallerValidationError("raycoder installation metadata is missing");
    return manifest;
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, "install.lock");
    const token = randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: this.#now() })}\n`, "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lock = await readLock(path);
        if (lock !== null && typeof lock.pid === "number" && processAlive(lock.pid)) {
          throw new InstallerBusyError("Another raycoder installation operation is active");
        }
        await rm(path, { force: true });
      }
    }
    if (handle === null) throw new InstallerBusyError("Could not acquire the raycoder installation lock");
    try {
      return await operation();
    } finally {
      await handle.close();
      const lock = await readLock(path);
      if (lock?.token === token) await rm(path, { force: true });
    }
  }
}

export class NodeInstallerSystem implements InstallerSystem {
  readonly #root: string;
  readonly #platform: NodeJS.Platform;
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(root: string, platform = process.platform, environment = process.env) {
    this.#root = root;
    this.#platform = platform;
    this.#environment = environment;
  }

  public async installPackage(packageSource: string, destination: string): Promise<void> {
    await this.#runNpm([
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      packageSource,
    ], destination);
  }

  public async resolvePublishedVersion(channel: InstallerChannel): Promise<string> {
    const output = await this.#runNpm(["view", `raycoder@${channel === "stable" ? "latest" : "next"}`, "version", "--json"], this.#root);
    const value: unknown = JSON.parse(output);
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value.at(-1) === "string") return value.at(-1) as string;
    throw new InstallerValidationError("npm did not return a raycoder version");
  }

  public async runCliVersion(cliPath: string): Promise<string> {
    return await run(process.execPath, [cliPath, "--version"], dirname(cliPath), this.#environment);
  }

  public async activeInstance(): Promise<InstanceRecord | null> {
    return await new InstanceCoordinator("installer", this.#root).readActive();
  }

  public async addToUserPath(binDirectory: string): Promise<boolean> {
    if (this.#platform === "win32") {
      return (await runPowerShell(pathScript("add", binDirectory), this.#environment)).trim() === "added";
    }
    const profile = this.#profilePath();
    const existing = await readText(profile);
    const withoutBlock = removeManagedPathBlock(existing);
    const block = `${pathBlockStart}\nexport PATH=${shellQuote(binDirectory)}:"$PATH"\n${pathBlockEnd}`;
    const separator = withoutBlock.length === 0 || withoutBlock.endsWith("\n") ? "" : "\n";
    await atomicWriteText(profile, `${withoutBlock}${separator}${block}\n`);
    return true;
  }

  public async removeFromUserPath(binDirectory: string): Promise<void> {
    if (this.#platform === "win32") {
      await runPowerShell(pathScript("remove", binDirectory), this.#environment);
      return;
    }
    const profile = this.#profilePath();
    if (!await exists(profile)) return;
    const existing = await readText(profile);
    const updated = removeManagedPathBlock(existing);
    if (updated !== existing) await atomicWriteText(profile, updated);
  }

  public async createWindowsShortcut(shortcutPath: string, targetPath: string, workingDirectory: string): Promise<void> {
    const shortcut = Buffer.from(shortcutPath, "utf8").toString("base64");
    const target = Buffer.from(targetPath, "utf8").toString("base64");
    const working = Buffer.from(workingDirectory, "utf8").toString("base64");
    const script = `$decode={param($value)[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))};$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut((&$decode '${shortcut}'));$link.TargetPath=(&$decode '${target}');$link.WorkingDirectory=(&$decode '${working}');$link.Description='raycoder local coding-agent orchestrator';$link.Save()`;
    await runPowerShell(script, this.#environment);
  }

  async #runNpm(args: readonly string[], cwd: string): Promise<string> {
    if (this.#platform !== "win32") return await run("npm", args, cwd, this.#environment);
    for (const argument of args) {
      if (/[&|<>^%\r\n]/u.test(argument)) throw new InstallerValidationError("Unsafe character in npm argument");
    }
    return await run(this.#environment.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], cwd, this.#environment);
  }

  #profilePath(): string {
    return join(resolve(this.#environment.HOME ?? homedir()), this.#platform === "darwin" ? ".zprofile" : ".profile");
  }
}

function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new InstallerValidationError(`Invalid raycoder version: ${version}`);
  }
}

function validatePackageSource(source: string): void {
  if (source.trim().length === 0 || source.trimStart().startsWith("-") || /[\r\n\0]/u.test(source)) {
    throw new InstallerValidationError("Invalid package source");
  }
}

function inferChannel(version: string): InstallerChannel {
  return version.includes("-") ? "prerelease" : "stable";
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLock(path: string): Promise<Record<string, unknown> | null> {
  try {
    return await readJson(path);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function listEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function run(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function removeManagedPathBlock(contents: string): string {
  const pattern = new RegExp(`${escapeRegExp(pathBlockStart)}[\\s\\S]*?${escapeRegExp(pathBlockEnd)}\\r?\\n?`, "gu");
  return contents.replace(pattern, "").replace(/\n{3,}/gu, "\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function desktopQuote(value: string): string {
  return `"${value.replace(/["`$\\]/gu, "\\$&")}"`;
}

function sameWindowsPath(left: string | undefined, right: string): boolean {
  return left !== undefined && resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function pathScript(operation: "add" | "remove", binDirectory: string): string {
  const encodedEntry = Buffer.from(binDirectory, "utf8").toString("base64");
  const prefix = `$entry=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedEntry}'));$current=[Environment]::GetEnvironmentVariable('Path','User');$parts=@($current -split ';' | Where-Object { $_ })`;
  if (operation === "add") {
    return `${prefix};$already=$parts -contains $entry;if($already){Write-Output 'existing'}else{$parts += $entry;[Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User');Write-Output 'added'}`;
  }
  return `${prefix};$parts=@($parts | Where-Object { $_ -ne $entry });[Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User')`;
}

async function runPowerShell(script: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], process.cwd(), environment);
}

function macInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>raycoder</string><key>CFBundleIdentifier</key><string>dev.raycoder.local</string><key>CFBundleName</key><string>raycoder</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`;
}
