import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dispatcher,
  FakeAgentAdapter,
  GitWorkspaceManager,
  NodeProcessRunner,
  TicketRepository,
  type PreflightReport,
} from "@raycoder/core";
import { createRaycoderServer } from "../src/server.js";

const temporaryDirectories: string[] = [];
const runner = new NodeProcessRunner();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createRepository(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "raycoder-server-"));
  temporaryDirectories.push(directory);
  await runner.run("git", ["init", "-b", "main"], { cwd: directory });
  await runner.run("git", ["config", "user.name", "raycoder tests"], { cwd: directory });
  await runner.run("git", ["config", "user.email", "tests@raycoder.local"], { cwd: directory });
  writeFileSync(join(directory, "README.md"), "base\n", "utf8");
  await runner.run("git", ["add", "README.md"], { cwd: directory });
  await runner.run("git", ["commit", "-m", "test: base"], { cwd: directory });
  return directory;
}

describe("minimal server", () => {
  it("exposes preflight and dispatches the demonstration ticket through the API", async () => {
    const projectRoot = await createRepository();
    const repository = new TicketRepository(":memory:");
    const preflight: PreflightReport = {
      canStart: true,
      essential: [{ name: "node", ok: true, message: "Node test" }],
      providers: [{ provider: "fake", executable: true, diagnostics: [] }],
      upcoming: [],
    };
    const server = createRaycoderServer({
      repository,
      dispatcher: new Dispatcher(repository, new GitWorkspaceManager(), new FakeAgentAdapter()),
      preflight,
      projectRoot,
      baseBranch: "main",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}`;
    try {
      expect(await (await fetch(`${root}/api/preflight`)).json()).toMatchObject({ canStart: true });
      const response = await fetch(`${root}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dirtyPolicy: "cancel" }),
      });
      expect(response.status).toBe(202);
      await waitFor(() => repository.list()[0]?.status === "READY_TO_MERGE");
      expect(repository.list()[0]?.status).toBe("READY_TO_MERGE");
      expect(await (await fetch(root)).text()).toContain("raycoder");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      repository.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for server dispatch");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
