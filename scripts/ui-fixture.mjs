import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-ui-"));
const projectRoot = join(fixtureRoot, "sample-project");
exec("git", ["init", "-b", "main", projectRoot], fixtureRoot);
exec("git", ["config", "user.name", "raycoder ui"], projectRoot);
exec("git", ["config", "user.email", "ui@raycoder.local"], projectRoot);
writeFileSync(join(projectRoot, "README.md"), "# UI fixture\n");
exec("git", ["add", "README.md"], projectRoot);
exec("git", ["commit", "-m", "test: ui fixture"], projectRoot);

const core = await import(pathToFileURL(join(workspaceRoot, "packages", "core", "dist", "index.js")).href);
const serverModule = await import(pathToFileURL(join(workspaceRoot, "apps", "server", "dist", "server.js")).href);
const configStore = new core.GlobalConfigStore(join(fixtureRoot, "config.json"));
const fakeStage = { provider: "fake", model: "deterministic", effort: null };
await configStore.write({
  ...core.defaultGlobalConfig,
  stages: Object.fromEntries(core.agentStages.map((stage) => [stage, fakeStage])),
});
const projects = new core.ProjectManager(
  new core.ProjectRegistry(join(fixtureRoot, "projects.db")),
  () => ({ adapter: new core.FakeAgentAdapter(), globalConfigStore: configStore }),
);
const runtime = await projects.register(projectRoot, "UI fixture");
runtime.tickets.create({ id: "foundation", title: "Foundation", description: "Build the durable project foundation" });
runtime.tickets.create({ id: "interface", title: "Interface", description: "Expose the workflow in the browser", predecessorIds: ["foundation"] });
const preflight = {
  canStart: true,
  essential: [{ name: "node", ok: true, message: `Node ${process.versions.node} fixture` }],
  providers: [{ provider: "fake", executable: true, diagnostics: [{ level: "ok", code: "fake.ready", message: "Fixture adapter ready" }] }],
  upcoming: [],
};
const server = serverModule.createRaycoderServer({
  repository: runtime.repository,
  orchestrator: runtime.orchestrator,
  preflight,
  projectRoot: runtime.projectRoot,
  baseBranch: runtime.baseBranch,
  projects,
});
server.listen(4399, "127.0.0.1", () => console.log("UI fixture listening at http://127.0.0.1:4399"));
const shutdown = () => server.close(() => {
  projects.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function exec(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "ignore" });
}
