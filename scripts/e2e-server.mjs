import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentAdapter, MemoryService, ProjectManager, ProjectRegistry } from "../apps/server/dist/runtime.js";
import { createRaycoderServer } from "../apps/server/dist/server.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "raycoder-e2e-host-"));
const projects = new ProjectManager(
  new ProjectRegistry(join(fixtureRoot, "projects.db")),
  () => ({ adapter: new FakeAgentAdapter() }),
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
