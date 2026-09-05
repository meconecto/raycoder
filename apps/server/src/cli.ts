#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CodexAgentAdapter,
  GlobalConfigStore,
  MemoryService,
  PreflightService,
  ProjectInspector,
  ProjectManager,
  ProjectRegistry,
  RAYCODER_VERSION,
  type PreflightReport,
} from "@raycoder/core";
import { RaycoderApplicationHost } from "./application-host.js";
import { executeGlobalCleanup, inspectGlobalCleanup } from "./global-cleanup.js";
import { INSTANCE_PROTOCOL_VERSION, InstanceCoordinator, type InstanceLease, type InstanceRecord } from "./instance-manager.js";
import {
  InstallerBusyError,
  type InstallerChannel,
  InstallerValidationError,
  UserLocalInstaller,
} from "./installer.js";
import { NativeBrowserOpener, type BrowserOpener } from "./platform.js";
import { listenWithFallback, parsePort, selectPort } from "./port-policy.js";
import { createRaycoderServer, type InstanceIdentity } from "./server.js";

interface StartupOptions {
  readonly projectPath?: string;
  readonly port: number;
  readonly explicitPort: boolean;
  readonly openBrowser: boolean;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(helpText());
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(RAYCODER_VERSION);
    return;
  }

  const globalRoot = join(homedir(), ".raycoder");
  if (args[0] === "install" || args[0] === "update" || args[0] === "rollback" || args[0] === "uninstall") {
    try {
      await handleInstallerCommand(args[0], args.slice(1), globalRoot);
    } catch (error) {
      if (!(error instanceof InstallerBusyError) && !(error instanceof InstallerValidationError)) throw error;
      console.error(`raycoder ${args[0]}: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const configStore = new GlobalConfigStore(join(globalRoot, "config.json"));
  if (args[0] === "config") {
    await handleConfigCommand(configStore, args.slice(1));
    return;
  }
  if (args[0] === "cleanup") {
    if (args.length !== 2 || args[1] !== "--global") throw usageError();
    await handleGlobalCleanup(globalRoot);
    return;
  }

  const adapter = new CodexAgentAdapter();
  const preflightService = new PreflightService([adapter]);
  const preflight = await preflightService.run();
  const memory = new MemoryService();
  printPreflight(preflight);
  printMemoryPreflight(await memory.preflight());
  if (args[0] === "doctor") {
    if (args.length > 2) throw usageError();
    if (args[1] !== undefined) await printProjectDiagnostics(resolve(args[1]));
    if (!preflight.canServe || preflight.tools.some((tool) => !tool.ok)) process.exitCode = 1;
    return;
  }
  if (!preflight.canServe) {
    console.error("raycoder server not started: Node 24 or newer is required");
    process.exitCode = 1;
    return;
  }

  const startup = parseStartupOptions(args);
  const coordinator = new InstanceCoordinator(RAYCODER_VERSION, globalRoot);
  const acquisition = await coordinator.acquire();
  const browser = new NativeBrowserOpener();
  if (acquisition.kind === "existing") {
    await reuseExisting(acquisition.record, startup, browser);
    return;
  }

  const lease = acquisition.lease;
  let host: RaycoderApplicationHost | undefined;
  let server: Server | undefined;
  try {
    const registry = new ProjectRegistry(join(globalRoot, "projects.db"));
    const projects = new ProjectManager(registry, () => ({
      adapter: new CodexAgentAdapter(),
      globalConfigStore: configStore,
    }));
    host = new RaycoderApplicationHost({
      projects,
      memory,
      config: configStore,
      preflight,
      runPreflight: async () => await preflightService.run(),
    });

    let initialProjectId: string | undefined;
    let prefilledPath: string | undefined;
    if (startup.projectPath !== undefined) {
      const requested = resolve(startup.projectPath);
      const inspection = await projects.inspect(requested);
      if (inspection.kind === "git_repository" && inspection.repositoryRoot !== null) {
        const runtime = await projects.register(inspection.repositoryRoot);
        initialProjectId = projects.list().find((entry) => entry.project.path === runtime.projectRoot)?.project.id;
      } else {
        prefilledPath = requested;
      }
    }

    const identity: InstanceIdentity = {
      id: lease.id,
      nonce: lease.nonce,
      appVersion: RAYCODER_VERSION,
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
      port: 0,
    };
    let requestShutdown = (): void => undefined;
    server = createRaycoderServer({ app: host, instance: identity, onShutdown: () => requestShutdown() });
    const port = await listenWithFallback(server, startup.port, startup.explicitPort);
    if (!startup.explicitPort && port !== startup.port) console.warn(`Default port ${startup.port} is occupied; using ${port}.`);
    (identity as { port: number }).port = port;
    await lease.publish(port);

    const url = launchUrl(port, initialProjectId, prefilledPath);
    console.log(`raycoder listening at ${url}`);
    if (!preflight.canExecute) console.warn("Agent execution is disabled until an executable provider is available.");
    if (startup.openBrowser) await openBrowser(browser, url);
    requestShutdown = installShutdown(server, host, lease);
  } catch (error) {
    if (server !== undefined) await closeServer(server);
    host?.close();
    await lease.release();
    throw error;
  }
}

async function reuseExisting(record: InstanceRecord, startup: StartupOptions, browser: BrowserOpener): Promise<void> {
  const base = `http://127.0.0.1:${record.port}`;
  if (record.appVersion !== RAYCODER_VERSION || record.protocolVersion !== INSTANCE_PROTOCOL_VERSION) {
    console.error(`raycoder ${record.appVersion} is already running at ${base}. Close it before starting ${RAYCODER_VERSION}.`);
    process.exitCode = 2;
    return;
  }
  let projectId: string | undefined;
  let prefilledPath: string | undefined;
  if (startup.projectPath !== undefined) {
    const requested = resolve(startup.projectPath);
    const inspection = await new ProjectInspector().inspect(requested);
    if (inspection.kind === "git_repository" && inspection.repositoryRoot !== null) {
      const response = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "register", path: inspection.repositoryRoot }),
      });
      const payload = await response.json() as { projects?: { project: { id: string; path: string } }[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Existing raycoder instance returned HTTP ${response.status}`);
      projectId = payload.projects?.find((entry) => entry.project.path === inspection.repositoryRoot)?.project.id;
    } else {
      prefilledPath = requested;
    }
  }
  const url = launchUrl(record.port, projectId, prefilledPath);
  console.log(`Reusing raycoder ${record.appVersion} at ${url}`);
  if (startup.openBrowser) await openBrowser(browser, url);
}

async function handleGlobalCleanup(globalRoot: string): Promise<void> {
  const active = await new InstanceCoordinator(RAYCODER_VERSION, globalRoot).readActive();
  if (active !== null) throw new Error(`Refusing cleanup while raycoder is running at http://127.0.0.1:${active.port}`);
  const inventory = await inspectGlobalCleanup(globalRoot);
  if (inventory.knownFiles.length === 0) {
    console.log("No known global raycoder data exists.");
    return;
  }
  console.log("The following files will be deleted:");
  for (const file of inventory.knownFiles) console.log(`  ${join(inventory.root, file)}`);
  if (inventory.preservedEntries.length > 0) {
    console.log("These unknown entries will be preserved:");
    for (const file of inventory.preservedEntries) console.log(`  ${join(inventory.root, file)}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Global cleanup requires an interactive TTY");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const phrase = await prompt.question("Type DELETE GLOBAL RAYCODER DATA to continue: ");
    if (phrase !== "DELETE GLOBAL RAYCODER DATA") throw new Error("Confirmation phrase did not match; nothing was deleted");
  } finally {
    prompt.close();
  }
  const remaining = await executeGlobalCleanup(inventory);
  console.log(remaining.preservedEntries.length === 0 ? "Global raycoder data deleted." : "Known global raycoder data deleted; unknown entries were preserved.");
}

async function handleInstallerCommand(
  command: "install" | "update" | "rollback" | "uninstall",
  args: readonly string[],
  defaultRoot: string,
): Promise<void> {
  const options = parseInstallerOptions(command, args);
  const installer = new UserLocalInstaller({ root: options.root ?? defaultRoot });
  if (command === "install") {
    const result = await installer.install({
      version: RAYCODER_VERSION,
      ...(options.packageSource === undefined ? {} : { packageSource: options.packageSource }),
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      shortcut: !options.noShortcut,
      path: !options.noPath,
    });
    console.log(`Installed raycoder ${result.installedVersion} in ${join(installer.root, "versions", result.installedVersion)}`);
    console.log(`Stable launcher: ${result.launcherDirectory}`);
    if (result.shortcutPath !== null) console.log(`User shortcut: ${result.shortcutPath}`);
    if (!options.noPath) console.log("Open a new terminal if the raycoder command is not visible in this one.");
    printPruneWarnings(result.pruneWarnings);
    return;
  }
  if (command === "update") {
    const result = await installer.update();
    console.log(result.reusedVersion
      ? `raycoder ${result.installedVersion} is already active.`
      : `Updated raycoder to ${result.installedVersion}.`);
    printPruneWarnings(result.pruneWarnings);
    return;
  }
  if (command === "rollback") {
    const result = await installer.rollback();
    console.log(`Rolled back raycoder to ${result.currentVersion}; ${result.previousVersion} remains available.`);
    return;
  }

  const inventory = await installer.inventory();
  if (inventory.ownedPaths.length === 0 && !inventory.pathEntryManaged) {
    console.log("No user-local raycoder installation was found. Preserved configuration and project data were not changed.");
    return;
  }
  console.log("The following installer-owned resources will be removed:");
  for (const path of inventory.ownedPaths) console.log(`  ${path}`);
  if (inventory.pathEntryManaged) console.log(`  PATH entry for ${join(installer.root, "bin")}`);
  if (inventory.preservedPaths.length > 0) {
    console.log("The following configuration or project data will be preserved:");
    for (const path of inventory.preservedPaths) console.log(`  ${path}`);
  }
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Uninstall requires an interactive TTY or the explicit --yes flag");
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const phrase = await prompt.question("Type UNINSTALL RAYCODER to continue: ");
      if (phrase !== "UNINSTALL RAYCODER") throw new Error("Confirmation phrase did not match; nothing was removed");
    } finally {
      prompt.close();
    }
  }
  const result = await installer.uninstall();
  console.log(`Removed ${result.removedPaths.length} installer-owned resources.`);
  console.log(result.preservedPaths.length === 0
    ? "No configuration or project data was present."
    : "Configuration and project data were preserved.");
}

function parseInstallerOptions(
  command: "install" | "update" | "rollback" | "uninstall",
  args: readonly string[],
): {
  root?: string;
  packageSource?: string;
  channel?: InstallerChannel;
  noShortcut: boolean;
  noPath: boolean;
  yes: boolean;
} {
  let root: string | undefined;
  let packageSource: string | undefined;
  let channel: InstallerChannel | undefined;
  let noShortcut = false;
  let noPath = false;
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-shortcut" && command === "install") {
      noShortcut = true;
      continue;
    }
    if (argument === "--no-path" && command === "install") {
      noPath = true;
      continue;
    }
    if (argument === "--yes" && command === "uninstall") {
      yes = true;
      continue;
    }
    if (argument === "--root") {
      const value = args[index + 1];
      if (value === undefined) throw usageError();
      root = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--package" && command === "install") {
      const value = args[index + 1];
      if (value === undefined) throw usageError();
      packageSource = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--channel" && command === "install") {
      const value = args[index + 1];
      if (value !== "stable" && value !== "prerelease") throw usageError();
      channel = value;
      index += 1;
      continue;
    }
    throw usageError();
  }
  return {
    ...(root === undefined ? {} : { root }),
    ...(packageSource === undefined ? {} : { packageSource }),
    ...(channel === undefined ? {} : { channel }),
    noShortcut,
    noPath,
    yes,
  };
}

function printPruneWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) console.warn(`Could not prune an inactive version: ${warning}`);
}

function parseStartupOptions(args: readonly string[]): StartupOptions {
  let projectPath: string | undefined;
  let cliPort: number | undefined;
  let openBrowser = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument === "--port") {
      const value = args[index + 1];
      if (value === undefined) throw usageError();
      cliPort = parsePort(value, "--port");
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) throw usageError();
    if (projectPath !== undefined || argument === undefined) throw usageError();
    projectPath = argument;
  }
  const selection = selectPort(cliPort === undefined ? undefined : String(cliPort), process.env.RAYCODER_PORT);
  return {
    ...(projectPath === undefined ? {} : { projectPath }),
    port: selection.port,
    explicitPort: selection.explicit,
    openBrowser,
  };
}

function launchUrl(port: number, projectId?: string, prefilledPath?: string): string {
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (prefilledPath !== undefined) url.searchParams.set("path", prefilledPath);
  if (projectId !== undefined) url.hash = `project=${encodeURIComponent(projectId)}`;
  return url.toString();
}

async function openBrowser(browser: BrowserOpener, url: string): Promise<void> {
  try {
    await browser.open(url);
  } catch (error) {
    console.warn(`Could not open the browser: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function installShutdown(server: Server, host: RaycoderApplicationHost, lease: InstanceLease): () => void {
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void closeServer(server).finally(async () => {
      host.close();
      await lease.release();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return shutdown;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function printMemoryPreflight(report: Awaited<ReturnType<MemoryService["preflight"]>>): void {
  for (const diagnostic of report.diagnostics) {
    console.log(`${diagnostic.level === "ok" ? "✓" : diagnostic.level === "warning" ? "○" : "✗"} ${diagnostic.message}`);
  }
}

async function handleConfigCommand(store: GlobalConfigStore, args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "show") {
    console.log(JSON.stringify(await store.read(), null, 2));
    return;
  }
  if (args.length === 3 && args[0] === "set" && args[1] === "integration-mode") {
    const mode = args[2];
    if (mode !== "auto" && mode !== "confirm") throw usageError();
    console.log(JSON.stringify(await store.setIntegrationMode(mode), null, 2));
    return;
  }
  if (args.length === 3 && args[0] === "set" && args[1] === "review-mode") {
    const mode = args[2];
    if (mode !== "self" && mode !== "independent") throw usageError();
    console.log(JSON.stringify(await store.setReviewMode(mode), null, 2));
    return;
  }
  if (args.length === 6 && args[0] === "set" && args[1] === "stage") {
    const stage = args[2];
    if (stage !== "planning" && stage !== "specification" && stage !== "ticketing" && stage !== "implementation" && stage !== "review") throw usageError();
    console.log(JSON.stringify(await store.setStage(stage, {
      provider: args[3] ?? "",
      model: args[4] ?? "",
      effort: args[5] === "none" ? null : args[5] ?? null,
    }), null, 2));
    return;
  }
  throw usageError();
}

function usageError(): Error {
  return new Error(helpText());
}

function helpText(): string {
  return [
    "raycoder — local coding-agent orchestrator",
    "",
    "Usage:",
    "  npx raycoder@latest install [--no-shortcut] [--no-path]",
    "  raycoder update",
    "  raycoder rollback",
    "  raycoder uninstall [--yes]",
    "  npx raycoder [project-directory] [--port <0-65535>] [--no-open]",
    "  npx raycoder doctor [project-directory]",
    "  npx raycoder cleanup --global",
    "  npx raycoder config show",
    "  npx raycoder config set integration-mode auto|confirm",
    "  npx raycoder config set review-mode self|independent",
    "  npx raycoder config set stage <stage> <provider> <model> <effort|none>",
    "  npx raycoder --help | --version",
  ].join("\n");
}

async function printProjectDiagnostics(projectPath: string): Promise<void> {
  const inspection = await new ProjectInspector().inspect(projectPath);
  const icon = inspection.kind === "git_repository" ? "✓" : inspection.kind === "inaccessible" ? "✗" : "○";
  console.log(`${icon} project — ${inspection.kind}: ${inspection.canonicalPath ?? inspection.requestedPath}`);
  if (inspection.branch !== null) console.log(`  branch: ${inspection.branch}`);
  if (inspection.head !== null) console.log(`  head: ${inspection.head}`);
  for (const diagnostic of inspection.diagnostics) console.log(`  ${diagnostic.level}: ${diagnostic.message}`);
  if (inspection.kind === "inaccessible") process.exitCode = 1;
}

function printPreflight(report: PreflightReport): void {
  for (const item of report.essential) console.log(`${item.ok ? "✓" : "✗"} ${item.message}`);
  for (const tool of report.tools) console.log(`${tool.ok ? "✓" : "✗"} ${tool.name} — ${tool.message}`);
  for (const provider of report.providers) {
    for (const diagnostic of provider.diagnostics) {
      console.log(`${diagnostic.level === "ok" ? "✓" : diagnostic.level === "warning" ? "○" : "✗"} ${provider.provider} — ${diagnostic.message}`);
    }
  }
  for (const provider of report.upcoming) console.log(`○ ${provider} — adapter not included in this build`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
