import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { CloudHttpError, RuntimeError, ServiceNotFoundError } from "microsandbox";
import { deriveListenerInstanceId, loadConfig, type ProxyConfig } from "../src/config.ts";
import { buildMsbBootstrapScript, MicrosandboxProvider } from "../src/microsandbox-provider.ts";
import {
  buildSdkSandbox,
  type MsbRunner,
  type MsbRunSpec,
  makeMsbServiceSlug,
  parseMsbCpuCount,
  parseMsbMemoryMiB,
  resolveMsbLaunchCommand,
  type SdkGhBinaryOps,
  type SdkImageOps,
  SdkMsbRunner,
  type SdkRuntimeOps,
  type SdkSandboxOps,
  type SdkServiceOps,
  serviceUrlToEndpoints,
} from "../src/msb-runner.ts";
import { MultiplexerProxy } from "../src/proxy.ts";

interface MockMsbInstance {
  name: string;
  spec: MsbRunSpec;
  server: Server<{ token: string }>;
  received: string[];
  healthHeaders: Record<string, string | null>[];
  wsHeaders: Record<string, string | null>[];
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
        port: spec.hostPort ?? 0,
        hostname: "127.0.0.1",
        fetch(req, srv) {
          const url = new URL(req.url);
          const auth = req.headers.get("authorization");
          if (url.pathname === "/healthz") {
            instance.healthHeaders.push({
              authorization: auth,
              "msb-skip-browser-warning": req.headers.get("msb-skip-browser-warning"),
            });
            if (options.failHealth) {
              return new Response("unhealthy", { status: 503 });
            }
            if (expectedToken && auth !== `Bearer ${expectedToken}`) {
              return new Response("unauthorized", { status: 401 });
            }
            return new Response("ok", { status: 200 });
          }
          if (url.pathname === "/ws") {
            instance.wsHeaders.push({
              authorization: auth,
              "msb-skip-browser-warning": req.headers.get("msb-skip-browser-warning"),
            });
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

      const boundPort = server.port ?? spec.hostPort ?? 0;
      const httpUrl = `http://127.0.0.1:${boundPort}`;
      const wsUrl = `ws://127.0.0.1:${boundPort}/ws`;

      instance = {
        name: spec.name,
        spec,
        server,
        received: [],
        healthHeaders: [],
        wsHeaders: [],
        socket: null,
        removed: false,
      };
      sandboxes.set(spec.name, instance);
      if (spec.backend === "cloud") {
        return {
          name: spec.name,
          httpUrl,
          wsUrl,
          serviceSlug: `lb-${spec.name.slice(-12)}`,
          serviceUrl: httpUrl,
        };
      }
      return {
        name: spec.name,
        httpUrl,
        wsUrl,
        hostPort: boundPort,
      };
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

describe("Microsandbox SDK helpers & config", () => {
  test("parseMsbMemoryMiB converts Docker-style sizes and bare MiB values", () => {
    expect(parseMsbMemoryMiB("1g")).toBe(1024);
    expect(parseMsbMemoryMiB("512m")).toBe(512);
    expect(parseMsbMemoryMiB("2GB")).toBe(2048);
    expect(parseMsbMemoryMiB("1024K")).toBe(1);
    expect(parseMsbMemoryMiB("0.5G")).toBe(512);
    expect(parseMsbMemoryMiB("2048")).toBe(2048);
    expect(() => parseMsbMemoryMiB("0G")).toThrow("must be greater than zero");
  });

  test("parseMsbCpuCount accepts only positive integers", () => {
    expect(parseMsbCpuCount("2")).toBe(2);
    expect(() => parseMsbCpuCount("1.5")).toThrow("positive integer");
    expect(() => parseMsbCpuCount("0")).toThrow("positive integer");
  });

  test("buildSdkSandbox maps the native config and scopes secrets to Authorization", async () => {
    const config = JSON.parse(
      JSON.stringify(
        await buildSdkSandbox({
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
          entrypoint: "/bin/sh",
          command: ["-c", "echo hi"],
        }).build(),
      ),
    );

    expect(config.resources).toMatchObject({ cpus: 2, memoryMib: 1024 });
    expect(config.runtime.entrypoint).toEqual(["/bin/sh"]);
    expect(config.runtime.cmd).toEqual(["-c", "echo hi"]);
    expect(config.labels).toEqual({ "letta-sandbox.managed": "true" });
    expect(config.env).toEqual([{ key: "LETTA_WS_TOKEN", value: "cap-tok-1" }]);
    expect(config.network.ports).toEqual([
      { hostPort: 49155, guestPort: 4500, protocol: "tcp", hostBind: "127.0.0.1" },
    ]);
    expect(config.network.secrets.secrets).toHaveLength(1);
    expect(config.network.secrets.secrets[0]).toMatchObject({
      envVar: "LETTA_API_KEY",
      allowedHosts: [{ exact: "api.letta.com" }],
      substitution: {
        headers: true,
        headerFields: ["Authorization"],
        query: false,
        body: false,
      },
    });
    expect(config.env).not.toContainEqual({ key: "LETTA_API_KEY", value: "sk-let-SUPER-SECRET" });
  });

  test("buildSdkSandbox encodes copyFile patches into native config", async () => {
    const config = JSON.parse(
      JSON.stringify(
        await buildSdkSandbox({
          name: "letta-msb-patch-1",
          image: "ghcr.io/letta-ai/letta-code:latest",
          hostPort: 49156,
          guestPort: 4500,
          labels: {},
          env: {},
          patches: [
            {
              kind: "copyFile",
              src: "/tmp/cached-gh",
              dst: "/usr/local/bin/gh",
              mode: 0o755,
              replace: true,
            },
          ],
        }).build(),
      ),
    );

    expect(config.patches).toEqual([
      {
        CopyFile: {
          src: "/tmp/cached-gh",
          dst: "/usr/local/bin/gh",
          mode: 0o755,
          replace: true,
        },
      },
    ]);
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
    expect(cfg1.sandbox.image).toBe("ghcr.io/letta-ai/letta-code:latest");
    expect(cfg1.sandbox.msbBin).toBe("/custom/bin/msb");
    expect(cfg1.sandbox.msbHome?.endsWith("/.lettabox/microsandbox")).toBe(true);
    expect(cfg1.sandbox.msbSecretInjection).toBe(false);

    const cfg2 = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "microsandbox",
      MSB_HOME: "/custom/msb-home",
    });
    expect(cfg2.sandboxMode).toBe("microsandbox");
    expect(cfg2.sandbox.image).toBe("ghcr.io/letta-ai/letta-code:latest");
    expect(cfg2.sandbox.msbHome).toBe("/custom/msb-home");
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
          return Response.json({
            lettaCodeVersion: "0.99.0",
            supported_commands: ["input"],
          });
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
          const ok = srv.upgrade(req, {
            data: { channel: url.searchParams.get("channel") },
          });
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
        backend: "local",
        image: "ghcr.io/letta-ai/letta-code:latest",
        containerPort: 4500,
        idleTimeoutMs: 60_000,
        reaperIntervalMs: 60_000,
        startTimeoutMs: 5_000,
        memoryLimit: "1G",
        cpuLimit: "1",
        msbSecretInjection: true,
        autoConversationTitles: true,
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

  test("never reaps a busy sandbox mid-turn and reaps once turn_finished completes", async () => {
    let fakeNow = 3_000_000;
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    const provider = new MicrosandboxProvider({
      image: "ghcr.io/letta-ai/letta-code:latest",
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

    const target = await provider.acquireForConversation("conv-busy");
    const [sbx] = [...mockMsb.sandboxes.values()];

    // Start an active turn
    sbx!.socket!.send(JSON.stringify({ type: "input_accepted", request_id: "r1" }));
    await Bun.sleep(25);
    expect(provider.listActiveSandboxes()[0]?.busy).toBe(true);

    // Advance well past idleTimeoutMs while turn is still active -> must NOT reap
    fakeNow += 60_000;
    expect(await provider.reapIdleOnce()).toEqual([]);
    expect(provider.getTarget("conv-busy")).toBe(target);
    expect(mockMsb.removedNames).toHaveLength(0);

    // Finish the turn -> lastActivityAt resets to fakeNow, busy becomes false
    sbx!.socket!.send(JSON.stringify({ type: "turn_finished", event_seq: 1 }));
    await Bun.sleep(25);
    expect(provider.listActiveSandboxes()[0]?.busy).toBe(false);

    // Not yet idle right after turn_finished
    expect(await provider.reapIdleOnce()).toEqual([]);

    // Now advance past idleTimeoutMs -> cleanly reaped
    fakeNow += 11_000;
    expect(await provider.reapIdleOnce()).toHaveLength(1);
    expect(provider.getTarget("conv-busy")).toBeUndefined();
  });

  test("evicts crashed/OOM-killed sandbox on permanent disconnect and respawns cleanly", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    const provider = new MicrosandboxProvider({
      image: "ghcr.io/letta-ai/letta-code:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 40,
      maxReconnectAttempts: 1,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    const t1 = await provider.acquireForConversation("conv-crash");
    const [firstSbx] = [...mockMsb.sandboxes.values()];

    // Simulate VM crash / OOM kill by stopping the underlying server abruptly
    firstSbx!.server.stop(true);

    // Wait for reconnect attempts to exhaust and trigger eviction
    const deadline = Date.now() + 2_000;
    while (provider.getTarget("conv-crash") !== undefined && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(provider.getTarget("conv-crash")).toBeUndefined();
    expect(mockMsb.removedNames).toContain(firstSbx!.name);

    // Next message transparently spawns a fresh working sandbox
    const t2 = await provider.acquireForConversation("conv-crash");
    expect(t2).not.toBe(t1);
    expect(mockMsb.spawnedSpecs).toHaveLength(2);
  });
});

describe("SdkMsbRunner runtime version matching", () => {
  test("reuses and pins an already-matching runtime without reinstalling", async () => {
    const fakeEnv: Record<string, string | undefined> = {};
    let installCalls = 0;
    const ops: SdkRuntimeOps = {
      resolveRuntime: () => ({
        msbPath: "/home/test/.lettabox/microsandbox/bin/msb",
        libkrunfwPath: "/home/test/.lettabox/microsandbox/lib/libkrunfw.dylib",
        origin: "home",
      }),
      resolveRuntimeVersion: async () => "0.7.16",
      installRuntime: async () => {
        installCalls += 1;
        throw new Error("should not install");
      },
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: fakeEnv,
      runtimeOps: ops,
      logger: silentLogger,
    });

    await runner.ensureReady();
    expect(installCalls).toBe(0);
    expect(fakeEnv.MSB_HOME).toBe("/home/test/.lettabox/microsandbox");
    expect(fakeEnv.MSB_PATH).toBe("/home/test/.lettabox/microsandbox/bin/msb");
    expect(fakeEnv.MSB_LIBKRUNFW_PATH).toBe(
      "/home/test/.lettabox/microsandbox/lib/libkrunfw.dylib",
    );
  });

  test("installs matching runtime under msbHome when resolved runtime has mismatched version (e.g. 0.7.15)", async () => {
    const fakeEnv: Record<string, string | undefined> = {};
    const installArgs: Array<{ home?: string; version?: string; force?: boolean }> = [];
    const ops: SdkRuntimeOps = {
      resolveRuntime: () => ({
        msbPath: "/opt/homebrew/bin/msb",
        libkrunfwPath: "/opt/homebrew/lib/libkrunfw.dylib",
        origin: "installed",
      }),
      resolveRuntimeVersion: async (exe) => (exe.includes(".lettabox") ? "0.7.16" : "0.7.15"),
      installRuntime: async (cfg = {}, opts = {}) => {
        installArgs.push({ home: cfg.home, version: opts.version, force: opts.force });
        return {
          msbPath: "/home/test/.lettabox/microsandbox/bin/msb",
          libkrunfwPath: "/home/test/.lettabox/microsandbox/lib/libkrunfw.dylib",
          origin: "home",
        };
      },
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: fakeEnv,
      runtimeOps: ops,
      logger: silentLogger,
    });

    await runner.ensureReady();
    expect(installArgs).toEqual([
      { home: "/home/test/.lettabox/microsandbox", version: "0.7.16", force: true },
    ]);
    expect(fakeEnv.MSB_PATH).toBe("/home/test/.lettabox/microsandbox/bin/msb");
    expect(fakeEnv.MSB_LIBKRUNFW_PATH).toBe(
      "/home/test/.lettabox/microsandbox/lib/libkrunfw.dylib",
    );
  });

  test("installs matching runtime when no runtime is currently installed", async () => {
    const fakeEnv: Record<string, string | undefined> = {};
    let installCalls = 0;
    const ops: SdkRuntimeOps = {
      resolveRuntime: () => {
        throw new Error("runtime not found");
      },
      resolveRuntimeVersion: async () => "0.7.16",
      installRuntime: async () => {
        installCalls += 1;
        return {
          msbPath: "/home/test/.lettabox/microsandbox/bin/msb",
          libkrunfwPath: "/home/test/.lettabox/microsandbox/lib/libkrunfw.dylib",
          origin: "home",
        };
      },
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: fakeEnv,
      runtimeOps: ops,
      logger: silentLogger,
    });

    await runner.ensureReady();
    expect(installCalls).toBe(1);
    expect(fakeEnv.MSB_PATH).toBe("/home/test/.lettabox/microsandbox/bin/msb");
  });

  test("rejects explicit MSB_PATH with mismatched version instead of silently overriding", async () => {
    const fakeEnv: Record<string, string | undefined> = { MSB_PATH: "/custom/msb-0.7.15" };
    let installCalls = 0;
    const ops: SdkRuntimeOps = {
      resolveRuntime: () => ({
        msbPath: "/custom/msb-0.7.15",
        libkrunfwPath: "/custom/libkrunfw.dylib",
        origin: "environment",
      }),
      resolveRuntimeVersion: async () => "0.7.15",
      installRuntime: async () => {
        installCalls += 1;
        throw new Error("should not install");
      },
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: fakeEnv,
      runtimeOps: ops,
      logger: silentLogger,
    });

    await expect(runner.ensureReady()).rejects.toThrow(
      "is version 0.7.15, but lettabox requires 0.7.16",
    );
    expect(installCalls).toBe(0);
  });

  test("setNativeProcessEnv propagates MSB_PATH to the native microsandbox N-API addon", async () => {
    const { resolveRuntime } = await import("microsandbox");
    const { setNativeProcessEnv, unsetNativeProcessEnv } = await import("../src/msb-runner.ts");

    const prevPath = process.env.MSB_PATH;
    const prevFw = process.env.MSB_LIBKRUNFW_PATH;
    try {
      setNativeProcessEnv("MSB_PATH", "/nonexistent/lettabox-native-env-check");
      unsetNativeProcessEnv("MSB_LIBKRUNFW_PATH");
      expect(() => resolveRuntime()).toThrow("/nonexistent/lettabox-native-env-check");
    } finally {
      if (prevPath !== undefined) setNativeProcessEnv("MSB_PATH", prevPath);
      else unsetNativeProcessEnv("MSB_PATH");
      if (prevFw !== undefined) setNativeProcessEnv("MSB_LIBKRUNFW_PATH", prevFw);
      else unsetNativeProcessEnv("MSB_LIBKRUNFW_PATH");
    }
  });
});

describe("SdkMsbRunner detached command launch and diagnostics", () => {
  const readyRuntimeOps: SdkRuntimeOps = {
    resolveRuntime: () => ({
      msbPath: "/home/test/.lettabox/microsandbox/bin/msb",
      libkrunfwPath: "/home/test/.lettabox/microsandbox/lib/libkrunfw.dylib",
      origin: "home",
    }),
    resolveRuntimeVersion: async () => "0.7.16",
    installRuntime: async () => {
      throw new Error("should not install");
    },
  };

  const cachedImageOps: SdkImageOps = {
    isCached: async () => true,
    pull: async () => {
      throw new Error("should not pull");
    },
  };

  const cachedGhBinaryOps: SdkGhBinaryOps = {
    ensureBinary: async (msbHome) => `${msbHome}/cache/gh/2.104.0/linux-arm64/gh`,
  };

  test("ensureReady skips image pull when image is already cached", async () => {
    let isCachedCalls = 0;
    let pullCalls = 0;
    let ghEnsureCalls = 0;
    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      image: "ghcr.io/letta-ai/letta-code:latest",
      expectedVersion: "0.7.16",
      env: {},
      runtimeOps: readyRuntimeOps,
      imageOps: {
        isCached: async () => {
          isCachedCalls += 1;
          return true;
        },
        pull: async () => {
          pullCalls += 1;
        },
      },
      ghBinaryOps: {
        ensureBinary: async (msbHome) => {
          ghEnsureCalls += 1;
          return `${msbHome}/cache/gh/2.104.0/linux-arm64/gh`;
        },
      },
      logger: silentLogger,
    });

    await Promise.all([runner.ensureReady(), runner.ensureReady()]);
    await runner.ensureReady();
    expect(isCachedCalls).toBe(1);
    expect(pullCalls).toBe(0);
    expect(ghEnsureCalls).toBe(1);
  });

  test("ensureReady retries gh binary caching after a transient failure", async () => {
    let ghAttempts = 0;
    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      image: "ghcr.io/letta-ai/letta-code:latest",
      expectedVersion: "0.7.16",
      env: {},
      runtimeOps: readyRuntimeOps,
      imageOps: cachedImageOps,
      ghBinaryOps: {
        ensureBinary: async (msbHome) => {
          ghAttempts += 1;
          if (ghAttempts === 1) {
            throw new Error("transient gh download failure");
          }
          return `${msbHome}/cache/gh/2.104.0/linux-arm64/gh`;
        },
      },
      logger: silentLogger,
    });

    await expect(runner.ensureReady()).rejects.toThrow("transient gh download failure");
    await runner.ensureReady();
    expect(ghAttempts).toBe(2);
  });

