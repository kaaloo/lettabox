import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { deriveListenerInstanceId, loadConfig, type ProxyConfig } from "../src/config.ts";
import { MicrosandboxProvider } from "../src/microsandbox-provider.ts";
import { buildMsbRunArgs, type MsbRunner, type MsbRunSpec, normalizeMsbMemory } from "../src/msb-runner.ts";
import { MultiplexerProxy } from "../src/proxy.ts";

interface MockMsbInstance {
  name: string;
  spec: MsbRunSpec;
  server: Server<{ token: string }>;
  received: string[];
  socket: ServerWebSocket<{ token: string }> | null;
  removed: boolean;
}

function createMockMsbRunner(options: { spawnDelayMs?: number; failHealth?: boolean } = {}) {
  const sandboxes = new Map<string, MockMsbInstance>();
  const spawnedSpecs: MsbRunSpec[] = [];
  const removedNames: string[] = [];

  const runner: MsbRunner = {
    async runSandbox(spec) {
      if (options.spawnDelayMs) {
        await Bun.sleep(options.spawnDelayMs);
      }
      spawnedSpecs.push(spec);
      const expectedToken = spec.env.LETTA_WS_TOKEN ?? "";

      let instance!: MockMsbInstance;
      const server = Bun.serve<{ token: string }>({
        port: spec.hostPort,
        hostname: "127.0.0.1",
        fetch(req, srv) {
          const url = new URL(req.url);
          const auth = req.headers.get("authorization");
          if (url.pathname === "/healthz") {
            if (options.failHealth) {
              return new Response("unhealthy", { status: 503 });
            }
            if (expectedToken && auth !== `Bearer ${expectedToken}`) {
              return new Response("unauthorized", { status: 401 });
            }
            return new Response("ok", { status: 200 });
          }
          if (url.pathname === "/ws") {
            if (expectedToken && auth !== `Bearer ${expectedToken}`) {
              return new Response("unauthorized", { status: 401 });
            }
            const ok = srv.upgrade(req, { data: { token: expectedToken } });
            if (ok) return undefined;
            return new Response("upgrade failed", { status: 400 });
          }
          return new Response("not found", { status: 404 });
        },
        websocket: {
          open(ws) {
            instance.socket = ws;
          },
          message(_ws, msg) {
            instance.received.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
          },
          close(ws) {
            if (instance.socket === ws) instance.socket = null;
          },
        },
      });

      instance = {
        name: spec.name,
        spec,
        server,
        received: [],
        socket: null,
        removed: false,
      };
      sandboxes.set(spec.name, instance);
      return spec.name;
    },

    async removeSandbox(name) {
      const inst = sandboxes.get(name);
      if (!inst || inst.removed) return;
      inst.removed = true;
      removedNames.push(name);
      inst.server.stop(true);
    },
  };

  return {
    runner,
    sandboxes,
    spawnedSpecs,
    removedNames,
    cleanupAll() {
      for (const inst of sandboxes.values()) {
        if (!inst.removed) {
          inst.removed = true;
          inst.server.stop(true);
        }
      }
    },
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe("Microsandbox CLI helpers & config", () => {
  test("normalizeMsbMemory converts Docker-style sizes to msb format", () => {
    expect(normalizeMsbMemory("1g")).toBe("1G");
    expect(normalizeMsbMemory("512m")).toBe("512M");
    expect(normalizeMsbMemory("2GB")).toBe("2G");
    expect(normalizeMsbMemory("2G")).toBe("2G");
  });

  test("buildMsbRunArgs constructs detached msb run with secret injection and never leaks secret value in argv", () => {
    const args = buildMsbRunArgs({
      name: "letta-msb-abc123",
      image: "letta-sandbox-worker:latest",
      hostPort: 49155,
      guestPort: 4500,
      cpus: "2",
      memory: "1g",
      labels: { "letta-sandbox.managed": "true" },
      env: { LETTA_WS_TOKEN: "cap-tok-1" },
      secret: {
        envName: "LETTA_API_KEY",
        value: "sk-let-SUPER-SECRET",
        allowedHosts: ["api.letta.com"],
        headers: ["Authorization"],
      },
      command: ["sh", "-c", "echo hi"],
    });

    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "letta-msb-abc123",
      "--replace",
      "-p",
      "127.0.0.1:49155:4500",
      "-c",
      "2",
      "-m",
      "1G",
      "--label",
      "letta-sandbox.managed=true",
      "--secret",
      "LETTA_API_KEY:headers=[Authorization]@api.letta.com",
      "-e",
      "LETTA_WS_TOKEN=cap-tok-1",
      "letta-sandbox-worker:latest",
      "--",
      "sh",
      "-c",
      "echo hi",
    ]);
    expect(args.join(" ")).not.toContain("sk-let-SUPER-SECRET");
  });

  test("loadConfig supports SANDBOX_MODE=microsandbox and msb alias", () => {
    const cfg1 = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "msb",
      MSB_PATH: "/custom/bin/msb",
      MSB_SECRET_INJECTION: "false",
    });
    expect(cfg1.sandboxMode).toBe("microsandbox");
    expect(cfg1.sandbox.msbBin).toBe("/custom/bin/msb");
    expect(cfg1.sandbox.msbSecretInjection).toBe(false);

    const cfg2 = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "microsandbox",
    });
    expect(cfg2.sandboxMode).toBe("microsandbox");
    expect(cfg2.sandbox.msbSecretInjection).toBe(true);
  });
});

