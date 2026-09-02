import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAgentAdapter,
  Dispatcher,
  GitWorkspaceManager,
  IntegrationService,
  NodeProcessRunner,
  PreflightService,
  TicketRepository,
  ProjectOrchestrator,
  createTicket,
} from "@raycoder/core";

async function main(): Promise<void> {
  const adapter = new CodexAgentAdapter();
  const preflight = await new PreflightService([adapter]).run();
  if (!preflight.canStart) {
    console.log("SKIPPED real Codex smoke test: external runtime or active ChatGPT authentication is unavailable.");
    for (const provider of preflight.providers) {
      for (const diagnostic of provider.diagnostics) console.log(`- ${diagnostic.message}`);
    }
    return;
  }

  const fixture = await mkdtemp(join(tmpdir(), "raycoder-real-codex-smoke-"));
  const runner = new NodeProcessRunner();
  let repository: TicketRepository | undefined;
  let succeeded = false;
  try {
    await runner.run("git", ["init", "-b", "main"], { cwd: fixture });
    await runner.run("git", ["config", "user.name", "raycoder smoke"], { cwd: fixture });
    await runner.run("git", ["config", "user.email", "smoke@raycoder.local"], { cwd: fixture });
    await writeFile(join(fixture, "README.md"), "# disposable raycoder smoke fixture\n", "utf8");
    await runner.run("git", ["add", "README.md"], { cwd: fixture });
    await runner.run("git", ["commit", "-m", "test: smoke fixture"], { cwd: fixture });
    const workspaces = new GitWorkspaceManager(runner);
    await workspaces.prepareProject(fixture);
    await mkdir(join(fixture, ".raycoder"), { recursive: true });
    repository = new TicketRepository(join(fixture, ".raycoder", "raycoder.db"));
    repository.create(createTicket({
      id: "real-codex-smoke",
      title: "Real Codex smoke",
      description: "Create smoke.txt containing exactly `raycoder smoke ok` followed by a newline, then commit it.",
      baseBranch: "main",
      hasPredecessors: false,
    }));
    const dispatcher = new Dispatcher(repository, workspaces, adapter);
    const integration = new IntegrationService(repository, fixture, "auto", { runner });
    const result = await new ProjectOrchestrator(repository, dispatcher, integration).dispatch({
      ticketId: "real-codex-smoke",
      projectRoot: fixture,
      dirtyPolicy: "cancel",
    });
    if (result.ticket.status !== "DONE") throw new Error(`Unexpected final state: ${result.ticket.status}`);
    if (!(await workspaces.hasCommitSince(result.ticket.workspace ?? "", result.ticket.baseCommit ?? ""))) {
      throw new Error("Codex smoke branch did not contain a ticket commit");
    }
    succeeded = true;
    console.log("PASS real Codex smoke: isolated workspace, normalized events, integration, and DONE verified.");
  } finally {
    repository?.close();
    if (succeeded) await rm(fixture, { recursive: true, force: true });
    else console.error(`Smoke fixture preserved for inspection: ${fixture}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