  test("ensureReady pulls uncached image using the resolved msb binary and pinned env", async () => {
    const pullCalls: Array<{
      msbPath: string;
      reference: string;
      msbHome?: string;
      msbPathEnv?: string;
    }> = [];
    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      image: "ghcr.io/letta-ai/letta-code:latest",
      expectedVersion: "0.7.16",
      env: {},
      runtimeOps: readyRuntimeOps,
      imageOps: {
        isCached: async () => false,
        pull: async (msbPath, reference, env) => {
          pullCalls.push({
            msbPath,
            reference,
            msbHome: env.MSB_HOME,
            msbPathEnv: env.MSB_PATH,
          });
        },
      },
      ghBinaryOps: cachedGhBinaryOps,
      logger: silentLogger,
    });

    await runner.ensureReady();
    await runner.ensureReady("ghcr.io/letta-ai/letta-code:latest");
    expect(pullCalls).toEqual([
      {
        msbPath: "/home/test/.lettabox/microsandbox/bin/msb",
        reference: "ghcr.io/letta-ai/letta-code:latest",
        msbHome: "/home/test/.lettabox/microsandbox",
        msbPathEnv: "/home/test/.lettabox/microsandbox/bin/msb",
      },
    ]);
  });

  test("resolveMsbLaunchCommand combines entrypoint and command or splits command-only specs", () => {
    expect(
      resolveMsbLaunchCommand({
        name: "s1",
        image: "img",
        hostPort: 10000,
        guestPort: 4500,
        labels: {},
        env: {},
        entrypoint: "/bin/sh",
        command: ["-c", "exec letta server"],
      }),
    ).toEqual({ cmd: "/bin/sh", args: ["-c", "exec letta server"] });

    expect(
      resolveMsbLaunchCommand({
        name: "s2",
        image: "img",
        hostPort: 10000,
        guestPort: 4500,
        labels: {},
        env: {},
        command: ["letta", "server", "--listen", "ws://0.0.0.0:4500"],
      }),
    ).toEqual({ cmd: "letta", args: ["server", "--listen", "ws://0.0.0.0:4500"] });

    expect(
      resolveMsbLaunchCommand({
        name: "s3",
        image: "img",
        hostPort: 10000,
        guestPort: 4500,
        labels: {},
        env: {},
      }),
    ).toBeNull();
  });

  test("runSandbox launches the bootstrap command via execDetached before detaching and injects gh binary patch", async () => {
    const events: string[] = [];
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const createdSpecs: MsbRunSpec[] = [];
    const sandboxOps: SdkSandboxOps = {
      create: async (spec) => {
        createdSpecs.push(spec);
        events.push(`create:${spec.name}`);
        return {
          name: spec.name,
          exec: async () => ({ code: 0, success: true, stdout: () => "", stderr: () => "" }),
          execDetached: async (cmd, args) => {
            events.push("execDetached");
            execCalls.push({ cmd, args: args ? Array.from(args) : [] });
            return { id: "job-1" };
          },
          detach: async () => {
            events.push("detach");
          },
          destroy: async () => {
            events.push("destroy");
          },
        };
      },
      get: async () => {
        throw new Error("unused");
      },
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: {},
      runtimeOps: readyRuntimeOps,
      imageOps: cachedImageOps,
      ghBinaryOps: cachedGhBinaryOps,
      sandboxOps,
      logger: silentLogger,
    });

    const runResult = await runner.runSandbox({
      name: "letta-msb-test-1",
      image: "ghcr.io/letta-ai/letta-code:latest",
      hostPort: 20711,
      guestPort: 4500,
      labels: { "letta-sandbox.managed": "true" },
      env: { LETTA_WS_TOKEN: "tok" },
      entrypoint: "/bin/sh",
      command: ["-c", "exec letta server"],
      patches: [
        {
          kind: "copyFile",
          src: "/tmp/extra",
          dst: "/etc/extra",
          mode: 0o644,
          replace: true,
        },
      ],
    });

    expect(runResult).toEqual({
      name: "letta-msb-test-1",
      httpUrl: "http://127.0.0.1:20711",
      wsUrl: "ws://127.0.0.1:20711/ws",
      hostPort: 20711,
    });
    expect(events).toEqual(["create:letta-msb-test-1", "execDetached", "detach"]);
    expect(execCalls).toEqual([{ cmd: "/bin/sh", args: ["-c", "exec letta server"] }]);
    expect(createdSpecs[0]?.patches).toEqual([
      {
        kind: "copyFile",
        src: "/home/test/.lettabox/microsandbox/cache/gh/2.104.0/linux-arm64/gh",
        dst: "/usr/local/bin/gh",
        mode: 0o755,
        replace: true,
      },
      {
        kind: "copyFile",
        src: "/tmp/extra",
        dst: "/etc/extra",
        mode: 0o644,
        replace: true,
      },
    ]);

    // Caller-supplied /usr/local/bin/gh patch takes precedence without duplicating
    await runner.runSandbox({
      name: "letta-msb-test-override",
      image: "ghcr.io/letta-ai/letta-code:latest",
      hostPort: 20713,
      guestPort: 4500,
      labels: {},
      env: {},
      patches: [
        {
          kind: "copyFile",
          src: "/custom/gh",
          dst: "/usr/local/bin/gh",
          mode: 0o755,
          replace: true,
        },
      ],
    });
    expect(createdSpecs[1]?.patches).toEqual([
      {
        kind: "copyFile",
        src: "/custom/gh",
        dst: "/usr/local/bin/gh",
        mode: 0o755,
        replace: true,
      },
    ]);
  });

  test("runSandbox destroys the created sandbox if execDetached fails", async () => {
    let destroyedForce: boolean | undefined;
    const sandboxOps: SdkSandboxOps = {
      create: async (spec) => ({
        name: spec.name,
        exec: async () => ({ code: 0, success: true, stdout: () => "", stderr: () => "" }),
        execDetached: async () => {
          throw new Error("execDetached boom");
        },
        detach: async () => {
          throw new Error("should not detach");
        },
        destroy: async (opts) => {
          destroyedForce = opts?.force;
        },
      }),
      get: async () => {
        throw new Error("unused");
      },
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: {},
      runtimeOps: readyRuntimeOps,
      imageOps: cachedImageOps,
      ghBinaryOps: cachedGhBinaryOps,
      sandboxOps,
      logger: silentLogger,
    });

    await expect(
      runner.runSandbox({
        name: "letta-msb-fail-1",
        image: "ghcr.io/letta-ai/letta-code:latest",
        hostPort: 20712,
        guestPort: 4500,
        labels: {},
        env: {},
        entrypoint: "/bin/sh",
        command: ["-c", "exec letta server"],
      }),
    ).rejects.toThrow("execDetached boom");
    expect(destroyedForce).toBe(true);
  });

  test("readSandboxLogs returns detached job status and stderr/stdout output", async () => {
    const sandboxOps: SdkSandboxOps = {
      create: async () => {
        throw new Error("unused");
      },
      get: async () => ({
        destroy: async () => {},
        listJobsWith: async () => ({
          items: [
            {
              id: "job-abc",
              state: "exited",
              exitCode: 127,
              error: null,
            },
          ],
        }),
        getJob: async () => ({
          logs: async () => [
            { source: "stderr", data: Buffer.from("/bin/sh: letta: not found\n") },
          ],
        }),
        logs: async () => [],
      }),
    };

    const runner = new SdkMsbRunner({
      msbHome: "/home/test/.lettabox/microsandbox",
      expectedVersion: "0.7.16",
      env: {},
      runtimeOps: readyRuntimeOps,
      imageOps: cachedImageOps,
      ghBinaryOps: cachedGhBinaryOps,
      sandboxOps,
      logger: silentLogger,
    });

    const logs = await runner.readSandboxLogs("letta-msb-diag-1");
    expect(logs).toContain("[job=job-abc state=exited exitCode=127]");
    expect(logs).toContain("/bin/sh: letta: not found");
  });

  test("MicrosandboxProvider logs guest diagnostics before removing a timed-out sandbox", async () => {
    const mockMsb = createMockMsbRunner({ failHealth: true });
    cleanups.push(() => mockMsb.cleanupAll());
    mockMsb.runner.readSandboxLogs = async () => "[job=job-1 state=exited exitCode=1]\nboom";

    const errors: string[] = [];
    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      startTimeoutMs: 200,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: {
        info: () => {},
        warn: () => {},
        error: (msg) => errors.push(msg),
      },
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    await expect(provider.acquireForConversation("conv-diag")).rejects.toThrow(
      "Timed out waiting for downstream server",
    );
    expect(errors.some((line) => line.includes("[guest logs]") && line.includes("boom"))).toBe(
      true,
    );
  });

  test("MicrosandboxProvider reports busy=true while spawning a cold microVM and false once ready", async () => {
    const mockMsb = createMockMsbRunner({ spawnDelayMs: 30 });
    cleanups.push(() => mockMsb.cleanupAll());

    const busyTransitions: boolean[] = [];
    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
      onBusyChange: (busy) => busyTransitions.push(busy),
    });
    cleanups.push(() => provider.closeAllAsync());

    await provider.acquireForConversation("conv-spin");
    expect(busyTransitions).toEqual([true, false]);
  });

  test("loadConfig defaults sandbox.warmPoolSize to 1 and allows disabling with SANDBOX_WARM_POOL_SIZE=0", () => {
    const defaultCfg = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "microsandbox",
    });
    expect(defaultCfg.sandbox.warmPoolSize).toBe(1);

    const disabledCfg = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "microsandbox",
      SANDBOX_WARM_POOL_SIZE: "0",
    });
    expect(disabledCfg.sandbox.warmPoolSize).toBe(0);
  });

  test("warmPoolSize=1 pre-warms during ensureReady, hands off instantly, refills in background, and cleans up on shutdown", async () => {
    const mockMsb = createMockMsbRunner({ spawnDelayMs: 40 });
    cleanups.push(() => mockMsb.cleanupAll());

    const busyTransitions: boolean[] = [];
    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      warmPoolSize: 1,
      idleTimeoutMs: 10_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
      onBusyChange: (busy) => busyTransitions.push(busy),
    });
    cleanups.push(() => provider.closeAllAsync());

    await provider.ensureReady();
    expect(provider.warmPoolCount).toBe(1);
    expect(provider.activeCount).toBe(0);
    expect(mockMsb.spawnedSpecs).toHaveLength(1);
    expect(busyTransitions).toEqual([]);

    // Claiming the pre-warmed microVM should be near-instant (does not wait for spawnDelayMs=40ms)
    const claimStart = Date.now();
    const target = await provider.acquireForConversation("conv-warm-1");
    const claimElapsed = Date.now() - claimStart;
    expect(target).toBeDefined();
    expect(claimElapsed).toBeLessThan(25);
    expect(provider.activeCount).toBe(1);
    expect(busyTransitions).toEqual([]);

    // Background refill replenishes the warm standby microVM
    const refillDeadline = Date.now() + 2_000;
    while (provider.warmPoolCount < 1 && Date.now() < refillDeadline) {
      await Bun.sleep(15);
    }
    expect(provider.warmPoolCount).toBe(1);
    expect(mockMsb.spawnedSpecs).toHaveLength(2);

    // Idle reaper must NOT reap warm standby microVMs
    expect(await provider.reapIdleOnce()).toEqual([]);
    expect(provider.warmPoolCount).toBe(1);

    // Shutdown destroys both the active conversation microVM and the warm standby microVM
    await provider.closeAllAsync();
    expect(provider.activeCount).toBe(0);
    expect(provider.warmPoolCount).toBe(0);
    expect(mockMsb.removedNames).toHaveLength(2);
  });

  test("warm standby refill retries with backoff after a transient spawn failure", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    let attempts = 0;
    const origRun = mockMsb.runner.runSandbox.bind(mockMsb.runner);
    mockMsb.runner.runSandbox = async (spec) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient boot failure");
      }
      return origRun(spec);
    };

    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      warmPoolSize: 1,
      reconnectBaseDelayMs: 25,
      reconnectMaxDelayMs: 50,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    await provider.ensureReady();
    expect(provider.warmPoolCount).toBe(0);

    // Backoff retry should recover the standby microVM automatically
    const deadline = Date.now() + 2_000;
    while (provider.warmPoolCount < 1 && Date.now() < deadline) {
      await Bun.sleep(15);
    }
    expect(provider.warmPoolCount).toBe(1);
    expect(attempts).toBe(2);
  });

  test("concurrent acquisition awaits in-flight cold spawn instead of claiming a newly refilled warm standby", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    let releaseColdSpawn!: () => void;
    const coldSpawnGate = new Promise<void>((resolve) => {
      releaseColdSpawn = resolve;
    });

    const origRun = mockMsb.runner.runSandbox.bind(mockMsb.runner);
    mockMsb.runner.runSandbox = async (spec) => {
      if (spec.labels["letta-sandbox.conversation"] === "conv-race") {
        await coldSpawnGate;
      }
      return origRun(spec);
    };

    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      warmPoolSize: 1,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    // Start a cold spawn for conv-race while the warm pool is still empty
    const firstAcquire = provider.acquireForConversation("conv-race");
    // Now warm the standby pool while the cold spawn is still in flight
    await provider.ensureReady();
    expect(provider.warmPoolCount).toBe(1);

    // Second concurrent acquire for the SAME conversation must join the in-flight cold spawn
    const secondAcquire = provider.acquireForConversation("conv-race");
    expect(provider.warmPoolCount).toBe(1);

    releaseColdSpawn();
    const [t1, t2] = await Promise.all([firstAcquire, secondAcquire]);
    expect(t1).toBe(t2);
    expect(provider.warmPoolCount).toBe(1);

    // Shutdown cleanly destroys every spawned sandbox (no leaked workers)
    await provider.closeAllAsync();
    expect(mockMsb.removedNames).toHaveLength(mockMsb.spawnedSpecs.length);
  });

  test("discards a disconnected warm standby and spawns a healthy replacement on acquire", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    const provider = new MicrosandboxProvider({
      image: "letta-sandbox-worker:latest",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      warmPoolSize: 1,
      reconnectBaseDelayMs: 5_000,
      reconnectMaxDelayMs: 10_000,
      maxReconnectAttempts: 3,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    await provider.ensureReady();
    expect(provider.warmPoolCount).toBe(1);
    const [standby] = [...mockMsb.sandboxes.values()];
    if (!standby) throw new Error("expected a warm standby sandbox");

    // Drop the standby's socket while reconnect is still pending (isOpen=false, isClosed=false)
    standby.server.stop(true);
    const dropDeadline = Date.now() + 2_000;
    while (provider.warmPoolCount > 0 && Date.now() < dropDeadline) {
      await Bun.sleep(10);
    }
    expect(provider.warmPoolCount).toBe(0);

    // Acquire must discard the disconnected standby and return a fresh healthy target
    const target = await provider.acquireForConversation("conv-fresh");
    expect(target.id).not.toBe(`msb-${standby.name.slice("letta-msb-".length)}`);
    expect(mockMsb.removedNames).toContain(standby.name);
  });
});