describe("MicrosandboxProvider lifecycle", () => {
  test("lazily spawns microVMs, deduplicates concurrent calls, and uses host-side secret injection for HTTPS", async () => {
    const mockMsb = createMockMsbRunner({ spawnDelayMs: 20 });
    cleanups.push(() => mockMsb.cleanupAll());

    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "sk-let-real-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    const [t1a, t1b, t2] = await Promise.all([
      provider.acquireForConversation("conv-1"),
      provider.acquireForConversation("conv-1"),
      provider.acquireForConversation("conv-2"),
    ]);

    expect(t1a).toBe(t1b);
    expect(t1a).not.toBe(t2);
    expect(mockMsb.spawnedSpecs).toHaveLength(2);
    expect(provider.activeCount).toBe(2);

    // Real API key is NOT passed in guest env; it's configured as a host-side secret for api.letta.com
    const spec1 = mockMsb.spawnedSpecs[0]!;
    expect(spec1.env.LETTA_API_KEY).toBeUndefined();
    expect(spec1.secret).toEqual({
      envName: "LETTA_API_KEY",
      value: "sk-let-real-key",
      allowedHosts: ["api.letta.com"],
      headers: ["Authorization"],
    });
    expect(spec1.hostPort).not.toBe(mockMsb.spawnedSpecs[1]!.hostPort);

    await provider.closeAllAsync();
    expect(mockMsb.removedNames).toHaveLength(2);
    expect(provider.activeCount).toBe(0);
  });

  test("reaps idle microsandboxes and transparently re-spawns on subsequent activity", async () => {
    let fakeNow = 2_000_000;
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 10_000,
      reaperIntervalMs: 60_000,
      now: () => fakeNow,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    const t1 = await provider.acquireForConversation("conv-idle");
    const t2 = await provider.acquireForConversation("conv-active");

    fakeNow += 6_000;
    t2.send(JSON.stringify({ type: "input" }));

    fakeNow += 5_000;
    const reaped = await provider.reapIdleOnce();
    expect(reaped).toHaveLength(1);
    expect(provider.activeCount).toBe(1);
    expect(provider.getTarget("conv-idle")).toBeUndefined();
    expect(provider.getTarget("conv-active")).toBe(t2);

    const t1Respawned = await provider.acquireForConversation("conv-idle");
    expect(t1Respawned).not.toBe(t1);
    expect(mockMsb.spawnedSpecs).toHaveLength(3);
  });

  test("cleans up sandbox if health check times out", async () => {
    const mockMsb = createMockMsbRunner({ failHealth: true });
    cleanups.push(() => mockMsb.cleanupAll());

    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      startTimeoutMs: 250,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    await expect(provider.acquireForConversation("conv-unhealthy")).rejects.toThrow(
      "Timed out waiting for downstream server",
    );
    expect(mockMsb.removedNames).toHaveLength(1);
    expect(provider.activeCount).toBe(0);
  });

  test("end-to-end MultiplexerProxy in microsandbox mode spawns isolated VMs and cleans up on stop", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    const cpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return new Response("ok");
        if (url.pathname === "/app-server-info") {
          return Response.json({ lettaCodeVersion: "0.99.0", supported_commands: ["input"] });
        }
        if (url.pathname === "/ws" && srv.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    cleanups.push(() => cpServer.stop(true));

    let controlWs: ServerWebSocket<{ channel: string | null }> | null = null;
    const streamOut: string[] = [];
    const relayServer = Bun.serve<{ channel: string | null }>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/environments/register" && req.method === "POST") {
          return Response.json({
            connectionId: "conn-msb",
            wsUrl: `ws://127.0.0.1:${srv.port}/relay`,
            supportsSplitStatusChannels: true,
            supportsPairedListenerGenerations: true,
          });
        }
        if (url.pathname === "/relay") {
          const ok = srv.upgrade(req, { data: { channel: url.searchParams.get("channel") } });
          if (ok) return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          if (ws.data.channel === "control") {
            controlWs = ws;
            ws.send(JSON.stringify({ type: "listener_ready" }));
          }
        },
        message(ws, msg) {
          const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
          if (ws.data.channel === "stream") streamOut.push(text);
        },
      },
    });
    cleanups.push(() => relayServer.stop(true));

    let ready = false;
    const config: ProxyConfig = {
      lettaApiKey: "test-api-key",
      lettaServerUrl: `http://127.0.0.1:${relayServer.port}`,
      connectionName: "msb-laptop",
      deviceId: "dev-msb",
      listenerInstanceId: deriveListenerInstanceId("msb-laptop"),
      downstreamWsUrl: `ws://127.0.0.1:${cpServer.port}/ws`,
      downstreamHttpUrl: `http://127.0.0.1:${cpServer.port}`,
      sandboxMode: "microsandbox",
      sandbox: {
        image: "letta-sandbox-worker:latest",
        containerPort: 4500,
        idleTimeoutMs: 60_000,
        reaperIntervalMs: 60_000,
        startTimeoutMs: 5_000,
        memoryLimit: "1g",
        cpuLimit: "1",
        pidsLimit: 256,
        msbSecretInjection: true,
      },
      workerWsUrls: [],
      heartbeatIntervalMs: 30_000,
      heartbeatMaxMissed: 3,
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 100,
      downstreamReadyTimeoutMs: 5_000,
      debugFrames: false,
    };

    const proxy = new MultiplexerProxy({
      config,
      msb: mockMsb.runner,
      logger: silentLogger,
      onUpstreamReady: () => {
        ready = true;
      },
    });
    cleanups.push(() => proxy.stopAsync());

    await proxy.start();
    const deadline = Date.now() + 3_000;
    while (!ready && Date.now() < deadline) await Bun.sleep(15);
    expect(ready).toBe(true);

    controlWs!.send(
      JSON.stringify({
        type: "input",
        request_id: "r1",
        runtime: { agent_id: "a1", conversation_id: "conv-msb-1" },
        text: "hello microvm",
      }),
    );

    const spawnDeadline = Date.now() + 3_000;
    while (
      (mockMsb.sandboxes.size < 1 ||
        [...mockMsb.sandboxes.values()].some((s) => s.received.length < 1)) &&
      Date.now() < spawnDeadline
    ) {
      await Bun.sleep(20);
    }
    expect(mockMsb.sandboxes.size).toBe(1);

    const [sbx] = [...mockMsb.sandboxes.values()];
    sbx!.socket!.send(JSON.stringify({ type: "stream_delta", event_seq: 1, text: "ok" }));
    const streamDeadline = Date.now() + 3_000;
    while (streamOut.length < 1 && Date.now() < streamDeadline) await Bun.sleep(15);
    expect(JSON.parse(streamOut[0]!)).toEqual({
      type: "stream_delta",
      event_seq: 1,
      text: "ok",
    });

    await proxy.stopAsync();
    expect(mockMsb.removedNames).toHaveLength(1);
  });
});
