#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  CodexAgentAdapter,
  Dispatcher,
  GitWorkspaceManager,
  NodeProcessRunner,
  PreflightService,
  RecoveryService,
  TicketRepository,
  type PreflightReport,
} from "@raycoder/core";
import { createRaycoderServer } from "./server.js";

async function main(): Promise<void> {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const adapter = new CodexAgentAdapter();
  const preflight = await new PreflightService([adapter]).run();
  printPreflight(preflight);
  if (!preflight.canStart) {
    console.error("raycoder server not started: essential preflight requirements were not met");
    process.exitCode = 1;
    return;
  }

  const runner = new NodeProcessRunner();
  const baseBranch = (await runner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: projectRoot,
    timeoutMs: 10_000,
  })).stdout.trim();
  await mkdir(join(projectRoot, ".raycoder"), { recursive: true });
  const repository = new TicketRepository(join(projectRoot, ".raycoder", "raycoder.db"));
  const recovered = await new RecoveryService(repository).recoverUncontrolledShutdown();
  if (recovered.length > 0) console.warn(`Recovered ${recovered.length} uncertain ticket(s) as INTERRUPTED`);

  const dispatcher = new Dispatcher(repository, new GitWorkspaceManager(), adapter);
  const server = createRaycoderServer({ repository, dispatcher, preflight, projectRoot, baseBranch });
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