describe("Microsandbox Cloud backend", () => {
  test("makeMsbServiceSlug generates valid Microsandbox Service slugs and serviceUrlToEndpoints maps https/http to wss/ws", () => {
    const slug = makeMsbServiceSlug();
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$/);
    expect(slug.startsWith("lb-")).toBe(true);

    expect(serviceUrlToEndpoints("https://lb-0123456789abcdef.microsandbox.dev/")).toEqual({
      httpUrl: "https://lb-0123456789abcdef.microsandbox.dev",
      wsUrl: "wss://lb-0123456789abcdef.microsandbox.dev/ws",
    });
    expect(serviceUrlToEndpoints("http://127.0.0.1:8787")).toEqual({
      httpUrl: "http://127.0.0.1:8787",
      wsUrl: "ws://127.0.0.1:8787/ws",
    });
    expect(() => serviceUrlToEndpoints("ftp://example.com")).toThrow(
      "Unsupported Microsandbox Service URL protocol",
    );
  });

  test("buildSdkSandbox in cloud mode sets ephemeral=true, omits portBind/replace/entrypoint/cmd, and preserves secret injection", async () => {
    const config = JSON.parse(
      JSON.stringify(
        await buildSdkSandbox({
          name: "letta-msb-cloud-1",
          image: "ghcr.io/letta-ai/letta-code:latest",
          backend: "cloud",
          guestPort: 4500,
          cpus: "2",
          memory: "2G",
          labels: { "letta-sandbox.managed": "true" },
          env: { LETTA_WS_TOKEN: "cap-cloud-1" },
          secret: {
            envName: "LETTA_API_KEY",
            value: "sk-let-CLOUD-SECRET",
            allowedHosts: ["api.letta.com"],
            headers: ["Authorization"],
          },
          entrypoint: "/bin/sh",
          command: ["-c", "echo hi"],
        }).build(),
      ),
    );

    expect(config.lifecycle).toMatchObject({ ephemeral: true });
    expect(config.network.ports).toEqual([]);
    expect(config.patches).toEqual([]);
    expect(config.runtime.entrypoint).toBeNull();
    expect(config.runtime.cmd).toBeNull();
    expect(config.resources).toMatchObject({ cpus: 2, memoryMib: 2048 });
    expect(config.network.secrets.secrets).toHaveLength(1);
    expect(config.network.secrets.secrets[0]).toMatchObject({
      envVar: "LETTA_API_KEY",
      allowedHosts: [{ exact: "api.letta.com" }],
    });
  });

  test("loadConfig validates cloud backend settings, defaults warmPoolSize=0, and refuses silent fallback", () => {
    // MSB_API_KEY alone does not implicitly enable cloud mode
    const localWithKey = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "microsandbox",
      MSB_API_KEY: "msb_live_key",
    });
    expect(localWithKey.sandbox.backend).toBe("local");
    expect(localWithKey.sandbox.warmPoolSize).toBe(1);
    expect(localWithKey.sandbox.memoryLimit).toBe("2G");
    expect(localWithKey.sandbox.cpuLimit).toBe("2");

    // Explicit MSB_BACKEND=cloud with MSB_API_KEY
    const cloudCfg = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "microsandbox",
      MSB_BACKEND: "cloud",
      MSB_API_KEY: "msb_live_key",
      MSB_API_URL: "https://sandbox.example.com",
      MSB_COMPUTE_TYPE: "shared",
    });
    expect(cloudCfg.sandbox.backend).toBe("cloud");
    expect(cloudCfg.sandbox.warmPoolSize).toBe(0);
    expect(cloudCfg.sandbox.memoryLimit).toBe("1G");
    expect(cloudCfg.sandbox.cpuLimit).toBe("1");
    expect(cloudCfg.sandbox.msbApiKey).toBe("msb_live_key");
    expect(cloudCfg.sandbox.msbApiUrl).toBe("https://sandbox.example.com");
    expect(cloudCfg.sandbox.msbComputeType).toBe("shared");

    // Alias MSB_BACKEND=remote with MSB_PROFILE and explicit warm pool override
    const remoteProfileCfg = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_DEVICE_ID: "dev-1",
      SANDBOX_MODE: "msb",
      MSB_BACKEND: "remote",
      MSB_PROFILE: "work",
      SANDBOX_WARM_POOL_SIZE: "2",
    });
    expect(remoteProfileCfg.sandbox.backend).toBe("cloud");
    expect(remoteProfileCfg.sandbox.msbProfile).toBe("work");
    expect(remoteProfileCfg.sandbox.warmPoolSize).toBe(2);

    // Missing both MSB_API_KEY and MSB_PROFILE fails fast without falling back to local
    expect(() =>
      loadConfig({
        LETTA_API_KEY: "test-key",
        LETTA_DEVICE_ID: "dev-1",
        SANDBOX_MODE: "microsandbox",
        MSB_BACKEND: "cloud",
      }),
    ).toThrow("Microsandbox cloud backend requires MSB_API_KEY (or MSB_PROFILE)");

    expect(() =>
      loadConfig({
        LETTA_API_KEY: "test-key",
        LETTA_DEVICE_ID: "dev-1",
        SANDBOX_MODE: "microsandbox",
        MSB_BACKEND: "bogus",
      }),
    ).toThrow("Invalid MSB_BACKEND");

    expect(() =>
      loadConfig({
        LETTA_API_KEY: "test-key",
        LETTA_DEVICE_ID: "dev-1",
        SANDBOX_MODE: "microsandbox",
        MSB_BACKEND: "cloud",
        MSB_API_KEY: "msb_live_key",
        MSB_COMPUTE_TYPE: "mega",
      }),
    ).toThrow("Invalid MSB_COMPUTE_TYPE");
  });

  test("SdkMsbRunner cloud mode skips local runtime/image/gh ops, creates Service, and removes both on cleanup", async () => {
    const events: string[] = [];
    const createdSpecs: MsbRunSpec[] = [];
    const serviceTargets: Array<{ slug: string; sandboxName: string; guestPort: number }> = [];
    const removedServices: string[] = [];
    const destroyOpts: Array<{ force?: boolean } | undefined> = [];
    const testEnv: Record<string, string | undefined> = {};

    const failingLocalRuntimeOps: SdkRuntimeOps = {
      resolveRuntime: () => {
        throw new Error("resolveRuntime must not run in cloud mode");
      },
      resolveRuntimeVersion: async () => {
        throw new Error("resolveRuntimeVersion must not run in cloud mode");
      },
      installRuntime: async () => {
        throw new Error("installRuntime must not run in cloud mode");
      },
    };
    const failingLocalImageOps: SdkImageOps = {
      isCached: async () => {
        throw new Error("imageOps.isCached must not run in cloud mode");
      },
      pull: async () => {
        throw new Error("imageOps.pull must not run in cloud mode");
      },
    };
    const failingGhOps: SdkGhBinaryOps = {
      ensureBinary: async () => {
        throw new Error("ghBinaryOps.ensureBinary must not run in cloud mode");
      },
    };

    const sandboxOps: SdkSandboxOps = {
      create: async (spec) => {
        createdSpecs.push(spec);
        events.push(`create:${spec.name}`);
        return {
          name: spec.name,
          exec: async (cmd, args) => {
            const argv = args ? Array.from(args) : [];
            events.push(`exec:${cmd}:${argv[2] ?? ""}`);
            expect(argv.slice(3)).toEqual(["/bin/sh", "-c", "exec letta server"]);
            return { code: 0, success: true, stdout: () => "", stderr: () => "" };
          },
          execDetached: async () => {
            throw new Error("execDetached is unsupported on cloud");
          },
          detach: async () => {
            events.push("detach");
          },
          destroy: async (opts) => {
            destroyOpts.push(opts);
            events.push("destroy-inline");
          },
        };
      },
      get: async (name) => ({
        destroy: async (opts) => {
          destroyOpts.push(opts);
          events.push(`destroy:${name}`);
        },
        exec: async (cmd, args) => ({
          code: 0,
          success: true,
          stdout: () => `${cmd} ${Array.from(args ?? []).join(" ")} -> letta listening`,
          stderr: () => "",
        }),
        listJobsWith: async () => ({ items: [] }),
        getJob: async () => ({ logs: async () => [] }),
        logs: async () => [],
      }),
    };

    const serviceOps: SdkServiceOps = {
      create: async (slug, sandboxName, guestPort) => {
        serviceTargets.push({ slug, sandboxName, guestPort });
        events.push(`service-create:${slug}`);
        return {
          slug,
          url: `https://${slug}.microsandbox.dev`,
          remove: async () => {
            removedServices.push(slug);
            events.push(`service-remove-inline:${slug}`);
          },
        };
      },
      get: async (slug) => ({
        slug,
        url: `https://${slug}.microsandbox.dev`,
        remove: async () => {
          removedServices.push(slug);
          events.push(`service-remove:${slug}`);
        },
      }),
    };

    const runner = new SdkMsbRunner({
      backend: "cloud",
      msbApiKey: "msb_test_key",
      msbApiUrl: "https://api.microsandbox.dev",
      msbComputeType: "shared",
      env: testEnv,
      runtimeOps: failingLocalRuntimeOps,
      imageOps: failingLocalImageOps,
      ghBinaryOps: failingGhOps,
      sandboxOps,
      serviceOps,
      makeServiceSlug: () => "lb-0123456789abcdef",
      logger: silentLogger,
    });

    await runner.ensureReady("ghcr.io/letta-ai/letta-code:latest");
    expect(testEnv.MSB_BACKEND).toBe("remote");
    expect(testEnv.MSB_API_KEY).toBe("msb_test_key");
    expect(testEnv.MSB_API_URL).toBe("https://api.microsandbox.dev");

    const runResult = await runner.runSandbox({
      name: "letta-msb-cloud-run",
      image: "ghcr.io/letta-ai/letta-code:latest",
      guestPort: 4500,
      labels: { "letta-sandbox.managed": "true" },
      env: { LETTA_WS_TOKEN: "tok-cloud" },
      entrypoint: "/bin/sh",
      command: ["-c", "exec letta server"],
    });

    expect(runResult).toEqual({
      name: "letta-msb-cloud-run",
      httpUrl: "https://lb-0123456789abcdef.microsandbox.dev",
      wsUrl: "wss://lb-0123456789abcdef.microsandbox.dev/ws",
      serviceSlug: "lb-0123456789abcdef",
      serviceUrl: "https://lb-0123456789abcdef.microsandbox.dev",
    });
    expect(createdSpecs[0]?.backend).toBe("cloud");
    expect(createdSpecs[0]?.ephemeral).toBe(true);
    expect(createdSpecs[0]?.hostPort).toBeUndefined();
    expect(createdSpecs[0]?.patches).toBeUndefined();
    expect(serviceTargets).toEqual([
      { slug: "lb-0123456789abcdef", sandboxName: "letta-msb-cloud-run", guestPort: 4500 },
    ]);

    const cloudLogs = await runner.readSandboxLogs("letta-msb-cloud-run");
    expect(cloudLogs).toContain("/tmp/letta-server.log");

    await runner.removeSandbox("letta-msb-cloud-run");
    expect(removedServices).toEqual(["lb-0123456789abcdef"]);
    expect(destroyOpts).toEqual([undefined]);
    expect(events).toEqual([
      "create:letta-msb-cloud-run",
      "exec:/bin/sh:lettabox-launch",
      "detach",
      "service-create:lb-0123456789abcdef",
      "service-remove:lb-0123456789abcdef",
      "destroy:letta-msb-cloud-run",
    ]);
  });

  test("SdkMsbRunner cloud mode destroys sandbox if Service creation fails and cleans up both even if Service.remove errors", async () => {
    let destroyedOnCreateFail = false;
    let destroyedOnRemove = false;

    const failingCreateRunner = new SdkMsbRunner({
      backend: "cloud",
      msbApiKey: "msb_test_key",
      env: {},
      sandboxOps: {
        create: async (spec) => ({
          name: spec.name,
          exec: async () => ({ code: 0, success: true, stdout: () => "", stderr: () => "" }),
          execDetached: async () => {
            throw new Error("execDetached is unsupported on cloud");
          },
          detach: async () => {},
          destroy: async () => {
            destroyedOnCreateFail = true;
          },
        }),
        get: async () => {
          throw new Error("unused");
        },
      },
      serviceOps: {
        create: async () => {
          throw new Error("service quota exceeded");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
      makeServiceSlug: () => "lb-fail-1",
      logger: silentLogger,
    });

    await expect(
      failingCreateRunner.runSandbox({
        name: "letta-msb-svc-fail",
        image: "ghcr.io/letta-ai/letta-code:latest",
        guestPort: 4500,
        labels: {},
        env: {},
        entrypoint: "/bin/sh",
        command: ["-c", "exec letta server"],
      }),
    ).rejects.toThrow("service quota exceeded");
    expect(destroyedOnCreateFail).toBe(true);

    // If Service was already removed (ServiceNotFoundError), removeSandbox still destroys sandbox cleanly
    const notFoundServiceRunner = new SdkMsbRunner({
      backend: "cloud",
      msbApiKey: "msb_test_key",
      env: {},
      sandboxOps: {
        create: async (spec) => ({
          name: spec.name,
          exec: async () => ({ code: 0, success: true, stdout: () => "", stderr: () => "" }),
          execDetached: async () => {
            throw new Error("execDetached is unsupported on cloud");
          },
          detach: async () => {},
          destroy: async () => {},
        }),
        get: async () => ({
          destroy: async () => {
            destroyedOnRemove = true;
          },
          listJobsWith: async () => ({ items: [] }),
          getJob: async () => ({ logs: async () => [] }),
          logs: async () => [],
        }),
      },
      serviceOps: {
        create: async (slug) => ({
          slug,
          url: `https://${slug}.microsandbox.dev`,
          remove: async () => {},
        }),
        get: async () => {
          throw new ServiceNotFoundError("already removed");
        },
      },
      makeServiceSlug: () => "lb-gone-1",
      logger: silentLogger,
    });

    await notFoundServiceRunner.runSandbox({
      name: "letta-msb-svc-gone",
      image: "ghcr.io/letta-ai/letta-code:latest",
      guestPort: 4500,
      labels: {},
      env: {},
    });
    await notFoundServiceRunner.removeSandbox("letta-msb-svc-gone");
    expect(destroyedOnRemove).toBe(true);
  });

  test("SdkMsbRunner cloud mode destroys sandbox if guest server launch exec fails", async () => {
    let destroyed = false;
    const runner = new SdkMsbRunner({
      backend: "cloud",
      msbApiKey: "msb_test_key",
      env: {},
      sandboxOps: {
        create: async (spec) => ({
          name: spec.name,
          exec: async () => ({
            code: 127,
            success: false,
            stdout: () => "",
            stderr: () => "letta: command not found",
          }),
          execDetached: async () => {
            throw new Error("execDetached is unsupported on cloud");
          },
          detach: async () => {},
          destroy: async () => {
            destroyed = true;
          },
        }),
        get: async () => {
          throw new Error("unused");
        },
      },
      serviceOps: {
        create: async () => {
          throw new Error("should not create service after launch failure");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
      logger: silentLogger,
    });

    await expect(
      runner.runSandbox({
        name: "letta-msb-exec-fail",
        image: "ghcr.io/letta-ai/letta-code:latest",
        guestPort: 4500,
        labels: {},
        env: {},
        entrypoint: "/bin/sh",
        command: ["-c", "exec letta server"],
      }),
    ).rejects.toThrow("(exit 127): letta: command not found");
    expect(destroyed).toBe(true);
  });

  test("MicrosandboxProvider cloud mode skips host port allocation, sends capability token + skip-warning header, and exposes serviceUrl", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    let portAllocated = false;
    const provider = new MicrosandboxProvider({
      backend: "cloud",
      image: "ghcr.io/letta-ai/letta-code:latest",
      msbApiKey: "msb_test_key",
      lettaApiKey: "sk-let-cloud-secret",
      lettaServerUrl: "https://api.letta.com",
      warmPoolSize: 0,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      allocatePort: async () => {
        portAllocated = true;
        return 49999;
      },
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    const target = await provider.acquireForConversation("conv-cloud-1");
    expect(target).toBeDefined();
    expect(portAllocated).toBe(false);
    expect(mockMsb.spawnedSpecs).toHaveLength(1);
    expect(mockMsb.spawnedSpecs[0]?.backend).toBe("cloud");
    expect(mockMsb.spawnedSpecs[0]?.ephemeral).toBe(true);
    expect(mockMsb.spawnedSpecs[0]?.hostPort).toBeUndefined();

    const [inst] = [...mockMsb.sandboxes.values()];
    expect(inst?.healthHeaders[0]?.["msb-skip-browser-warning"]).toBe("1");
    expect(inst?.healthHeaders[0]?.authorization).toBe(`Bearer ${inst?.spec.env.LETTA_WS_TOKEN}`);
    expect(inst?.wsHeaders[0]?.["msb-skip-browser-warning"]).toBe("1");
    expect(inst?.wsHeaders[0]?.authorization).toBe(`Bearer ${inst?.spec.env.LETTA_WS_TOKEN}`);

    const active = provider.listActiveSandboxes();
    expect(active).toHaveLength(1);
    expect(active[0]?.hostPort).toBeUndefined();
    expect(active[0]?.serviceUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await provider.closeAllAsync();
    expect(mockMsb.removedNames).toEqual([inst!.name]);
  });

  test("MultiplexerProxy in cloud mode registers ☁️ emoji in metadata.machine.model", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    let registeredMachineModel: string | undefined;
    const relayServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/environments/register" && req.method === "POST") {
          const body = (await req.json()) as { metadata?: { machine?: { model?: string } } };
          registeredMachineModel = body.metadata?.machine?.model;
          return Response.json({
            connectionId: "conn-cloud-1",
            wsUrl: `ws://127.0.0.1:${srv.port}/ws/relay`,
            supportsSplitStatusChannels: false,
            supportsPairedListenerGenerations: false,
          });
        }
        if (url.pathname === "/ws/relay") {
          if (srv.upgrade(req)) return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message() {},
      },
    });
    cleanups.push(() => relayServer.stop(true));

    const cpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return new Response("ok");
        if (url.pathname === "/app-server-info") {
          return Response.json({ lettaCodeVersion: "0.34.61", supported_commands: ["input"] });
        }
        if (url.pathname === "/ws") {
          if (srv.upgrade(req)) return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message() {},
      },
    });
    cleanups.push(() => cpServer.stop(true));

    const config: ProxyConfig = {
      lettaApiKey: "test-api-key",
      lettaServerUrl: `http://127.0.0.1:${relayServer.port}`,
      connectionName: "cloud-laptop",
      deviceId: "dev-cloud",
      listenerInstanceId: deriveListenerInstanceId("cloud-laptop"),
      downstreamWsUrl: `ws://127.0.0.1:${cpServer.port}/ws`,
      downstreamHttpUrl: `http://127.0.0.1:${cpServer.port}`,
      sandboxMode: "microsandbox",
      sandbox: {
        backend: "cloud",
        image: "ghcr.io/letta-ai/letta-code:latest",
        containerPort: 4500,
        idleTimeoutMs: 60_000,
        reaperIntervalMs: 60_000,
        startTimeoutMs: 5_000,
        memoryLimit: "2G",
        cpuLimit: "2",
        warmPoolSize: 0,
        msbSecretInjection: true,
        msbApiKey: "msb_test_key",
        autoConversationTitles: true,
      },
      workerWsUrls: [],
      heartbeatIntervalMs: 30_000,
      heartbeatMaxMissed: 3,
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 100,
      downstreamReadyTimeoutMs: 5_000,
      debugFrames: false,
    };

    let readyResolved = false;
    const readyPromise = new Promise<void>((resolve) => {
      const proxy = new MultiplexerProxy({
        config,
        msb: mockMsb.runner,
        logger: silentLogger,
        onUpstreamReady: () => {
          readyResolved = true;
          resolve();
        },
      });
      cleanups.push(() => proxy.stopAsync());
      void proxy.start();
    });

    await readyPromise;
    expect(readyResolved).toBe(true);
    expect(registeredMachineModel?.startsWith("☁️ ")).toBe(true);
    expect(registeredMachineModel).not.toContain("Microsandbox Cloud");
  });

  test("SdkMsbRunner cloud mode cleans up orphaned sandbox when create() times out, but skips cleanup on CloudHttpError", async () => {
    const destroyedNames: string[] = [];

    const timeoutRunner = new SdkMsbRunner({
      backend: "cloud",
      msbApiKey: "msb_test_key",
      env: {},
      sandboxOps: {
        create: async (spec) => {
          throw new RuntimeError(
            `cloud sandbox "${spec.name}" did not reach running before the readiness wait expired`,
          );
        },
        get: async (name) => ({
          destroy: async () => {
            destroyedNames.push(name);
          },
          listJobsWith: async () => ({ items: [] }),
          getJob: async () => ({ logs: async () => [] }),
          logs: async () => [],
        }),
      },
      serviceOps: {
        create: async () => {
          throw new Error("unused");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
      logger: silentLogger,
    });

    await expect(
      timeoutRunner.runSandbox({
        name: "letta-msb-orphan-1",
        image: "ghcr.io/letta-ai/letta-code:latest",
        guestPort: 4500,
        labels: {},
        env: {},
      }),
    ).rejects.toThrow("did not reach running");
    expect(destroyedNames).toEqual(["letta-msb-orphan-1"]);

    let getCalled = false;
    const httpErrRunner = new SdkMsbRunner({
      backend: "cloud",
      msbApiKey: "msb_test_key",
      env: {},
      sandboxOps: {
        create: async () => {
          throw new CloudHttpError("concurrent running sandbox limit reached");
        },
        get: async () => {
          getCalled = true;
          throw new Error("should not call get after CloudHttpError");
        },
      },
      serviceOps: {
        create: async () => {
          throw new Error("unused");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
      logger: silentLogger,
    });

    await expect(
      httpErrRunner.runSandbox({
        name: "letta-msb-403-1",
        image: "ghcr.io/letta-ai/letta-code:latest",
        guestPort: 4500,
        labels: {},
        env: {},
      }),
    ).rejects.toThrow("concurrent running sandbox limit reached");
    expect(getCalled).toBe(false);
  });

  test("MicrosandboxProvider cloud mode enforces exponential backoff after failed spawns", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    let clock = 1_000_000;
    let attempts = 0;
    const origRun = mockMsb.runner.runSandbox.bind(mockMsb.runner);
    mockMsb.runner.runSandbox = async (spec) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("concurrent running sandbox limit reached");
      }
      return origRun(spec);
    };

    const provider = new MicrosandboxProvider({
      backend: "cloud",
      image: "ghcr.io/letta-ai/letta-code:latest",
      msbApiKey: "msb_test_key",
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      spawnFailureCooldownMs: 2_000,
      idleTimeoutMs: 60_000,
      reaperIntervalMs: 60_000,
      msb: mockMsb.runner,
      now: () => clock,
      logger: silentLogger,
      onMessage: () => {},
    });
    cleanups.push(() => provider.closeAllAsync());

    await expect(provider.acquireForConversation("conv-backoff")).rejects.toThrow(
      "concurrent running sandbox limit reached",
    );
    expect(attempts).toBe(1);

    // Immediate retry during cooldown fails fast without hitting runSandbox again
    clock += 500;
    await expect(provider.acquireForConversation("conv-backoff")).rejects.toThrow(
      "in backoff for 1500ms",
    );
    expect(attempts).toBe(1);

    // Once cooldown expires, spawn retries and succeeds
    clock += 1_500;
    const target = await provider.acquireForConversation("conv-backoff");
    expect(target).toBeDefined();
    expect(attempts).toBe(2);
  });
});

