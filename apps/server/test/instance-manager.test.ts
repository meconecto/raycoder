import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTANCE_PROTOCOL_VERSION, InstanceCoordinator, type InstanceRecord } from "../src/instance-manager.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "raycoder-instance-"));
  temporaryDirectories.push(root);
  return root;
}

describe("InstanceCoordinator", () => {
  it("serializes concurrent acquisition and reuses a validated same-version instance", async () => {
    const root = fixture();
    let active: InstanceRecord | null = null;
    const probe: typeof fetch = async () => new Response(JSON.stringify(active === null ? {} : {
      id: active.id,
      appVersion: active.appVersion,
      protocolVersion: active.protocolVersion,
      port: active.port,
    }), { status: active === null ? 404 : 200, headers: { "content-type": "application/json" } });
    const first = await new InstanceCoordinator("1.0.0-rc.3", root, probe).acquire();
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    active = await first.lease.publish(4317);

    const second = await new InstanceCoordinator("1.0.0-rc.3", root, probe).acquire();
    expect(second).toMatchObject({ kind: "existing", record: { id: active.id, port: 4317 } });
    await first.lease.release();
  });

  it("reports an active different version without replacing its lock", async () => {
    const root = fixture();
    let active: InstanceRecord | null = null;
    const probe: typeof fetch = async () => new Response(JSON.stringify(active), { headers: { "content-type": "application/json" } });
    const first = await new InstanceCoordinator("1.0.0-rc.2", root, probe).acquire();
    if (first.kind !== "acquired") throw new Error("Expected lease");
    active = await first.lease.publish(4200);

    const second = await new InstanceCoordinator("1.0.0-rc.3", root, probe).acquire();
    expect(second).toMatchObject({ kind: "existing", record: { appVersion: "1.0.0-rc.2" } });
    expect(JSON.parse(readFileSync(join(root, "instance.lock"), "utf8"))).toMatchObject({ nonce: first.lease.nonce });
    await first.lease.release();
  });

  it("waits, compares the nonce and replaces a stale lock", async () => {
    const root = fixture();
    writeFileSync(join(root, "instance.lock"), JSON.stringify({
      id: "stale", nonce: "stale-nonce", pid: 2_000_000_000, createdAt: new Date(0).toISOString(),
    }), "utf8");
    writeFileSync(join(root, "instance.json"), JSON.stringify({
      version: 1, id: "stale", nonce: "stale-nonce", pid: 2_000_000_000, port: 1,
      appVersion: "old", protocolVersion: INSTANCE_PROTOCOL_VERSION, startedAt: new Date(0).toISOString(),
    }), "utf8");
    const coordinator = new InstanceCoordinator("1.0.0-rc.3", root, async () => { throw new Error("offline"); });
    const acquisition = await coordinator.acquire();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind === "acquired") {
      expect(acquisition.lease.nonce).not.toBe("stale-nonce");
      await acquisition.lease.release();
    }
  });

  it("only releases descriptor files still owned by its nonce", async () => {
    const root = fixture();
    const acquired = await new InstanceCoordinator("1.0.0-rc.3", root, async () => new Response(null, { status: 404 })).acquire();
    if (acquired.kind !== "acquired") throw new Error("Expected lease");
    await acquired.lease.publish(4317);
    const replacement = { version: 1, id: "replacement", nonce: "replacement", pid: process.pid, port: 4444, appVersion: "new", protocolVersion: 1, startedAt: new Date().toISOString() };
    writeFileSync(join(root, "instance.json"), JSON.stringify(replacement), "utf8");
    await acquired.lease.release();
    expect(JSON.parse(readFileSync(join(root, "instance.json"), "utf8"))).toMatchObject({ nonce: "replacement" });
  });
});
