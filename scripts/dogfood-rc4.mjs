import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "apps", "server");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-rc4-dogfood-"));
const projectRoot = join(fixtureRoot, "raycoder-copy");
const installedRoot = join(fixtureRoot, "installed-package");
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(workspaceRoot, process.argv[2]);
let succeeded = false;

try {
  mkdirSync(installedRoot, { recursive: true });
  if (suppliedTarball === undefined) {
    exec("pnpm", ["build"], workspaceRoot);
    exec("pnpm", ["pack", "--pack-destination", installedRoot], packageRoot);
  }
  const tarball = suppliedTarball ?? join(installedRoot, `raycoder-${packageManifest.version}.tgz`);
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({
    private: true,
    dependencies: { raycoder: `file:${tarball}` },
  }), "utf8");
  writeFileSync(join(installedRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  exec("pnpm", ["install"], installedRoot);
  exec("git", ["clone", "--no-local", workspaceRoot, projectRoot], fixtureRoot);
  exec("git", ["switch", "-c", "dogfood-rc4"], projectRoot);

  const core = await import(pathToFileURL(join(installedRoot, "node_modules", "raycoder", "dist", "runtime.js")).href);
  let runtime = await core.ProjectRuntime.open(projectRoot, { adapter: new core.FakeAgentAdapter() });
  const conversation = await runtime.planning.prepareMessage("Plan an offline RC4 dogfood workflow.");
  await runtime.scheduler.schedulePlanning(conversation.id, async () => await runtime.planning.runSession(conversation.id));
  if (runtime.repository.getPlanningSession(conversation.id).status !== "completed") throw new Error("Conversation did not complete");
  runtime.close();

  runtime = await core.ProjectRuntime.open(projectRoot, { adapter: new core.FakeAgentAdapter() });
  if (runtime.planningRecovery.length !== 0) throw new Error("A completed conversation was incorrectly recovered as interrupted");
  if (runtime.repository.planningMessages(conversation.threadId).length !== 2) throw new Error("Conversation did not survive restart");
  const specSession = await runtime.planning.prepareGeneration("spec");
  const generatedSpec = await runtime.scheduler.schedulePlanning(specSession.id, async () => await runtime.planning.runSession(specSession.id));
  if (generatedSpec.artifact?.kind !== "spec") throw new Error("SPEC generation produced no structured artifact");
  const correctedSpec = runtime.planning.editSpec({
    ...generatedSpec.artifact.content,
    summary: "Corrected deterministically after generation.",
    requirements: [...generatedSpec.artifact.content.requirements, "Survive a runtime restart"],
  }, generatedSpec.artifact.predecessorArtifactId, generatedSpec.artifact.id);
  runtime.planning.approve(correctedSpec.id);
  if (runtime.repository.getPlanningArtifact(correctedSpec.id).status !== "approved") throw new Error("Corrected SPEC was not approved");

  const firstTicketSession = await runtime.planning.prepareGeneration("tickets", correctedSpec.id);
  const firstTicketPlan = await runtime.scheduler.schedulePlanning(firstTicketSession.id, async () => await runtime.planning.runSession(firstTicketSession.id));
  const secondTicketSession = await runtime.planning.prepareGeneration("tickets", correctedSpec.id);
  const secondTicketPlan = await runtime.scheduler.schedulePlanning(secondTicketSession.id, async () => await runtime.planning.runSession(secondTicketSession.id));
  if (firstTicketPlan.artifact?.revision !== 1 || secondTicketPlan.artifact?.revision !== 2) {
    throw new Error("Ticket regeneration did not preserve successive revisions");
  }
  if (secondTicketPlan.artifact.replacesArtifactId !== firstTicketPlan.artifact.id) {
    throw new Error("Regenerated ticket plan is not traceable to the prior revision");
  }
  runtime.planning.approve(secondTicketPlan.artifact.id);
  const confirmed = await runtime.scheduler.serialize(async () => runtime.planning.confirmTickets(secondTicketPlan.artifact.id));
  if (confirmed.tickets.map((ticket) => ticket.status).join(",") !== "READY,QUEUED") {
    throw new Error("Confirmed DAG did not preserve dependency readiness");
  }
  if (confirmed.tickets.some((ticket) => runtime.repository.ticketPlanningArtifactId(ticket.id) !== secondTicketPlan.artifact.id)) {
    throw new Error("Confirmed tickets lost their creating plan attribution");
  }
  if (runtime.repository.planningEvents(secondTicketSession.id).length !== 2) throw new Error("Normalized provider events were not persisted");
  if (runtime.repository.getPlanningArtifact(secondTicketPlan.artifact.id).sourceMessageIds.length !== 1) {
    throw new Error("Generated ticket plan lost message attribution");
  }
  runtime.close();

  runtime = await core.ProjectRuntime.open(projectRoot, { adapter: new core.FakeAgentAdapter() });
  if (runtime.repository.latestPlanningDagConfirmation()?.artifactId !== secondTicketPlan.artifact.id) {
    throw new Error("DAG confirmation did not survive the final restart");
  }
  if (runtime.repository.listPlanningArtifacts("spec").length !== 2 || runtime.repository.listPlanningArtifacts("tickets").length !== 2) {
    throw new Error("Planning revision history was not preserved");
  }
  if (runtime.repository.listPlanningSessions().length !== 4) throw new Error("Planning session trace is incomplete");
  runtime.close();
  if (execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" }).trim() !== "") {
    throw new Error("RC4 dogfood changed tracked project files");
  }
  succeeded = true;
  console.log(`PASS RC4 dogfood from installed raycoder ${packageManifest.version}: conversation, restart, SPEC correction, ticket regeneration, approval, DAG confirmation, and traceability.`);
} finally {
  if (succeeded) rmSync(fixtureRoot, { recursive: true, force: true });
  else console.error(`RC4 dogfood fixture preserved for inspection: ${fixtureRoot}`);
}

function exec(command, args, cwd) {
  if (process.platform === "win32" && (command === "pnpm" || command === "npm")) {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true" } });
}
