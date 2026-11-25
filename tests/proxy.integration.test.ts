import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { ProxyConfig } from "../src/config.ts";
import { deriveListenerInstanceId } from "../src/config.ts";
import { PassthroughProxy } from "../src/proxy.ts";

interface DownstreamWsData {
  auth: string | null;
}

interface RelayWsData {
  channel: string | null;
  deviceId: string | null;
  connectionName: string | null;
  generation: string | null;
  attempt: string | null;
  auth: string | null;
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 15,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function createMockDownstream(options: { expectedToken?: string } = {}) {
  const received: string[] = [];
  let activeSocket: ServerWebSocket<DownstreamWsData> | null = null;

  const server: Server<DownstreamWsData> = Bun.serve<DownstreamWsData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/app-server-info") {
        if (
          options.expectedToken &&
          req.headers.get("authorization") !== `Bearer ${options.expectedToken}`
        ) {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({
          lettaCodeVersion: "0.99.0-test",
          supported_commands: ["runtime_start", "input", "abort_message"],
        });
      }
      if (url.pathname === "/ws" || url.pathname === "/") {
        if (url.searchParams.has("channel")) {
          return new Response("Split channels not supported", { status: 426 });
        }
        const auth = req.headers.get("authorization");
        if (options.expectedToken && auth !== `Bearer ${options.expectedToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const ok = srv.upgrade(req, { data: { auth } });
        if (ok) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        activeSocket = ws;
      },
      message(_ws, msg) {
        received.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      },
      close(ws) {
        if (activeSocket === ws) activeSocket = null;
      },
    },
  });

  return {
    server,
    httpUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    received,
    sendToProxy(frame: Record<string, unknown>) {
      if (!activeSocket) throw new Error("Downstream socket not connected");
      activeSocket.send(JSON.stringify(frame));
    },
    stop() {
      server.stop(true);
    },
  };
}

function createMockRelay(options: {
  expectedApiKey: string;
  supportsSplitStatusChannels?: boolean;
  supportsPairedListenerGenerations?: boolean;
  autoPong?: boolean;
  autoListenerReady?: boolean;
}) {
  const supportsSplit = options.supportsSplitStatusChannels ?? true;
  const supportsPaired = options.supportsPairedListenerGenerations ?? true;
  let autoPong = options.autoPong ?? true;
  const autoListenerReady = options.autoListenerReady ?? true;

  const registrations: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const controlMessages: string[] = [];
  const streamMessages: string[] = [];
  const connections: Array<{
    channel: string | null;
    generation: string | null;
    attempt: string | null;
    openedAt: number;
  }> = [];
  let controlPings = 0;
  let streamPings = 0;
  let controlWs: ServerWebSocket<RelayWsData> | null = null;
  let streamWs: ServerWebSocket<RelayWsData> | null = null;

  const server: Server<RelayWsData> = Bun.serve<RelayWsData>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/environments/register" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${options.expectedApiKey}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = (await req.json()) as Record<string, unknown>;
        registrations.push({
          headers: {
            authorization: auth ?? "",
            "x-letta-source": req.headers.get("x-letta-source") ?? "",
          },
          body,
        });
        return Response.json({
          connectionId: `conn-${registrations.length}`,
          wsUrl: `ws://127.0.0.1:${srv.port}/relay`,
          supportsSplitStatusChannels: supportsSplit,
          supportsPairedListenerGenerations: supportsPaired,
        });
      }

