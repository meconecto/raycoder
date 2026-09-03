import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

export interface PortSelection {
  readonly port: number;
  readonly explicit: boolean;
}

export function selectPort(cliPort: string | undefined, environmentPort: string | undefined): PortSelection {
  if (cliPort !== undefined) return { port: parsePort(cliPort, "--port"), explicit: true };
  if (environmentPort !== undefined) return { port: parsePort(environmentPort, "RAYCODER_PORT"), explicit: true };
  return { port: 4317, explicit: false };
}

export function parsePort(value: string, source: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${source} must be an integer from 0 through 65535`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error(`${source} must be an integer from 0 through 65535`);
  return port;
}

export async function listenWithFallback(server: Server, port: number, explicit: boolean): Promise<number> {
  try {
    return await listen(server, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || explicit || port === 0) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`Port ${port} is already in use by another process`);
      throw error;
    }
    return await listen(server, 0);
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (address === null) reject(new Error("raycoder server did not expose a listening address"));
      else resolveListen(address.port);
    });
  });
}
