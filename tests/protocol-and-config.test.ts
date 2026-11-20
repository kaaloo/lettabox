import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveListenerInstanceId,
  loadConfig,
  loadOrCreateDeviceId,
  toHttpBaseUrl,
} from "../src/config.ts";
import {
  parseJsonObject,
  selectUpstreamChannel,
  STREAM_CHANNEL_MESSAGE_TYPES,
  summarizeFrame,
} from "../src/protocol.ts";
import { buildUpstreamWsUrl } from "../src/upstream.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-sandbox-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("protocol helpers", () => {
  test("selectUpstreamChannel routes exactly the 5 stream types when split channels enabled", () => {
    for (const type of [
      "stream_delta",
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]) {
      expect(STREAM_CHANNEL_MESSAGE_TYPES.has(type)).toBe(true);
      expect(selectUpstreamChannel(type, true)).toBe("stream");
      expect(selectUpstreamChannel(type, false)).toBe("control");
    }

    for (const type of [
      "input_accepted",
      "runtime_start_response",
      "control_request",
      "some_future_event",
      undefined,
    ]) {
      expect(selectUpstreamChannel(type, true)).toBe("control");
      expect(selectUpstreamChannel(type, false)).toBe("control");
    }
  });

  test("summarizeFrame extracts routing envelope fields safely", () => {
    const frame = parseJsonObject(
      JSON.stringify({
        type: "stream_delta",
        request_id: "req-1",
        runtime: { agent_id: "ag-1", conversation_id: "conv-42" },
        event_seq: 7,
      }),
    );
    expect(summarizeFrame(frame)).toBe("type=stream_delta req=req-1 conv=conv-42 seq=7");
    expect(summarizeFrame(parseJsonObject("not json"))).toBe("<non-json>");
  });
});

describe("config & URL helpers", () => {
  test("deriveListenerInstanceId produces deterministic server-<16 hex>", () => {
    const id1 = deriveListenerInstanceId("my-vps");
    const id2 = deriveListenerInstanceId("my-vps");
    const id3 = deriveListenerInstanceId("other-vps");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^server-[0-9a-f]{16}$/);
  });

  test("toHttpBaseUrl converts ws/wss URLs to http/https origins", () => {
    expect(toHttpBaseUrl("ws://127.0.0.1:4500/ws")).toBe("http://127.0.0.1:4500");
    expect(toHttpBaseUrl("wss://sandbox.example.com:8443/ws?foo=1")).toBe(
      "https://sandbox.example.com:8443",
    );
  });

  test("loadOrCreateDeviceId persists and reuses UUID", () => {
    const dir = makeTempDir();
    const file = join(dir, "nested", "device-id");
    const first = loadOrCreateDeviceId(file);
    const second = loadOrCreateDeviceId(file);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(10);
  });

  test("loadConfig validates LETTA_API_KEY and reads token file", () => {
    expect(() => loadConfig({})).toThrow("LETTA_API_KEY is required");

    const dir = makeTempDir();
    const tokenFile = join(dir, "ws-token");
    writeFileSync(tokenFile, "cap-token-123\n", "utf8");
    const deviceFile = join(dir, "device-id");

    const cfg = loadConfig({
      LETTA_API_KEY: "test-key",
      LETTA_SERVER_URL: "https://api.letta.com/",
      LETTA_CONNECTION_NAME: "vps-prod",
      LETTA_DEVICE_ID_FILE: deviceFile,
      DOWNSTREAM_URL: "ws://127.0.0.1:4500/ws",
      DOWNSTREAM_WS_TOKEN_FILE: tokenFile,
      DEBUG_FRAMES: "true",
    });

    expect(cfg.lettaServerUrl).toBe("https://api.letta.com");
    expect(cfg.downstreamHttpUrl).toBe("http://127.0.0.1:4500");
    expect(cfg.downstreamWsToken).toBe("cap-token-123");
    expect(cfg.listenerInstanceId).toBe(deriveListenerInstanceId("vps-prod"));
    expect(cfg.debugFrames).toBe(true);
  });

  test("buildUpstreamWsUrl attaches query params correctly", () => {
    const url = new URL(
      buildUpstreamWsUrl("wss://relay.letta.com/ws", {
        deviceId: "dev-1",
        connectionName: "vps-1",
        channel: "control",
        connectionGeneration: "gen-uuid",
        connectionAttempt: 2,
      }),
    );
    expect(url.searchParams.get("deviceId")).toBe("dev-1");
    expect(url.searchParams.get("connectionName")).toBe("vps-1");
    expect(url.searchParams.get("channel")).toBe("control");
    expect(url.searchParams.get("connectionGeneration")).toBe("gen-uuid");
    expect(url.searchParams.get("connectionAttempt")).toBe("2");
  });
});