      if (url.pathname === "/relay") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${options.expectedApiKey}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const ok = srv.upgrade(req, {
          data: {
            channel: url.searchParams.get("channel"),
            deviceId: url.searchParams.get("deviceId"),
            connectionName: url.searchParams.get("connectionName"),
            generation: url.searchParams.get("connectionGeneration"),
            attempt: url.searchParams.get("connectionAttempt"),
            auth,
          },
        });
        if (ok) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connections.push({
          channel: ws.data.channel,
          generation: ws.data.generation,
          attempt: ws.data.attempt,
          openedAt: Date.now(),
        });
        if (ws.data.channel === "stream") {
          streamWs = ws;
        } else {
          controlWs = ws;
          if (supportsSplit && supportsPaired && autoListenerReady) {
            ws.send(
              JSON.stringify({
                type: "listener_ready",
                connection_generation: ws.data.generation,
                connection_attempt: ws.data.attempt ? Number(ws.data.attempt) : undefined,
              }),
            );
          }
        }
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
        try {
          const parsed = JSON.parse(text) as { type?: string };
          if (parsed.type === "ping") {
            if (ws.data.channel === "stream") {
              streamPings += 1;
            } else {
              controlPings += 1;
            }
            if (autoPong) {
              ws.send(JSON.stringify({ type: "pong" }));
            }
            return;
          }
        } catch {
          // non-JSON
        }
        if (ws.data.channel === "stream") {
          streamMessages.push(text);
        } else {
          controlMessages.push(text);
        }
      },
      close(ws) {
        if (controlWs === ws) controlWs = null;
        if (streamWs === ws) streamWs = null;
      },
    },
  });

  return {
    server,
    httpUrl: `http://127.0.0.1:${server.port}`,
    registrations,
    connections,
    controlMessages,
    streamMessages,
    get controlPings() {
      return controlPings;
    },
    get streamPings() {
      return streamPings;
    },
    setAutoPong(value: boolean) {
      autoPong = value;
    },
    sendOnControl(frame: Record<string, unknown>) {
      if (!controlWs) throw new Error("Control socket not connected");
      controlWs.send(JSON.stringify(frame));
    },
    closeControl(code: number, reason: string) {
      controlWs?.close(code, reason);
    },
    stop() {
      server.stop(true);
    },
  };
}

