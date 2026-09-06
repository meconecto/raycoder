import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentAdapter, GlobalConfigStore, MemoryService, NodeProcessRunner, ProjectManager, ProjectRegistry } from "../apps/server/dist/runtime.js";
import { createRaycoderServer } from "../apps/server/dist/server.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-e2e-host-"));
const globalConfig = new GlobalConfigStore(join(fixtureRoot, "config.json"));
await globalConfig.write({
  version: 3,
  integrationMode: "auto",
  reviewMode: "independent",
  stages: Object.fromEntries(["planning", "specification", "ticketing", "implementation", "review"].map((stage) => [
    stage,
    { provider: "fake", model: "deterministic", effort: null },
  ])),
  ui: { locale: "auto", theme: "system" },
});
const nativeRunner = new NodeProcessRunner();
class E2EAgentAdapter extends FakeAgentAdapter {
  quotaFailed = false;

  async *send(session, prompt) {
    if (prompt.includes("[quota-once]") && !this.quotaFailed) {
      this.quotaFailed = true;
      yield {
        type: "error",
        timestamp: new Date().toISOString(),
        code: "quota_exhausted",
        message: "You've hit your usage limit; try again after the reset.",
      };
      return;
    }
    if (prompt.includes("[commands]")) {
      for (const command of ["git status --short", "pnpm typecheck", "pnpm test"]) {
        yield { type: "command", timestamp: new Date().toISOString(), command, cwd: fixtureRoot, exitCode: 0, output: `${command}: ok` };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_250));
    }
    yield* super.send(session, prompt);
  }
}
const e2eAdapter = new E2EAgentAdapter();
const failedPreparationRoots = new Set();
const preparationRunner = {
  async run(command, args, options) {
    if (command === "git") return await nativeRunner.run(command, args, options);
    if (args.includes("--version") || (command === "go" && args[0] === "version")) {
      return { command, args, cwd: options.cwd, exitCode: 0, stdout: `${command} 1.0.0\n`, stderr: "" };
    }
    if (command === "pnpm" && JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8")).raycoderPreparationFailOnce === true
      && !failedPreparationRoots.has(options.cwd)) {
      failedPreparationRoots.add(options.cwd);
      throw new Error("Scripted preparation failure");
    }
    return { command, args, cwd: options.cwd, exitCode: 0, stdout: "offline preparation complete\n", stderr: "" };
  },
};
const projects = new ProjectManager(
  new ProjectRegistry(join(fixtureRoot, "projects.db")),
  () => ({ adapter: e2eAdapter, globalConfigStore: globalConfig, runner: preparationRunner }),
);
const memory = new MemoryService({ async run() { throw new Error("Engram intentionally unavailable in E2E"); } }, join(fixtureRoot, "codex.toml"));
const limited = {
  canServe: true,
  canExecute: false,
  canStart: false,
  essential: [{ name: "node", ok: true, message: `Node ${process.versions.node} detected` }],
  tools: [{ name: "git", ok: true, message: "Git test fixture" }],
  providers: [{ provider: "fake", executable: false, diagnostics: [{ level: "warning", code: "fake.disabled", message: "Provider disabled for first-run verification" }] }],
  upcoming: [],
};
const ready = {
  ...limited,
  canExecute: true,
  canStart: true,
  providers: [{ provider: "fake", executable: true, diagnostics: [{ level: "ok", code: "fake.ready", message: "Deterministic provider ready" }] }],
};
let preflight = limited;
const app = {
  projects,
  memory,
  config: globalConfig,
  get preflight() { return preflight; },
  async refreshPreflight() { preflight = ready; return preflight; },
};
const server = createRaycoderServer({ app });
server.listen(4399, "127.0.0.1", () => console.log("raycoder E2E fixture listening at http://127.0.0.1:4399"));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    projects.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
