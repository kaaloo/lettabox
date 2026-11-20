import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import {
  buildDockerRunArgs,
  type ContainerRunSpec,
  type DockerRunner,
  parseDockerPortOutput,
} from "../src/docker-runner.ts";
import { DockerGvisorProvider } from "../src/gvisor-provider.ts";
import { MultiplexerProxy } from "../src/proxy.ts";
import { deriveListenerInstanceId, type ProxyConfig } from "../src/config.ts";

interface MockContainerInstance {
  id: string;
  spec: ContainerRunSpec;
  server: Server<{ token: string }>;
  received: string[];
  socket: ServerWebSocket<{ token: string }> | null;
  stopped: boolean;
}

function createMockDockerRunner(options: { failHealthForNames?: Set<string>; spawnDelayMs?: number } = {}) {
  const containers = new Map<string, MockContainerInstance>();
  const spawnedSpecs: ContainerRunSpec[] = [];
  const stoppedIds: string[] = [];
  let seq = 0;

  const runner: DockerRunner = {
    async runContainer(spec) {
      if (options.spawnDelayMs) {
        await Bun.sleep(options.spawnDelayMs);
      }
      seq += 1;
      const id = `ctr-${seq}-${spec.name}`;
      spawnedSpecs.push(spec);

      const expectedToken = spec.env.LETTA_WS_TOKEN ?? "";
      const shouldFailHealth = options.failHealthForNames?.has(spec.name) ?? false;

      let instance!: MockContainerInstance;
      const server = Bun.serve<{ token: string }>({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req, srv) {
          const url = new URL(req.url);
          const auth = req.headers.get("authorization");
          if (url.pathname === "/healthz") {
            if (shouldFailHealth) {
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
            const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
            instance.received.push(text);
          },
          close(ws) {
            if (instance.socket === ws) instance.socket = null;
          },
        },
      });

      instance = {
        id,
        spec,
        server,
        received: [],
        socket: null,
        stopped: false,
      };
      containers.set(id, instance);
      return id;
    },

    async getPublishedPort(containerId) {
      const inst = containers.get(containerId);
      if (!inst || inst.stopped) {
        throw new Error(`No such container: ${containerId}`);
      }
      return { host: "127.0.0.1", port: inst.server.port! };
    },

    async stopContainer(containerId) {
      const inst = containers.get(containerId);
      if (!inst || inst.stopped) return;
      inst.stopped = true;
      stoppedIds.push(containerId);
      inst.server.stop(true);
    },

    async listManagedContainers() {
      return [...containers.values()].filter((c) => !c.stopped).map((c) => c.id);
    },
  };

  return {
    runner,
    containers,
    spawnedSpecs,
    stoppedIds,
    cleanupAll() {
      for (const inst of containers.values()) {
        if (!inst.stopped) {
          inst.stopped = true;
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

describe("Docker CLI helpers", () => {
  test("buildDockerRunArgs includes gVisor runtime, loopback port, and hardening flags", () => {
    const args = buildDockerRunArgs({
      name: "letta-sbx-abc",
      image: "letta-sandbox-worker:latest",
      runtime: "runsc",
      containerPort: 4500,
      memoryLimit: "1g",
      cpuLimit: "1",
      pidsLimit: 256,
      network: "letta-net",
      labels: { "letta-sandbox.managed": "true" },
      env: { LETTA_API_KEY: "key-1", LETTA_WS_TOKEN: "tok-1" },
    });

    expect(args).toEqual([
      "run",
      "-d",
      "--rm",
      "--name",
      "letta-sbx-abc",
      "--runtime",
      "runsc",
      "-p",
      "127.0.0.1::4500",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--network",
      "letta-net",
      "--label",
      "letta-sandbox.managed=true",
      "-e",
      "LETTA_API_KEY=key-1",
      "-e",
      "LETTA_WS_TOKEN=tok-1",
      "letta-sandbox-worker:latest",
    ]);

    const noRuntimeArgs = buildDockerRunArgs({
      name: "letta-sbx-no-rt",
      image: "letta-sandbox-worker:latest",
      containerPort: 4500,
      labels: {},
      env: {},
    });
    expect(noRuntimeArgs).not.toContain("--runtime");
  });

  test("parseDockerPortOutput parses IPv4 and IPv6 host:port mappings", () => {
    expect(parseDockerPortOutput("127.0.0.1:49153\n")).toEqual({
      host: "127.0.0.1",
      port: 49153,
    });
    expect(parseDockerPortOutput("[::1]:55123\n")).toEqual({
      host: "[::1]",
      port: 55123,
    });
    expect(() => parseDockerPortOutput("invalid")).toThrow("Unable to parse docker port output");
  });
});

describe("DockerGvisorProvider lifecycle", () => {
  test("lazily spawns one container per conversation, deduplicates concurrent calls, and passes unique capability tokens", async () => {
    const mockDocker = createMockDockerRunner({ spawnDelayMs: 20 });
    cleanups.push(() => mockDocker.cleanupAll());

    const receivedFromSandboxes: Array<{ id: string; raw: string }> = [];
    const provider = new DockerGvisorProvider({
      image: "letta-sandbox-worker:latest",
      runtime: "runsc",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      docker: mockDocker.runner,
      logger: silentLogger,
      onMessage: (target, raw) => receivedFromSandboxes.push({ id: target.id, raw }),
    });
    cleanups.push(() => provider.closeAllAsync());

    // Two concurrent acquires for conv-1 must spawn only 1 container
    const [t1a, t1b, t2] = await Promise.all([
      provider.acquireForConversation("conv-1"),
      provider.acquireForConversation("conv-1"),
      provider.acquireForConversation("conv-2"),
    ]);

    expect(t1a).toBe(t1b);
    expect(t1a).not.toBe(t2);
    expect(mockDocker.spawnedSpecs).toHaveLength(2);
    expect(provider.activeCount).toBe(2);

    // Each container gets a distinct 64-char hex capability token and runtime=runsc
    const tok1 = mockDocker.spawnedSpecs[0]!.env.LETTA_WS_TOKEN!;
    const tok2 = mockDocker.spawnedSpecs[1]!.env.LETTA_WS_TOKEN!;
    expect(tok1).toMatch(/^[0-9a-f]{64}$/);
    expect(tok2).toMatch(/^[0-9a-f]{64}$/);
    expect(tok1).not.toBe(tok2);
    expect(mockDocker.spawnedSpecs[0]!.runtime).toBe("runsc");

    await provider.closeAllAsync();
    expect(mockDocker.stoppedIds).toHaveLength(2);
    expect(provider.activeCount).toBe(0);
  });

  test("reaps idle containers and transparently re-spawns on subsequent activity", async () => {
    let fakeNow = 1_000_000;
    const mockDocker = createMockDockerRunner();
    cleanups.push(() => mockDocker.cleanupAll());

    const provider = new DockerGvisorProvider({
      image: "letta-sandbox-worker:latest",
      runtime: "runsc",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 10_000,
      reaperIntervalMs: 60_000,
      now: () => fakeNow,
      docker: mockDocker.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    const t1 = await provider.acquireForConversation("conv-idle");
    const t2 = await provider.acquireForConversation("conv-active");
    expect(provider.activeCount).toBe(2);

    // Advance 6s and touch conv-active
    fakeNow += 6_000;
    t2.send(JSON.stringify({ type: "input" }));

    // Advance another 5s (conv-idle is 11s idle -> reap; conv-active is 5s idle -> keep)
    fakeNow += 5_000;
    const reaped = await provider.reapIdleOnce();
    expect(reaped).toHaveLength(1);
    expect(provider.activeCount).toBe(1);
    expect(provider.getTarget("conv-idle")).toBeUndefined();
    expect(provider.getTarget("conv-active")).toBe(t2);

    // Sending to conv-idle again transparently spawns a fresh container
    const t1Respawned = await provider.acquireForConversation("conv-idle");
    expect(t1Respawned).not.toBe(t1);
    expect(mockDocker.spawnedSpecs).toHaveLength(3);
    expect(provider.activeCount).toBe(2);
  });

  test("supports acquirePending -> bindPendingToConversation and releasePending cleanup", async () => {
    const mockDocker = createMockDockerRunner();
    cleanups.push(() => mockDocker.cleanupAll());

    const provider = new DockerGvisorProvider({
      image: "letta-sandbox-worker:latest",
      runtime: "runsc",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      docker: mockDocker.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    const pendingTarget = await provider.acquirePending("req-create-1");
    const bound = provider.bindPendingToConversation("req-create-1", "conv-created");
    expect(bound).toBe(pendingTarget);
    expect(await provider.acquireForConversation("conv-created")).toBe(pendingTarget);

    // Pending container released on error must be stopped
    await provider.acquirePending("req-create-fail");
    expect(provider.activeCount).toBe(2);
    provider.releasePending("req-create-fail");
    await Bun.sleep(20);
    expect(provider.activeCount).toBe(1);
    expect(mockDocker.stoppedIds).toHaveLength(1);
  });

  test("cleans up container if health check times out during spawn", async () => {
    const mockDocker = createMockDockerRunner();
    // Override health check to fail for every container
    const failingRunner: DockerRunner = {
      ...mockDocker.runner,
      async runContainer(spec) {
        const id = await mockDocker.runner.runContainer(spec);
        // Stop the mock server immediately so /healthz fails
        mockDocker.containers.get(id)!.server.stop(true);
        return id;
      },
    };
    cleanups.push(() => mockDocker.cleanupAll());

    const provider = new DockerGvisorProvider({
      image: "letta-sandbox-worker:latest",
      runtime: "runsc",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      startTimeoutMs: 250,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      docker: failingRunner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    await expect(provider.acquireForConversation("conv-broken")).rejects.toThrow(
      "Timed out waiting for downstream server",
    );
    expect(mockDocker.stoppedIds).toHaveLength(1);
    expect(provider.activeCount).toBe(0);
  });

  test("end-to-end MultiplexerProxy in docker mode lazily spawns gVisor containers and cleans up on stop", async () => {
    const mockDocker = createMockDockerRunner();
    cleanups.push(() => mockDocker.cleanupAll());

    // Control-plane mock server
    const cpReceived: string[] = [];
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
      websocket: {
        message(_ws, msg) {
          cpReceived.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
        },
      },
    });
    cleanups.push(() => cpServer.stop(true));

    // Mock Letta Cloud relay
    let controlWs: ServerWebSocket<{ channel: string | null }> | null = null;
    const streamOut: string[] = [];
    const relayServer = Bun.serve<{ channel: string | null }>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/environments/register" && req.method === "POST") {
          return Response.json({
            connectionId: "conn-m4",
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
      connectionName: "m4-vps",
      deviceId: "dev-m4",
      listenerInstanceId: deriveListenerInstanceId("m4-vps"),
      downstreamWsUrl: `ws://127.0.0.1:${cpServer.port}/ws`,
      downstreamHttpUrl: `http://127.0.0.1:${cpServer.port}`,
      sandboxMode: "docker",
      sandbox: {
        image: "letta-sandbox-worker:latest",
        runtime: "runsc",
        containerPort: 4500,
        idleTimeoutMs: 60_000,
        reaperIntervalMs: 60_000,
        startTimeoutMs: 5_000,
        memoryLimit: "1g",
        cpuLimit: "1",
        pidsLimit: 256,
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
      docker: mockDocker.runner,
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

    // Control-plane traffic does NOT spawn any container
    controlWs!.send(JSON.stringify({ type: "sync", runtime: { agent_id: null, conversation_id: "default" } }));
    await Bun.sleep(40);
    expect(cpReceived).toHaveLength(1);
    expect(mockDocker.spawnedSpecs).toHaveLength(0);

    // Conversation traffic lazily spawns 2 isolated containers
    controlWs!.send(
      JSON.stringify({
        type: "input",
        request_id: "r1",
        runtime: { agent_id: "a1", conversation_id: "conv-alpha" },
        text: "alpha",
      }),
    );
    controlWs!.send(
      JSON.stringify({
        type: "input",
        request_id: "r2",
        runtime: { agent_id: "a1", conversation_id: "conv-beta" },
        text: "beta",
      }),
    );

    const spawnDeadline = Date.now() + 3_000;
    while (
      (mockDocker.containers.size < 2 ||
        [...mockDocker.containers.values()].some((c) => c.received.length < 1)) &&
      Date.now() < spawnDeadline
    ) {
      await Bun.sleep(20);
    }
    expect(mockDocker.containers.size).toBe(2);

    // Emit local event_seq=1 from both containers -> rewritten to 1, 2 upstream
    const [c1, c2] = [...mockDocker.containers.values()];
    c1!.socket!.send(JSON.stringify({ type: "stream_delta", event_seq: 1, text: "a" }));
    c2!.socket!.send(JSON.stringify({ type: "stream_delta", event_seq: 1, text: "b" }));

    const streamDeadline = Date.now() + 3_000;
    while (streamOut.length < 2 && Date.now() < streamDeadline) await Bun.sleep(15);
    expect(streamOut.map((s) => (JSON.parse(s) as { event_seq: number }).event_seq)).toEqual([1, 2]);

    // Graceful shutdown cleans up both containers
    await proxy.stopAsync();
    expect(mockDocker.stoppedIds).toHaveLength(2);
  });
});
