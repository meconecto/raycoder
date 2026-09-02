#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  CodexAgentAdapter,
  GlobalConfigStore,
  MemoryService,
  NodeProcessRunner,
  PreflightService,
  ProjectManager,
  ProjectRegistry,
  RAYCODER_VERSION,
  type PreflightReport,
} from "@raycoder/core";
import { createRaycoderServer } from "./server.js";

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
  const configStore = new GlobalConfigStore();
  if (args[0] === "config") {
    await handleConfigCommand(configStore, args.slice(1));
    return;
  }
  const adapter = new CodexAgentAdapter();
  const preflight = await new PreflightService([adapter]).run();
  printPreflight(preflight);
  const memory = new MemoryService();
  printMemoryPreflight(await memory.preflight());
  if (args[0] === "doctor") {
    await printProjectDiagnostics(resolve(args[1] ?? process.cwd()));
    if (!preflight.canStart) process.exitCode = 1;
    return;
  }
  if (!preflight.canStart) {
    console.error("raycoder server not started: essential preflight requirements were not met");
    process.exitCode = 1;
    return;
  }

  const requestedProjectPath = resolve(args[0] ?? process.cwd());
  const registry = new ProjectRegistry(join(homedir(), ".raycoder", "projects.db"));
  const projects = new ProjectManager(registry, () => ({
    adapter: new CodexAgentAdapter(),
    globalConfigStore: configStore,
  }));
  const runtime = await projects.register(requestedProjectPath);
  if (runtime.recovery.length > 0) console.warn(`Recovered ${runtime.recovery.length} uncertain ticket(s) as INTERRUPTED`);

  const server = createRaycoderServer({
    repository: runtime.repository,
    orchestrator: runtime.orchestrator,
    preflight,
    projectRoot: runtime.projectRoot,
    baseBranch: runtime.baseBranch,
    projects,
    memory,
  });
  const port = Number.parseInt(process.env.RAYCODER_PORT ?? "4317", 10);
  server.listen(port, "127.0.0.1", () => {
    console.log(`raycoder listening at http://127.0.0.1:${port}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      projects.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
    if (stage !== "planning" && stage !== "specification" && stage !== "ticketing" && stage !== "implementation" && stage !== "review") {
      throw usageError();
    }
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
    "  npx raycoder [project-directory]",
    "  npx raycoder doctor [project-directory]",
    "  npx raycoder config show",
    "  npx raycoder config set integration-mode auto|confirm",
    "  npx raycoder config set review-mode self|independent",
    "  npx raycoder config set stage <stage> <provider> <model> <effort|none>",
    "  npx raycoder --help | --version",
  ].join("\n");
}

async function printProjectDiagnostics(projectPath: string): Promise<void> {
  const runner = new NodeProcessRunner();
  try {
    const root = (await runner.run("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectPath,
      timeoutMs: 10_000,
    })).stdout.trim();
    const branch = (await runner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: root,
      timeoutMs: 10_000,
    })).stdout.trim();
    console.log(`✓ project — Git repository ${root} on ${branch}`);
  } catch (error) {
    console.error(`✗ project — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
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