function makeConfig(
  relayHttpUrl: string,
  downstream: { httpUrl: string; wsUrl: string },
  overrides: Partial<ProxyConfig> = {},
): ProxyConfig {
  const connectionName = "test-vps";
  return {
    lettaApiKey: "test-api-key",
    lettaServerUrl: relayHttpUrl,
    connectionName,
    deviceId: "device-uuid-1",
    listenerInstanceId: deriveListenerInstanceId(connectionName),
    downstreamWsUrl: downstream.wsUrl,
    downstreamHttpUrl: downstream.httpUrl,
    sandboxMode: "static",
    sandbox: {
      backend: "local",
      image: "ghcr.io/letta-ai/letta-code:latest",
      containerPort: 4500,
      idleTimeoutMs: 900_000,
      reaperIntervalMs: 30_000,
      startTimeoutMs: 5_000,
      memoryLimit: "1G",
      cpuLimit: "1",
      msbSecretInjection: true,
    },
    workerWsUrls: [],
    heartbeatIntervalMs: 30_000,
    heartbeatMaxMissed: 3,
    reconnectBaseDelayMs: 30,
    reconnectMaxDelayMs: 100,
    downstreamReadyTimeoutMs: 5_000,
    debugFrames: false,
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

describe("PassthroughProxy integration", () => {
  test("paired-generation handshake, opaque passthrough, and split-channel routing", async () => {
    const downstream = createMockDownstream({
      expectedToken: "secret-cap-token",
    });
    const relay = createMockRelay({
      expectedApiKey: "test-api-key",
      supportsSplitStatusChannels: true,
      supportsPairedListenerGenerations: true,
    });
    cleanups.push(
      () => downstream.stop(),
      () => relay.stop(),
    );

    let readyCount = 0;
    const proxy = new PassthroughProxy({
      config: makeConfig(relay.httpUrl, downstream, {
        downstreamWsToken: "secret-cap-token",
      }),
      logger: silentLogger,
      onUpstreamReady: () => {
        readyCount += 1;
      },
    });
    cleanups.push(() => proxy.stop());

    await proxy.start();
    await waitFor(() => readyCount === 1);

    // Registration payload check
    expect(relay.registrations).toHaveLength(1);
    const reg = relay.registrations[0]!;
    expect(reg.headers["x-letta-source"]).toBe("letta-code");
    expect(reg.body.deviceId).toBe("device-uuid-1");
    expect(reg.body.connectionName).toBe("test-vps");
    const metadata = reg.body.metadata as Record<string, unknown>;
    expect(metadata.lettaCodeVersion).toBe("0.99.0-test");
    expect(metadata.environmentMessageProtocol).toBe("v2-input");
    expect(metadata.supported_commands).toEqual(["runtime_start", "input", "abort_message"]);

    // Paired generation check: control opened first, stream opened with identical generation & attempt
    expect(relay.connections).toHaveLength(2);
    expect(relay.connections[0]!.channel).toBe("control");
    expect(relay.connections[1]!.channel).toBe("stream");
    expect(relay.connections[0]!.generation).toBeTruthy();
    expect(relay.connections[1]!.generation).toBe(relay.connections[0]!.generation);
    expect(relay.connections[0]!.attempt).toBe("1");
    expect(relay.connections[1]!.attempt).toBe("1");

    // Upstream -> Downstream opaque forwarding (including unknown future command)
    const inboundFrames = [
      { type: "runtime_start", request_id: "r1", conversation_id: "c1" },
      {
        type: "input",
        request_id: "r2",
        runtime: { agent_id: "a1", conversation_id: "c1" },
        text: "hello",
      },
      {
        type: "brand_new_future_cmd",
        request_id: "r3",
        custom_field: { nested: true },
      },
    ];
    for (const f of inboundFrames) {
      relay.sendOnControl(f);
    }
    await waitFor(() => downstream.received.length === inboundFrames.length);
    expect(downstream.received.map((s) => JSON.parse(s))).toEqual(inboundFrames);

    // Downstream -> Upstream split-channel routing
    const controlExpected = [
      { type: "input_accepted", request_id: "r2", accepted: true },
      {
        type: "runtime_start_response",
        request_id: "r1",
        runtime: { conversation_id: "c1" },
      },
      { type: "unknown_future_response", request_id: "r3", ok: true },
    ];
    const streamExpected = [
      { type: "stream_delta", event_seq: 1, delta: "hi" },
      { type: "update_device_status", event_seq: 2, status: "ready" },
      { type: "update_loop_status", event_seq: 3, status: "running" },
      { type: "update_queue", event_seq: 4, items: [] },
      { type: "update_subagent_state", event_seq: 5, state: "idle" },
    ];

    for (const f of [...controlExpected, ...streamExpected]) {
      downstream.sendToProxy(f);
    }

    await waitFor(
      () =>
        relay.controlMessages.length === controlExpected.length &&
        relay.streamMessages.length === streamExpected.length,
    );

    expect(relay.controlMessages.map((s) => JSON.parse(s))).toEqual(controlExpected);
    expect(relay.streamMessages.map((s) => JSON.parse(s))).toEqual(streamExpected);
  });

  test("app-level heartbeat swallows pong and reconnects after missed pongs", async () => {
    const downstream = createMockDownstream();
    const relay = createMockRelay({
      expectedApiKey: "test-api-key",
      autoPong: true,
    });
    cleanups.push(
      () => downstream.stop(),
      () => relay.stop(),
    );

    let readyCount = 0;
    const proxy = new PassthroughProxy({
      config: makeConfig(relay.httpUrl, downstream, {
        heartbeatIntervalMs: 30,
        heartbeatMaxMissed: 2,
      }),
      logger: silentLogger,
      onUpstreamReady: () => {
        readyCount += 1;
      },
    });
    cleanups.push(() => proxy.stop());

    await proxy.start();
    await waitFor(() => readyCount === 1);

    // Wait for at least 1 ping/pong cycle on both sockets
    await waitFor(() => relay.controlPings >= 1 && relay.streamPings >= 1);
    // Pongs must never leak downstream
    expect(downstream.received).toHaveLength(0);

    // Stop answering pongs -> proxy should time out and reconnect (attempt 2)
    relay.setAutoPong(false);
    await waitFor(() => readyCount >= 2, 3_000);
    expect(relay.connections.some((c) => c.attempt === "2")).toBe(true);
    expect(downstream.received).toHaveLength(0);
  });

  test("close 1008 'Environment not found' triggers re-registration", async () => {
    const downstream = createMockDownstream();
    const relay = createMockRelay({ expectedApiKey: "test-api-key" });
    cleanups.push(
      () => downstream.stop(),
      () => relay.stop(),
    );

    let readyCount = 0;
    let disconnectCount = 0;
    const proxy = new PassthroughProxy({
      config: makeConfig(relay.httpUrl, downstream),
      logger: silentLogger,
      onUpstreamReady: () => {
        readyCount += 1;
      },
      onUpstreamDisconnect: () => {
        disconnectCount += 1;
      },
    });
    cleanups.push(() => proxy.stop());

    await proxy.start();
    await waitFor(() => readyCount === 1);
    expect(relay.registrations).toHaveLength(1);
    expect(disconnectCount).toBe(0);

    relay.closeControl(1008, "Environment not found");
    await waitFor(() => readyCount === 2, 3_000);
    expect(disconnectCount).toBeGreaterThanOrEqual(1);
    expect(relay.registrations).toHaveLength(2);
  });

  test("close 1000 'Replaced by new connection' is terminal and does not reconnect", async () => {
    const downstream = createMockDownstream();
    const relay = createMockRelay({ expectedApiKey: "test-api-key" });
    cleanups.push(
      () => downstream.stop(),
      () => relay.stop(),
    );

    let readyCount = 0;
    const terminalReasons: string[] = [];
    const proxy = new PassthroughProxy({
      config: makeConfig(relay.httpUrl, downstream),
      logger: silentLogger,
      onUpstreamReady: () => {
        readyCount += 1;
      },
      onTerminalClose: (reason) => {
        terminalReasons.push(reason);
      },
    });
    cleanups.push(() => proxy.stop());

    await proxy.start();
    await waitFor(() => readyCount === 1);

    relay.closeControl(1000, "Replaced by new connection");
    await waitFor(() => terminalReasons.length === 1);
    expect(terminalReasons).toEqual(["Replaced by new connection"]);

    const connCountAfterClose = relay.connections.length;
    await Bun.sleep(150);
    expect(relay.connections.length).toBe(connCountAfterClose);
    expect(readyCount).toBe(1);
  });

  test("single-socket fallback when supportsSplitStatusChannels is false", async () => {
    const downstream = createMockDownstream();
    const relay = createMockRelay({
      expectedApiKey: "test-api-key",
      supportsSplitStatusChannels: false,
      supportsPairedListenerGenerations: false,
    });
    cleanups.push(
      () => downstream.stop(),
      () => relay.stop(),
    );

    let readyCount = 0;
    const proxy = new PassthroughProxy({
      config: makeConfig(relay.httpUrl, downstream),
      logger: silentLogger,
      onUpstreamReady: () => {
        readyCount += 1;
      },
    });
    cleanups.push(() => proxy.stop());

    await proxy.start();
    await waitFor(() => readyCount === 1);

    expect(relay.connections).toHaveLength(1);
    expect(relay.connections[0]!.channel).toBeNull();

    downstream.sendToProxy({
      type: "stream_delta",
      event_seq: 1,
      delta: "single-socket",
    });
    await waitFor(() => relay.controlMessages.length === 1);
    expect(JSON.parse(relay.controlMessages[0]!)).toEqual({
      type: "stream_delta",
      event_seq: 1,
      delta: "single-socket",
    });
  });

  test("multiplexes control-plane and multiple worker servers with event_seq rewriting", async () => {
    const controlPlane = createMockDownstream();
    const worker1 = createMockDownstream();
    const worker2 = createMockDownstream();
    const relay = createMockRelay({
      expectedApiKey: "test-api-key",
      supportsSplitStatusChannels: true,
      supportsPairedListenerGenerations: true,
    });
    cleanups.push(
      () => controlPlane.stop(),
      () => worker1.stop(),
      () => worker2.stop(),
      () => relay.stop(),
    );

    let readyCount = 0;
    const proxy = new PassthroughProxy({
      config: makeConfig(relay.httpUrl, controlPlane, {
        workerWsUrls: [worker1.wsUrl, worker2.wsUrl],
      }),
      logger: silentLogger,
      onUpstreamReady: () => {
        readyCount += 1;
      },
    });
    cleanups.push(() => proxy.stop());

    await proxy.start();
    await waitFor(() => readyCount === 1);

    // 1. Control-plane frames: default sync, list_models, stateless conversation_messages_list
    relay.sendOnControl({
      type: "sync",
      runtime: { agent_id: null, conversation_id: "default" },
    });
    relay.sendOnControl({ type: "list_models", request_id: "req-models" });
    relay.sendOnControl({
      type: "conversation_messages_list",
      request_id: "req-history",
      conversation_id: "conv-a",
    });

    await waitFor(() => controlPlane.received.length === 3);
    expect(worker1.received).toHaveLength(0);
    expect(worker2.received).toHaveLength(0);

    // 2. Conversation A -> worker-1, Conversation B -> worker-2
    relay.sendOnControl({
      type: "runtime_start",
      request_id: "req-start-a",
      conversation_id: "conv-a",
    });
    relay.sendOnControl({
      type: "input",
      request_id: "req-in-a",
      runtime: { agent_id: "ag-1", conversation_id: "conv-a" },
      text: "hi worker 1",
    });
    relay.sendOnControl({
      type: "sync",
      runtime: { agent_id: "ag-1", conversation_id: "conv-b" },
    });
    relay.sendOnControl({
      type: "input",
      request_id: "req-in-b",
      runtime: { agent_id: "ag-1", conversation_id: "conv-b" },
      text: "hi worker 2",
    });

    await waitFor(() => worker1.received.length === 2 && worker2.received.length === 2);
    expect(controlPlane.received).toHaveLength(3);
    expect(worker1.received.map((s) => JSON.parse(s).type)).toEqual(["runtime_start", "input"]);
    expect(worker2.received.map((s) => JSON.parse(s).type)).toEqual(["sync", "input"]);

    // 3. Worker-1 sends control_request -> upstream replies control_response -> routes back to worker-1
    worker1.sendToProxy({
      type: "control_request",
      request_id: "perm-1",
      tool: "bash",
    });
    await waitFor(() => relay.controlMessages.length === 1);
    relay.sendOnControl({
      type: "control_response",
      request_id: "perm-1",
      approved: true,
    });
    await waitFor(() => worker1.received.length === 3);
    expect(JSON.parse(worker1.received[2]!)).toEqual({
      type: "control_response",
      request_id: "perm-1",
      approved: true,
    });
    expect(worker2.received).toHaveLength(2);

    // 4. Interleaved local event_seq (1, 1, 1, 2) from all 3 servers -> monotonic (1, 2, 3, 4) upstream
    controlPlane.sendToProxy({
      type: "update_device_status",
      event_seq: 1,
      src: "cp",
    });
    worker1.sendToProxy({ type: "stream_delta", event_seq: 1, src: "w1" });
    worker2.sendToProxy({ type: "stream_delta", event_seq: 1, src: "w2" });
    worker1.sendToProxy({ type: "stream_delta", event_seq: 2, src: "w1-2" });

    await waitFor(() => relay.streamMessages.length === 4);
    const seqs = relay.streamMessages.map(
      (s) => (JSON.parse(s) as { event_seq: number }).event_seq,
    );
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
