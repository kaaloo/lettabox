import type { Server } from "bun";
import type { SandboxMode } from "./config.ts";
import type { ActiveSandboxInfo } from "./microsandbox-provider.ts";

export interface StatusSnapshot {
  name: "lettabox";
  connectionName: string;
  sandboxMode: SandboxMode;
  upstreamReady: boolean;
  uptimeMs: number;
  activeSandboxes: ActiveSandboxInfo[];
}

export interface StatusServer {
  readonly port: number;
  readonly url: string;
  stop(): void;
}

export function startStatusServer(options: {
  port: number;
  hostname?: string;
  getSnapshot: () => StatusSnapshot;
}): StatusServer {
  const hostname = options.hostname ?? "127.0.0.1";
  const server: Server<undefined> = Bun.serve({
    port: options.port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/status") {
        return Response.json(options.getSnapshot());
      }
      return new Response("not found", { status: 404 });
    },
  });

  const boundPort = server.port ?? options.port;
  return {
    port: boundPort,
    url: `http://${hostname}:${boundPort}`,
    stop() {
      server.stop(true);
    },
  };
}
