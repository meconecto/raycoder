#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  CodexAgentAdapter,
  Dispatcher,
  GitIntegrationRecoveryEvidence,
  GitWorkspaceManager,
  GlobalConfigStore,
  IntegrationService,
  NodeProcessRunner,
  PreflightService,
  ProjectOrchestrator,
  RecoveryService,
  TicketRepository,
  type PreflightReport,
} from "@raycoder/core";
import { createRaycoderServer } from "./server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configStore = new GlobalConfigStore();
  if (args[0] === "config") {
    await handleConfigCommand(configStore, args.slice(1));
    return;
  }
  const requestedProjectPath = resolve(args[0] ?? process.cwd());
  const config = await configStore.read();
  const adapter = new CodexAgentAdapter();
  const preflight = await new PreflightService([adapter]).run();
  printPreflight(preflight);
  if (!preflight.canStart) {
    console.error("raycoder server not started: essential preflight requirements were not met");
    process.exitCode = 1;
    return;
  }

  const runner = new NodeProcessRunner();
  const workspaces = new GitWorkspaceManager(runner);
  const projectRoot = await workspaces.prepareProject(requestedProjectPath);
  const baseBranch = (await runner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: projectRoot,
    timeoutMs: 10_000,
  })).stdout.trim();
  await mkdir(join(projectRoot, ".raycoder"), { recursive: true });
  const repository = new TicketRepository(join(projectRoot, ".raycoder", "raycoder.db"));
  const recovered = await new RecoveryService(
    repository,
    undefined,
    new GitIntegrationRecoveryEvidence(projectRoot, runner),
  ).recoverUncontrolledShutdown();
  if (recovered.length > 0) console.warn(`Recovered ${recovered.length} uncertain ticket(s) as INTERRUPTED`);

  const dispatcher = new Dispatcher(repository, workspaces, adapter);
  const integration = new IntegrationService(repository, projectRoot, config.integrationMode, { runner });
  const orchestrator = new ProjectOrchestrator(repository, dispatcher, integration);
  const server = createRaycoderServer({ repository, orchestrator, preflight, projectRoot, baseBranch });
  const port = Number.parseInt(process.env.RAYCODER_PORT ?? "4317", 10);
  server.listen(port, "127.0.0.1", () => {
    console.log(`raycoder listening at http://127.0.0.1:${port}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      repository.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
  throw usageError();
}

function usageError(): Error {
  return new Error([
    "Usage:",
    "  raycoder [project-directory]",
    "  raycoder config show",
    "  raycoder config set integration-mode auto|confirm",
  ].join("\n"));
}

function printPreflight(report: PreflightReport): void {
  for (const item of report.essential) console.log(`${item.ok ? "✓" : "✗"} ${item.message}`);
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
