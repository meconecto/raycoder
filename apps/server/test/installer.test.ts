import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstanceRecord } from "../src/instance-manager.js";
import {
  InstallerBusyError,
  InstallerValidationError,
  NodeInstallerSystem,
  UserLocalInstaller,
  type InstallerSystem,
} from "../src/installer.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeInstallerSystem implements InstallerSystem {
  public resolvedVersion = "1.1.0";
  public active: InstanceRecord | null = null;
  public readonly installedSources: string[] = [];
  public readonly addedPaths: string[] = [];
  public readonly removedPaths: string[] = [];
  public invalidVersion: string | null = null;

  public async installPackage(packageSource: string, destination: string): Promise<void> {
    this.installedSources.push(packageSource);
    const version = packageSource.startsWith("fixture:")
      ? packageSource.slice("fixture:".length)
      : packageSource.replace(/^raycoder@/u, "");
    const reported = this.invalidVersion ?? version;
    const dist = join(destination, "node_modules", "raycoder", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "cli.js"), `if (process.argv.includes("--version")) console.log(${JSON.stringify(reported)});\n`, "utf8");
  }

  public async resolvePublishedVersion(): Promise<string> {
    return this.resolvedVersion;
  }

  public async runCliVersion(cliPath: string): Promise<string> {
    return execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" });
  }

  public async activeInstance(): Promise<InstanceRecord | null> {
    return this.active;
  }

  public async addToUserPath(path: string): Promise<boolean> {
    if (this.addedPaths.includes(path)) return false;
    this.addedPaths.push(path);
    return true;
  }

  public async removeFromUserPath(path: string): Promise<void> {
    this.removedPaths.push(path);
  }

  public async createWindowsShortcut(shortcut: string, target: string): Promise<void> {
    await writeFile(shortcut, `raycoder shortcut to ${target}\n`, "utf8");
  }
}

function fixture(label: string): { home: string; root: string; environment: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), `raycoder-installer-${label}-`));
  temporaryDirectories.push(home);
  return {
    home,
    root: join(home, ".raycoder"),
    environment: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    },
  };
}

function shortcutPath(platform: NodeJS.Platform, home: string): string {
  if (platform === "win32") return join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "raycoder.lnk");
  if (platform === "darwin") return join(home, "Applications", "raycoder.app");
  return join(home, ".local", "share", "applications", "raycoder.desktop");
}

function readCurrent(root: string): { currentVersion: string; previousVersion: string | null } {
  return JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { currentVersion: string; previousVersion: string | null };
}