describe("Guest autoConversationTitles bootstrap seeding", () => {
  async function runBootstrapWithFakeLetta(options: {
    script: string;
    homeDir: string;
    lettaConfigDir?: string;
    token?: string;
    port?: number;
  }): Promise<{
    exitCode: number;
    args: string[];
    env: Record<string, string | undefined>;
    tokenFileContent: string;
    stderr: string;
  }> {
    const binDir = mkdtempSync(join(tmpdir(), "lettabox-fake-letta-"));
    const argsPath = join(binDir, "args.txt");
    const envPath = join(binDir, "env.txt");
    const tokenCopyPath = join(binDir, "token.txt");
    cleanups.push(() => rmSync(binDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync("/tmp/letta-ws-token", { force: true }));

    symlinkSync(process.execPath, join(binDir, "bun"));

    const fakeLettaPath = join(binDir, "letta");
    writeFileSync(
      fakeLettaPath,
      `#!/bin/sh
: > ${JSON.stringify(argsPath)}
for arg in "$@"; do
  printf '%s\\n' "$arg" >> ${JSON.stringify(argsPath)}
done
{
  printf 'LETTA_WS_TOKEN=%s\\n' "\${LETTA_WS_TOKEN+set}"
  printf 'LETTA_SETTINGS_PATH=%s\\n' "\${LETTA_SETTINGS_PATH+set}"
  printf '_lb_dir=%s\\n' "\${_lb_dir+set}"
  printf '_lb_settings=%s\\n' "\${_lb_settings+set}"
} > ${JSON.stringify(envPath)}
if [ -f /tmp/letta-ws-token ]; then
  cp /tmp/letta-ws-token ${JSON.stringify(tokenCopyPath)}
fi
`,
      "utf8",
    );
    chmodSync(fakeLettaPath, 0o755);

    // Isolate PATH from host version-manager shims (e.g. mise/asdf/volta/nvm)
    // whose lookup can stall when HOME is overridden to an empty temp directory.
    const env: Record<string, string> = {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: options.homeDir,
      LETTA_WS_TOKEN: options.token ?? "test-cap-token-123",
      LETTA_LISTEN_PORT: String(options.port ?? 4500),
    };
    if (options.lettaConfigDir !== undefined) {
      env.LETTA_CONFIG_DIR = options.lettaConfigDir;
    }

    const proc = Bun.spawn(["/bin/sh", "-c", options.script], {
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const argsRaw = readFileSync(argsPath, "utf8");
    const args = argsRaw.length > 0 ? argsRaw.replace(/\n$/, "").split("\n") : [];
    const envMap: Record<string, string | undefined> = {};
    for (const line of readFileSync(envPath, "utf8").trim().split("\n")) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx);
      const val = line.slice(idx + 1);
      envMap[key] = val.length > 0 ? val : undefined;
    }
    const tokenFileContent = existsSync(tokenCopyPath) ? readFileSync(tokenCopyPath, "utf8") : "";
    return {
      exitCode,
      args,
      env: envMap,
      tokenFileContent,
      stderr,
    };
  }

  test("seeds ~/.letta/settings.json on fresh microVM without leaking bootstrap vars", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lettabox-home-fresh-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

    const result = await runBootstrapWithFakeLetta({
      script: buildMsbBootstrapScript(),
      homeDir,
      token: "fresh-token-abc",
      port: 4612,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.args).toEqual([
      "server",
      "--listen",
      "ws://0.0.0.0:4612",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/tmp/letta-ws-token",
    ]);
    expect(result.tokenFileContent).toBe("fresh-token-abc\n");
    expect(result.env.LETTA_WS_TOKEN).toBeUndefined();
    expect(result.env.LETTA_SETTINGS_PATH).toBeUndefined();
    expect(result.env._lb_dir).toBeUndefined();
    expect(result.env._lb_settings).toBeUndefined();

    const lettaDir = join(homeDir, ".letta");
    const settingsPath = join(lettaDir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      autoConversationTitles: true,
      autoConversationTitlesRollbackApplied: true,
    });
    expect(statSync(lettaDir).mode & 0o777).toBe(0o700);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  test("merges into existing ~/.letta/settings.json while preserving unrelated keys", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lettabox-home-merge-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

    const lettaDir = join(homeDir, ".letta");
    mkdirSync(lettaDir, { recursive: true });
    const settingsPath = join(lettaDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        tokenStreaming: true,
        autoConversationTitles: false,
        recentModels: ["claude-sonnet"],
      }),
      "utf8",
    );

    const result = await runBootstrapWithFakeLetta({
      script: buildMsbBootstrapScript({ autoConversationTitles: true }),
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      tokenStreaming: true,
      autoConversationTitles: true,
      autoConversationTitlesRollbackApplied: true,
      recentModels: ["claude-sonnet"],
    });
  });

  test("recovers cleanly when existing settings.json is malformed or non-object JSON", async () => {
    for (const raw of ["{not-valid-json", "[]", "null"]) {
      const homeDir = mkdtempSync(join(tmpdir(), "lettabox-home-corrupt-"));
      cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

      const lettaDir = join(homeDir, ".letta");
      mkdirSync(lettaDir, { recursive: true });
      const settingsPath = join(lettaDir, "settings.json");
      writeFileSync(settingsPath, raw, "utf8");

      const result = await runBootstrapWithFakeLetta({
        script: buildMsbBootstrapScript({ autoConversationTitles: true }),
        homeDir,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
        autoConversationTitles: true,
        autoConversationTitlesRollbackApplied: true,
      });
    }
  });

  test("respects LETTA_CONFIG_DIR when set", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lettabox-home-cfgdir-"));
    const customConfigDir = join(homeDir, "custom-letta-config");
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

    const result = await runBootstrapWithFakeLetta({
      script: buildMsbBootstrapScript({ autoConversationTitles: true }),
      homeDir,
      lettaConfigDir: customConfigDir,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(homeDir, ".letta", "settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(customConfigDir, "settings.json"), "utf8"))).toEqual({
      autoConversationTitles: true,
      autoConversationTitlesRollbackApplied: true,
    });
  });

  test("leaves ~/.letta/settings.json untouched when autoConversationTitles is false", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lettabox-home-disabled-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

    const result = await runBootstrapWithFakeLetta({
      script: buildMsbBootstrapScript({ autoConversationTitles: false }),
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(homeDir, ".letta", "settings.json"))).toBe(false);
  });

  test("MicrosandboxProvider wires autoConversationTitles for both local and cloud backends", async () => {
    for (const backend of ["local", "cloud"] as const) {
      for (const enabled of [true, false]) {
        const mockMsb = createMockMsbRunner();
        cleanups.push(() => mockMsb.cleanupAll());

        const provider = new MicrosandboxProvider({
          backend,
          image: "ghcr.io/letta-ai/letta-code:latest",
          msbApiKey: backend === "cloud" ? "msb_test_key" : undefined,
          lettaApiKey: "test-key",
          lettaServerUrl: "https://api.letta.com",
          autoConversationTitles: enabled,
          idleTimeoutMs: 60_000,
          reaperIntervalMs: 60_000,
          msb: mockMsb.runner,
          logger: silentLogger,
          onMessage: () => {},
        });
        cleanups.push(() => provider.closeAllAsync());

        await provider.acquireForConversation(`conv-${backend}-${enabled}`);
        expect(mockMsb.spawnedSpecs).toHaveLength(1);
        expect(mockMsb.spawnedSpecs[0]?.entrypoint).toBe("/bin/sh");
        expect(mockMsb.spawnedSpecs[0]?.command).toEqual([
          "-c",
          buildMsbBootstrapScript({ autoConversationTitles: enabled }),
        ]);
      }
    }
  });

  test("MultiplexerProxy forwards sandbox.autoConversationTitles=false to MicrosandboxProvider", async () => {
    const mockMsb = createMockMsbRunner();
    cleanups.push(() => mockMsb.cleanupAll());

    const cpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return new Response("ok");
        if (url.pathname === "/app-server-info") {
          return Response.json({ lettaCodeVersion: "0.34.70", supported_commands: ["input"] });
        }
        if (url.pathname === "/ws" && server.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: { message() {} },
    });
    cleanups.push(() => cpServer.stop(true));

    const relayServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/environments/register") {
          return Response.json({
            connectionId: "conn-auto-titles",
            wsUrl: `ws://127.0.0.1:${server.port}/ws`,
            supportsSplitStatusChannels: false,
            supportsPairedListenerGenerations: false,
          });
        }
        if (url.pathname === "/ws" && server.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "listener_ready" }));
        },
        message() {},
      },
    });
    cleanups.push(() => relayServer.stop(true));

    const config = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_SERVER_URL: `http://127.0.0.1:${relayServer.port}`,
      LETTA_DEVICE_ID: "dev-auto-titles",
      CONTROL_PLANE_URL: `ws://127.0.0.1:${cpServer.port}/ws`,
      SANDBOX_MODE: "microsandbox",
      SANDBOX_WARM_POOL_SIZE: "1",
      SANDBOX_AUTO_CONVERSATION_TITLES: "false",
    });

    const proxy = new MultiplexerProxy({
      config,
      msb: mockMsb.runner,
      logger: silentLogger,
    });
    cleanups.push(() => proxy.stopAsync());

    await proxy.start();
    expect(mockMsb.spawnedSpecs).toHaveLength(1);
    expect(mockMsb.spawnedSpecs[0]?.command).toEqual([
      "-c",
      buildMsbBootstrapScript({ autoConversationTitles: false }),
    ]);
  });
});
