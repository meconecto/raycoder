import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-auto-dogfood-"));
const projectRoot = join(fixtureRoot, "project");
let succeeded = false;

try {
  exec("pnpm", ["build"], workspaceRoot);
  mkdirSync(projectRoot, { recursive: true });
  exec("git", ["init", "-b", "main"], projectRoot);
  exec("git", ["config", "user.name", "raycoder dogfood"], projectRoot);
  exec("git", ["config", "user.email", "dogfood@raycoder.local"], projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "auto dogfood\n", "utf8");
  exec("git", ["add", "README.md"], projectRoot);
  exec("git", ["commit", "-m", "test: auto fixture"], projectRoot);

  const runtimeModule = await import(pathToFileURL(join(workspaceRoot, "apps", "server", "dist", "runtime.js")).href);
  let runtime = await runtimeModule.ProjectRuntime.open(projectRoot, {
    adapter: new runtimeModule.FakeAgentAdapter(),
    workspaceVerification: false,
  });
  runtime.tickets.create({ id: "auto-core", title: "Auto core", description: "First sequential slice" });
  runtime.tickets.create({
    id: "auto-ui",
    title: "Auto UI",
    description: "Second sequential slice",
    predecessorIds: ["auto-core"],
  });
  if (runtime.repository.list().some((ticket) => ticket.status === "RUNNING")) {
    throw new Error("Tickets started before Auto was explicitly enabled");
  }
  const run = runtime.auto.start({ dirtyPolicy: "cancel" });
  await runtime.auto.run(run.id);
  if (runtime.repository.list().some((ticket) => ticket.status !== "DONE")) {
    throw new Error("Auto did not integrate the dependency chain sequentially");
  }
  if (runtime.repository.getAutoRun(run.id).status !== "COMPLETED") {
    throw new Error("Completed Auto run was not persisted");
  }
  const startedTickets = runtime.repository.autoRunEvents(run.id)
    .filter((event) => event.type === "TICKET_STARTED")
    .map((event) => event.ticketId);
  if (JSON.stringify(startedTickets) !== JSON.stringify(["auto-core", "auto-ui"])) {
    throw new Error(`Unexpected Auto order: ${JSON.stringify(startedTickets)}`);
  }

  runtime.tickets.create({ id: "after-restart", title: "After restart", description: "Must wait for Resume" });
  const interrupted = runtime.auto.start({ dirtyPolicy: "cancel" });
  runtime.close();
  runtime = await runtimeModule.ProjectRuntime.open(projectRoot, {
    adapter: new runtimeModule.FakeAgentAdapter(),
    workspaceVerification: false,
  });
  if (runtime.repository.getAutoRun(interrupted.id).status !== "PAUSED"
    || runtime.repository.getAutoRun(interrupted.id).reasonCode !== "restart_required"
    || runtime.repository.get("after-restart").status !== "READY") {
    throw new Error("Auto did not remain paused after runtime reopen");
  }
  runtime.auto.stop(interrupted.id);
  runtime.close();
  succeeded = true;
  console.log("PASS Auto dogfood: explicit start, dependency order, durable journal, completion, and restart pause.");
} finally {
  if (succeeded) rmSync(fixtureRoot, { recursive: true, force: true });
  else console.error(`Auto dogfood fixture preserved for inspection: ${fixtureRoot}`);
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
