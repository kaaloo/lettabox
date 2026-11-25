import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type SandboxMode = "static" | "microsandbox";
export type SandboxBackend = "local" | "cloud";
export type MsbComputeType = "standard" | "shared";

export interface SandboxConfig {
  backend: SandboxBackend;
  image: string;
  containerPort: number;
  idleTimeoutMs: number;
  reaperIntervalMs: number;
  startTimeoutMs: number;
  memoryLimit: string;
  cpuLimit: string;
  warmPoolSize?: number;
  msbBin?: string;
  msbHome?: string;
  msbSecretInjection: boolean;
  msbApiKey?: string;
  msbApiUrl?: string;
  msbProfile?: string;
  msbComputeType?: MsbComputeType;
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

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer for ${name}: ${value}`);
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

export function parseSandboxBackend(value: string | undefined): SandboxBackend {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "local") {
    return "local";
  }
  if (normalized === "cloud" || normalized === "remote") {
    return "cloud";
  }
  throw new Error(`Invalid MSB_BACKEND: ${value} (expected "local" or "cloud"/"remote")`);
}

export function parseMsbComputeType(value: string | undefined): MsbComputeType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "standard" || normalized === "shared") {
    return normalized;
  }
  throw new Error(`Invalid MSB_COMPUTE_TYPE: ${value} (expected "standard" or "shared")`);
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
      (parsed.env as Record<string, unknown> | undefined)?.LETTA_API_KEY,
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

export class MissingApiKeyError extends Error {
  constructor(
    message = "LETTA_API_KEY is required (set LETTA_API_KEY or log in via `letta login` so ~/.letta/settings.json has a token)",
  ) {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

export function resolveLettaApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const settingsFile =
    env.LETTA_SETTINGS_FILE?.trim() || join(homedir(), ".letta", "settings.json");
  return env.LETTA_API_KEY?.trim() || readApiKeyFromLettaSettings(settingsFile);
}

export interface SecretLookupOptions {
  getSecret?: (options: { service: string; name: string }) => Promise<string | null>;
}

export async function readApiKeyFromBunSecrets(
  env: Record<string, string | undefined> = process.env,
  options: SecretLookupOptions = {},
): Promise<string | undefined> {
  const getSecret =
    options.getSecret ??
    (globalThis.Bun?.secrets
      ? (opts: { service: string; name: string }) => globalThis.Bun.secrets.get(opts)
      : undefined);
  if (!getSecret) return undefined;

  const baseService = env.LETTA_SECRETS_SERVICE_NAME?.trim() || "letta-code";
  const prefix = env.LETTA_TEST_SECRETS_SERVICE_PREFIX?.trim();
  const service = prefix ? `${prefix}:${baseService}` : baseService;

  try {
    const value = await getSecret({ service, name: "letta-api-key" });
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveLettaApiKeyAsync(
  env: Record<string, string | undefined> = process.env,
  options: SecretLookupOptions = {},
): Promise<string | undefined> {
  const syncKey = resolveLettaApiKey(env);
  if (syncKey) return syncKey;
  if (env.LETTA_SETTINGS_FILE?.trim() && !options.getSecret) {
    return undefined;
  }
  return readApiKeyFromBunSecrets(env, options);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const lettaApiKey = resolveLettaApiKey(env);
  if (!lettaApiKey) {
    throw new MissingApiKeyError();
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
  const sandboxBackend = parseSandboxBackend(env.MSB_BACKEND);
  const msbApiKey = env.MSB_API_KEY?.trim() || undefined;
  const msbApiUrl = env.MSB_API_URL?.trim() || undefined;
  const msbProfile = env.MSB_PROFILE?.trim() || undefined;
  const msbComputeType = parseMsbComputeType(env.MSB_COMPUTE_TYPE);

  if (sandboxMode === "microsandbox" && sandboxBackend === "cloud" && !msbApiKey && !msbProfile) {
    throw new Error(
      "Microsandbox cloud backend requires MSB_API_KEY (or MSB_PROFILE); refusing to fall back to local",
    );
  }

  const msbSecretInjection =
    env.MSB_SECRET_INJECTION !== "0" && env.MSB_SECRET_INJECTION !== "false";
  const defaultWarmPoolSize = sandboxBackend === "cloud" ? 0 : 1;
  const defaultMemoryLimit = sandboxBackend === "cloud" ? "1G" : "2G";
  const defaultCpuLimit = sandboxBackend === "cloud" ? "1" : "2";

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
      backend: sandboxBackend,
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
      memoryLimit: env.SANDBOX_MEMORY_LIMIT?.trim() || defaultMemoryLimit,
      cpuLimit: env.SANDBOX_CPU_LIMIT?.trim() || defaultCpuLimit,
      warmPoolSize: parseNonNegativeInt(
        env.SANDBOX_WARM_POOL_SIZE,
        defaultWarmPoolSize,
        "SANDBOX_WARM_POOL_SIZE",
      ),
      msbBin: env.MSB_PATH?.trim() || undefined,
      msbHome: env.MSB_HOME?.trim() || join(homedir(), ".lettabox", "microsandbox"),
      msbSecretInjection,
      msbApiKey,
      msbApiUrl,
      msbProfile,
      msbComputeType,
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