describe("UserLocalInstaller", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    it(`runs install, launch, update, prune, rollback and uninstall for ${platform}`, async () => {
      const paths = fixture(platform);
      const system = new FakeInstallerSystem();
      const installer = new UserLocalInstaller({ ...paths, platform, system, now: () => "2026-09-03T00:00:00.000Z" });
      await mkdir(paths.root, { recursive: true });
      await writeFile(join(paths.root, "config.json"), "preserve config\n", "utf8");
      await writeFile(join(paths.root, "projects.db"), "preserve projects\n", "utf8");
      await writeFile(join(paths.root, "credentials.json"), "do-not-read-or-copy\n", "utf8");

      const installed = await installer.install({ version: "1.0.0", packageSource: "fixture:1.0.0" });
      expect(installed.current).toMatchObject({ currentVersion: "1.0.0", previousVersion: null });
      expect(installed.manifest).toMatchObject({ channel: "stable", pathManaged: true, shortcutCreated: true });
      expect(system.addedPaths).toEqual([join(paths.root, "bin")]);
      const shortcut = shortcutPath(platform, paths.home);
      const shortcutContents = readFileSync(platform === "darwin" ? join(shortcut, "Contents", "Info.plist") : shortcut, "utf8");
      expect(shortcutContents).toContain("raycoder");
      expect(execFileSync(process.execPath, [join(paths.root, "bin", "raycoder-launcher.mjs"), "--version"], { encoding: "utf8" }).trim())
        .toBe("1.0.0");
      await writeFile(join(paths.root, "bin", "user-note.txt"), "preserve user bin content\n", "utf8");

      system.resolvedVersion = "1.1.0";
      const firstUpdate = await installer.update();
      expect(firstUpdate.current).toMatchObject({ currentVersion: "1.1.0", previousVersion: "1.0.0" });
      system.resolvedVersion = "1.2.0";
      const secondUpdate = await installer.update();
      expect(secondUpdate.prunedVersions).toEqual(["1.0.0"]);
      expect(readdirSync(join(paths.root, "versions")).sort()).toEqual(["1.1.0", "1.2.0"]);

      expect(await installer.rollback()).toMatchObject({ currentVersion: "1.1.0", previousVersion: "1.2.0" });
      expect(execFileSync(process.execPath, [join(paths.root, "bin", "raycoder-launcher.mjs"), "--version"], { encoding: "utf8" }).trim())
        .toBe("1.1.0");

      const inventory = await installer.inventory();
      expect(inventory.ownedPaths).toContain(shortcutPath(platform, paths.home));
      expect([...inventory.preservedPaths].sort()).toEqual([
        join(paths.root, "config.json"),
        join(paths.root, "credentials.json"),
        join(paths.root, "bin", "user-note.txt"),
        join(paths.root, "projects.db"),
      ].sort());
      const removed = await installer.uninstall();
      expect(removed.preservedPaths).toEqual(inventory.preservedPaths);
      expect(system.removedPaths).toContain(join(paths.root, "bin"));
      expect(readFileSync(join(paths.root, "config.json"), "utf8")).toContain("preserve");
      expect(readFileSync(join(paths.root, "projects.db"), "utf8")).toContain("preserve");
      expect(readFileSync(join(paths.root, "credentials.json"), "utf8")).toBe("do-not-read-or-copy\n");
      expect(readFileSync(join(paths.root, "bin", "user-note.txt"), "utf8")).toBe("preserve user bin content\n");
      expect(readdirSync(paths.root).sort()).toEqual(["bin", "config.json", "credentials.json", "projects.db"]);
      expect(() => readFileSync(shortcutPath(platform, paths.home), "utf8")).toThrow();
    });
  }

  it("keeps the current pointer unchanged when staged validation fails", async () => {
    const paths = fixture("failed");
    const system = new FakeInstallerSystem();
    const installer = new UserLocalInstaller({ ...paths, platform: "linux", system });
    await installer.install({ version: "1.0.0", packageSource: "fixture:1.0.0", shortcut: false, path: false });
    system.resolvedVersion = "2.0.0";
    system.invalidVersion = "wrong";
    await expect(installer.update()).rejects.toBeInstanceOf(InstallerValidationError);
    expect(readCurrent(paths.root)).toMatchObject({ currentVersion: "1.0.0", previousVersion: null });
    expect(readdirSync(join(paths.root, "versions"))).toEqual(["1.0.0"]);
    expect(readdirSync(join(paths.root, "staging"))).toEqual([]);
  });

  it("refuses update, rollback and uninstall while a validated instance is active", async () => {
    const paths = fixture("active");
    const system = new FakeInstallerSystem();
    const installer = new UserLocalInstaller({ ...paths, platform: "linux", system });
    await installer.install({ version: "1.0.0", packageSource: "fixture:1.0.0", shortcut: false, path: false });
    system.active = {
      version: 1,
      id: "active",
      nonce: "nonce",
      pid: process.pid,
      port: 4317,
      appVersion: "1.0.0",
      protocolVersion: 1,
      startedAt: new Date(0).toISOString(),
    };
    await expect(installer.update()).rejects.toBeInstanceOf(InstallerBusyError);
    await expect(installer.rollback()).rejects.toBeInstanceOf(InstallerBusyError);
    await expect(installer.uninstall()).rejects.toBeInstanceOf(InstallerBusyError);
    expect(readCurrent(paths.root)).toMatchObject({ currentVersion: "1.0.0", previousVersion: null });
  });

  it("manages a marked POSIX profile block idempotently and preserves user content", async () => {
    const paths = fixture("profile");
    const profile = join(paths.home, ".profile");
    writeFileSync(profile, "export USER_VALUE=kept\n", "utf8");
    const system = new NodeInstallerSystem(paths.root, "linux", paths.environment);
    const bin = join(paths.root, "bin");
    await system.addToUserPath(bin);
    await system.addToUserPath(bin);
    const added = await readFile(profile, "utf8");
    expect(added.match(/raycoder managed PATH/gu)).toHaveLength(2);
    expect(added).toContain("export USER_VALUE=kept");
    await system.removeFromUserPath(bin);
    expect(await readFile(profile, "utf8")).toBe("export USER_VALUE=kept\n");
  });

  it("rejects unsafe versions and has no rollback before an update", async () => {
    const paths = fixture("validation");
    const installer = new UserLocalInstaller({ ...paths, platform: "linux", system: new FakeInstallerSystem() });
    await expect(installer.install({ version: "../escape", packageSource: "fixture:escape" })).rejects.toBeInstanceOf(InstallerValidationError);
    await installer.install({ version: "1.0.0-rc.4", packageSource: "fixture:1.0.0-rc.4", shortcut: false, path: false });
    expect(JSON.parse(readFileSync(join(paths.root, "install.json"), "utf8"))).toMatchObject({ channel: "prerelease" });
    await expect(installer.rollback()).rejects.toBeInstanceOf(InstallerValidationError);
  });

  it("does not claim or remove a pre-existing PATH entry or shortcut", async () => {
    const paths = fixture("ownership");
    const system = new FakeInstallerSystem();
    system.addedPaths.push(join(paths.root, "bin"));
    const shortcut = shortcutPath("linux", paths.home);
    await mkdir(join(shortcut, ".."), { recursive: true });
    await writeFile(shortcut, "user-owned shortcut\n", "utf8");
    const installer = new UserLocalInstaller({ ...paths, platform: "linux", system });

    await expect(installer.install({ version: "1.0.0", packageSource: "fixture:1.0.0" }))
      .rejects.toBeInstanceOf(InstallerValidationError);
    await installer.install({ version: "1.0.0", packageSource: "fixture:1.0.0", shortcut: false });
    expect(JSON.parse(readFileSync(join(paths.root, "install.json"), "utf8"))).toMatchObject({
      pathManaged: false,
      shortcutCreated: false,
    });
    expect((await installer.inventory()).ownedPaths).not.toContain(shortcut);
    await installer.uninstall();
    expect(readFileSync(shortcut, "utf8")).toBe("user-owned shortcut\n");
    expect(system.removedPaths).toEqual([]);
  });

  it("rejects corrupt metadata and dangerously broad roots", async () => {
    const paths = fixture("metadata");
    expect(() => new UserLocalInstaller({ ...paths, root: paths.home, system: new FakeInstallerSystem() }))
      .toThrow(InstallerValidationError);
    await mkdir(paths.root, { recursive: true });
    await writeFile(join(paths.root, "current.json"), "{not-json", "utf8");
    const installer = new UserLocalInstaller({ ...paths, platform: "linux", system: new FakeInstallerSystem() });
    await expect(installer.install({ version: "1.0.0", packageSource: "fixture:1.0.0", shortcut: false, path: false }))
      .rejects.toBeInstanceOf(InstallerValidationError);
  });

  it("does not delete an installer-shaped directory without ownership metadata", async () => {
    const paths = fixture("unowned-layout");
    const unowned = join(paths.root, "versions", "personal", "keep.txt");
    await mkdir(join(paths.root, "versions", "personal"), { recursive: true });
    await writeFile(unowned, "keep\n", "utf8");
    const installer = new UserLocalInstaller({ ...paths, platform: "linux", system: new FakeInstallerSystem() });
    expect((await installer.inventory()).ownedPaths).toEqual([]);
    expect((await installer.uninstall()).removedPaths).toEqual([]);
    expect(readFileSync(unowned, "utf8")).toBe("keep\n");
  });
});
