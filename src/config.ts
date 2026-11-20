import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type SandboxMode = "static" | "microsandbox";

export interface SandboxConfig {
  image: string;
  containerPort: number;
  idleTimeoutMs: number;
  reaperIntervalMs: number;
  startTimeoutMs: number;
  memoryLimit: string;
  cpuLimit: string;
  msbBin?: string;
  msbHome?: string;
  msbSecretInjection: boolean;
}

export interface ProxyConfig {
  lettaApiKey: string;
  lettaServerUrl: string;
  connectionName: string;
  deviceId: string;
  listenerInstanceId: string;
  downstreamWsUrl: string;
  downstreamHttpUrl: string;
  downstreamWsToken?: string;
  sandboxMode: SandboxMode;
  sandbox: SandboxConfig;
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

function parseSandboxMode(value: string | undefined): SandboxMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "static") {
    return "static";
  }
  if (normalized === "microsandbox" || normalized === "msb") {
    return "microsandbox";
  }
  throw new Error(`Invalid SANDBOX_MODE: ${value} (expected "static" or "microsandbox"/"msb")`);
}

export function readApiKeyFromLettaSettings(
  settingsFile: string = join(homedir(), ".letta", "settings.json"),
): string | undefined {
  if (!existsSync(settingsFile)) return undefined;
  try {
    const raw = readFileSync(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidates: unknown[] = [
      parsed.apiKey,
      parsed.api_key,
      parsed.lettaApiKey,
      parsed.accessToken,
      parsed.token,
      (parsed.auth as Record<string, unknown> | undefined)?.apiKey,
      (parsed.auth as Record<string, unknown> | undefined)?.accessToken,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const settingsFile =
    env.LETTA_SETTINGS_FILE?.trim() || join(homedir(), ".letta", "settings.json");
  const lettaApiKey = env.LETTA_API_KEY?.trim() || readApiKeyFromLettaSettings(settingsFile);
  if (!lettaApiKey) {
    throw new Error(
      "LETTA_API_KEY is required (set LETTA_API_KEY or log in via `letta login` so ~/.letta/settings.json has a token)",
    );
  }

  const lettaServerUrl = (env.LETTA_SERVER_URL?.trim() || "https://api.letta.com").replace(
    /\/+$/,
    "",
  );
  const connectionName = env.LETTA_CONNECTION_NAME?.trim() || `lettabox-${hostname()}`;
  const legacyDeviceIdFile = join(homedir(), ".letta-sandbox", "device-id");
  const defaultDeviceIdFile = existsSync(legacyDeviceIdFile)
    ? legacyDeviceIdFile
    : join(homedir(), ".lettabox", "device-id");
  const deviceIdFile = env.LETTA_DEVICE_ID_FILE?.trim() || defaultDeviceIdFile;
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

  const sandboxMode = parseSandboxMode(env.SANDBOX_MODE);
  const msbSecretInjection =
    env.MSB_SECRET_INJECTION !== "0" && env.MSB_SECRET_INJECTION !== "false";

  return {
    lettaApiKey,
    lettaServerUrl,
    connectionName,
    deviceId,
    listenerInstanceId: deriveListenerInstanceId(connectionName),
    downstreamWsUrl,
    downstreamHttpUrl,
    downstreamWsToken: downstreamWsToken || undefined,
    sandboxMode,
    sandbox: {
      image: env.SANDBOX_IMAGE?.trim() || "ghcr.io/letta-ai/letta-code:latest",
      containerPort: parsePositiveInt(env.SANDBOX_CONTAINER_PORT, 4500, "SANDBOX_CONTAINER_PORT"),
      idleTimeoutMs: parsePositiveInt(
        env.SANDBOX_IDLE_TIMEOUT_MS,
        30 * 60_000,
        "SANDBOX_IDLE_TIMEOUT_MS",
      ),
      reaperIntervalMs: parsePositiveInt(
        env.SANDBOX_REAPER_INTERVAL_MS,
        30_000,
        "SANDBOX_REAPER_INTERVAL_MS",
      ),
      startTimeoutMs: parsePositiveInt(
        env.SANDBOX_START_TIMEOUT_MS,
        30_000,
        "SANDBOX_START_TIMEOUT_MS",
      ),
      memoryLimit: env.SANDBOX_MEMORY_LIMIT?.trim() || "2G",
      cpuLimit: env.SANDBOX_CPU_LIMIT?.trim() || "2",
      msbBin: env.MSB_PATH?.trim() || undefined,
      msbHome: env.MSB_HOME?.trim() || join(homedir(), ".lettabox", "microsandbox"),
      msbSecretInjection,
    },
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
