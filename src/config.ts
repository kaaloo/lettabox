import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export interface ProxyConfig {
  lettaApiKey: string;
  lettaServerUrl: string;
  connectionName: string;
  deviceId: string;
  listenerInstanceId: string;
  downstreamWsUrl: string;
  downstreamHttpUrl: string;
  downstreamWsToken?: string;
  workerWsUrls: string[];
  workerWsToken?: string;
  heartbeatIntervalMs: number;
  heartbeatMaxMissed: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  downstreamReadyTimeoutMs: number;
  debugFrames: boolean;
}

export function deriveListenerInstanceId(connectionName: string): string {
  const hash = createHash("sha256").update(connectionName).digest("hex").slice(0, 16);
  return `server-${hash}`;
}

export function toHttpBaseUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported downstream URL protocol: ${url.protocol}`);
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function loadOrCreateDeviceId(filePath: string): string {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length > 0) {
      return existing;
    }
  }
  const id = randomUUID();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${id}\n`, "utf8");
  return id;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`);
  }
  return parsed;
}

function parseUrlList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const lettaApiKey = env.LETTA_API_KEY?.trim();
  if (!lettaApiKey) {
    throw new Error("LETTA_API_KEY is required");
  }

  const lettaServerUrl = (env.LETTA_SERVER_URL?.trim() || "https://api.letta.com").replace(
    /\/+$/,
    "",
  );
  const connectionName = env.LETTA_CONNECTION_NAME?.trim() || `letta-sandbox-${hostname()}`;
  const deviceIdFile =
    env.LETTA_DEVICE_ID_FILE?.trim() || join(homedir(), ".letta-sandbox", "device-id");
  const deviceId = env.LETTA_DEVICE_ID?.trim() || loadOrCreateDeviceId(deviceIdFile);

  const downstreamWsUrl =
    env.CONTROL_PLANE_URL?.trim() || env.DOWNSTREAM_URL?.trim() || "ws://127.0.0.1:4500/ws";
  const downstreamHttpUrl = toHttpBaseUrl(downstreamWsUrl);

  let downstreamWsToken = env.DOWNSTREAM_WS_TOKEN?.trim();
  const tokenFile = env.DOWNSTREAM_WS_TOKEN_FILE?.trim();
  if (!downstreamWsToken && tokenFile) {
    downstreamWsToken = readFileSync(tokenFile, "utf8").trim();
  }

  const workerWsUrls = parseUrlList(env.WORKER_URLS);
  let workerWsToken = env.WORKER_WS_TOKEN?.trim();
  const workerTokenFile = env.WORKER_WS_TOKEN_FILE?.trim();
  if (!workerWsToken && workerTokenFile) {
    workerWsToken = readFileSync(workerTokenFile, "utf8").trim();
  }
  if (!workerWsToken) {
    workerWsToken = downstreamWsToken;
  }

  return {
    lettaApiKey,
    lettaServerUrl,
    connectionName,
    deviceId,
    listenerInstanceId: deriveListenerInstanceId(connectionName),
    downstreamWsUrl,
    downstreamHttpUrl,
    downstreamWsToken: downstreamWsToken || undefined,
    workerWsUrls,
    workerWsToken: workerWsToken || undefined,
    heartbeatIntervalMs: parsePositiveInt(
      env.HEARTBEAT_INTERVAL_MS,
      30_000,
      "HEARTBEAT_INTERVAL_MS",
    ),
    heartbeatMaxMissed: parsePositiveInt(env.HEARTBEAT_MAX_MISSED, 3, "HEARTBEAT_MAX_MISSED"),
    reconnectBaseDelayMs: parsePositiveInt(
      env.RECONNECT_BASE_DELAY_MS,
      1_000,
      "RECONNECT_BASE_DELAY_MS",
    ),
    reconnectMaxDelayMs: parsePositiveInt(
      env.RECONNECT_MAX_DELAY_MS,
      30_000,
      "RECONNECT_MAX_DELAY_MS",
    ),
    downstreamReadyTimeoutMs: parsePositiveInt(
      env.DOWNSTREAM_READY_TIMEOUT_MS,
      30_000,
      "DOWNSTREAM_READY_TIMEOUT_MS",
    ),
    debugFrames: env.DEBUG_FRAMES === "1" || env.DEBUG_FRAMES === "true",
  };
}
