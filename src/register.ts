import { getMachineMetadata, type MachineMetadata } from "./machine-metadata.ts";
import type { AppServerInfo, RegistrationResponse } from "./protocol.ts";

export interface RegisterEnvironmentParams {
  lettaServerUrl: string;
  lettaApiKey: string;
  deviceId: string;
  listenerInstanceId: string;
  connectionName: string;
  appServerInfo: AppServerInfo;
  machine?: MachineMetadata;
  statusEmoji?: string;
  fetchImpl?: typeof fetch;
}

export async function waitForDownstreamHealth(
  httpBaseUrl: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    token?: string;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const headers: Record<string, string> = {
    ...options.headers,
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${httpBaseUrl}/healthz`, { headers });
      if (res.ok) {
        return;
      }
      lastError = new Error(`GET /healthz returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for downstream server at ${httpBaseUrl}/healthz (${timeoutMs}ms): ${String(lastError)}`,
  );
}

export async function fetchAppServerInfo(
  httpBaseUrl: string,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<AppServerInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const res = await fetchImpl(`${httpBaseUrl}/app-server-info`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${httpBaseUrl}/app-server-info failed (${res.status}): ${body}`);
  }
  return (await res.json()) as AppServerInfo;
}

export class RegistrationAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RegistrationAuthError";
    this.status = status;
  }
}

export async function registerEnvironment(
  params: RegisterEnvironmentParams,
): Promise<RegistrationResponse> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const baseUrl = params.lettaServerUrl.replace(/\/+$/, "");
  const lettaCodeVersion =
    params.appServerInfo.lettaCodeVersion ??
    params.appServerInfo.letta_code_version ??
    params.appServerInfo.version ??
    "unknown";
  const supportedCommands =
    params.appServerInfo.supported_commands ?? params.appServerInfo.supportedCommands ?? [];
  const machine = params.machine ?? (await getMachineMetadata(params.statusEmoji));

  const body = {
    deviceId: params.deviceId,
    listenerInstanceId: params.listenerInstanceId,
    connectionName: params.connectionName,
    metadata: {
      lettaCodeVersion,
      os: process.platform,
      nodeVersion: process.version,
      machine,
      environmentMessageProtocol: "v2-input",
      supportsPairedListenerGenerations: true,
      supported_commands: supportedCommands,
      launch_subagent_notify_caller: true,
      subagent_message: true,
      external_fork_context: true,
    },
  };

  const res = await fetchImpl(`${baseUrl}/v1/environments/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.lettaApiKey}`,
      "X-Letta-Source": "letta-code",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      const detail = errBody.trim().slice(0, 200);
      throw new RegistrationAuthError(
        res.status,
        `Authentication failed during environment registration (HTTP ${res.status}). Your token may be expired or invalid — run \`letta login\` or update LETTA_API_KEY.${detail ? ` (${detail})` : ""}`,
      );
    }
    throw new Error(`POST /v1/environments/register failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as Partial<RegistrationResponse>;
  if (!data.connectionId || !data.wsUrl) {
    throw new Error(
      `Invalid registration response from Letta Cloud: missing connectionId or wsUrl`,
    );
  }

  return {
    connectionId: data.connectionId,
    wsUrl: data.wsUrl,
    supportsSplitStatusChannels: Boolean(data.supportsSplitStatusChannels),
    supportsPairedListenerGenerations: Boolean(data.supportsPairedListenerGenerations),
  };
}
