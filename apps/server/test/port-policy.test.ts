import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { listenWithFallback, parsePort, selectPort } from "../src/port-policy.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("port policy", () => {
  it("applies CLI, environment and default precedence with strict validation", () => {
    expect(selectPort("0", "5000")).toEqual({ port: 0, explicit: true });
    expect(selectPort(undefined, "5000")).toEqual({ port: 5000, explicit: true });
    expect(selectPort(undefined, undefined)).toEqual({ port: 4317, explicit: false });
    expect(() => parsePort("-1", "--port")).toThrow("0 through 65535");
    expect(() => parsePort("65536", "--port")).toThrow("0 through 65535");
    expect(() => parsePort("3.5", "--port")).toThrow("0 through 65535");
  });

  it("rejects an occupied explicit port and falls back for a default port", async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const occupied = (blocker.address() as AddressInfo).port;

    const explicit = createServer();
    await expect(listenWithFallback(explicit, occupied, true)).rejects.toThrow(`Port ${occupied} is already in use`);
    const fallback = createServer();
    servers.push(fallback);
    const selected = await listenWithFallback(fallback, occupied, false);
    expect(selected).not.toBe(occupied);
    expect(selected).toBeGreaterThan(0);
  });
});
