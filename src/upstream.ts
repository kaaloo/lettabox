import { randomUUID } from "node:crypto";
import {
  type AppServerInfo,
  decodeWsData,
  isListenerReadyFrame,
  isPongFrame,
  parseJsonObject,
  type RegistrationResponse,
  selectUpstreamChannel,
} from "./protocol.ts";
import { RegistrationAuthError, registerEnvironment } from "./register.ts";

export const TERMINAL_REPLACED_CODE = 1000;
export const TERMINAL_REPLACED_REASON = "Replaced by new connection";
export const RE_REGISTER_CODE = 1008;
export const RE_REGISTER_REASON = "Environment not found";

export interface UpstreamRelayClientOptions {
  lettaServerUrl: string;
  lettaApiKey: string;
  deviceId: string;
  listenerInstanceId: string;
  connectionName: string;
  appServerInfo: AppServerInfo;
  heartbeatIntervalMs?: number;
  heartbeatMaxMissed?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxQueuedMessages?: number;
  fetchImpl?: typeof fetch;
  onMessage: (raw: string, channel: "control" | "stream") => void;
  onReady?: (info: {
    connectionId: string;
    splitChannels: boolean;
    pairedGenerations: boolean;
    generation?: string;
    attempt: number;
  }) => void;
  onDisconnect?: (info: { code: number; reason: string; channel: "control" | "stream" }) => void;
  onTerminalClose?: (reason: string, isError?: boolean) => void;
  onError?: (err: unknown) => void;
}

export function buildUpstreamWsUrl(
  baseWsUrl: string,
  params: {
    deviceId: string;
    connectionName: string;
    channel?: "control" | "stream";
    connectionGeneration?: string;
    connectionAttempt?: number;
  },
): string {
  const url = new URL(baseWsUrl);
  url.searchParams.set("deviceId", params.deviceId);
  url.searchParams.set("connectionName", params.connectionName);
  if (params.channel) {
    url.searchParams.set("channel", params.channel);
  }
  if (params.connectionGeneration) {
    url.searchParams.set("connectionGeneration", params.connectionGeneration);
  }
  if (params.connectionAttempt !== undefined) {
    url.searchParams.set("connectionAttempt", String(params.connectionAttempt));
  }
  return url.toString();
}

export class UpstreamRelayClient {
  private readonly options: UpstreamRelayClientOptions;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMaxMissed: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly maxQueuedMessages: number;

  private registration: RegistrationResponse | null = null;
  private controlWs: WebSocket | null = null;
  private streamWs: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private controlMissedPongs = 0;
  private streamMissedPongs = 0;
  private connectionGeneration: string | undefined;
  private connectionAttempt = 0;
  private reconnectFailures = 0;
  private sessionToken = 0;
  private closed = false;
  private reconnecting = false;

  private readonly controlQueue: string[] = [];
  private readonly streamQueue: string[] = [];

  constructor(options: UpstreamRelayClientOptions) {
    this.options = options;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.heartbeatMaxMissed = options.heartbeatMaxMissed ?? 3;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.maxQueuedMessages = options.maxQueuedMessages ?? 256;
  }

  get isControlOpen(): boolean {
    return this.controlWs !== null && this.controlWs.readyState === WebSocket.OPEN;
  }

  get isStreamOpen(): boolean {
    return this.streamWs !== null && this.streamWs.readyState === WebSocket.OPEN;
  }

  get splitChannelsEnabled(): boolean {
    return Boolean(this.registration?.supportsSplitStatusChannels);
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connectCycle();
  }

  send(raw: string, frameType?: string): "control" | "stream" | null {
    if (this.closed) return null;
    const channel = selectUpstreamChannel(frameType, this.splitChannelsEnabled);

    if (channel === "stream") {
      if (this.streamWs && this.streamWs.readyState === WebSocket.OPEN) {
        this.streamWs.send(raw);
        return "stream";
      }
      this.enqueue(this.streamQueue, raw);
      return "stream";
    }

    if (this.controlWs && this.controlWs.readyState === WebSocket.OPEN) {
      this.controlWs.send(raw);
      return "control";
    }
    this.enqueue(this.controlQueue, raw);
    return "control";
  }

  close(): void {
    this.closed = true;
    this.sessionToken += 1;
    this.clearTimers();
    this.teardownSockets(1000, "Proxy shutting down");
    this.controlQueue.length = 0;
    this.streamQueue.length = 0;
  }

  private enqueue(queue: string[], raw: string): void {
    if (queue.length >= this.maxQueuedMessages) {
      queue.shift();
    }
    queue.push(raw);
  }

  private flushQueue(socket: WebSocket | null, queue: string[]): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        socket.send(next);
      }
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownSockets(code: number, reason: string): void {
    const control = this.controlWs;
    const stream = this.streamWs;
    this.controlWs = null;
    this.streamWs = null;

    for (const sock of [control, stream]) {
      if (
        sock &&
        (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)
      ) {
        try {
          sock.close(code, reason);
        } catch {
          // Ignore close errors during teardown
        }
      }
    }
  }

  private async connectCycle(): Promise<void> {
    if (this.closed) return;
    this.reconnecting = false;
    const currentSession = ++this.sessionToken;

    try {
      if (!this.registration) {
        this.registration = await registerEnvironment({
          lettaServerUrl: this.options.lettaServerUrl,
          lettaApiKey: this.options.lettaApiKey,
          deviceId: this.options.deviceId,
          listenerInstanceId: this.options.listenerInstanceId,
          connectionName: this.options.connectionName,
          appServerInfo: this.options.appServerInfo,
          fetchImpl: this.options.fetchImpl,
        });
      }
    } catch (err) {
      if (this.closed || currentSession !== this.sessionToken) return;
      this.options.onError?.(err);
      if (err instanceof RegistrationAuthError) {
        this.closed = true;
        this.clearTimers();
        this.teardownSockets(1000, "Authentication failed");
        this.options.onTerminalClose?.(err.message, true);
        return;
      }
      this.scheduleReconnect();
      return;
    }

    if (this.closed || currentSession !== this.sessionToken) return;

    const reg = this.registration;
    const splitChannels = Boolean(reg.supportsSplitStatusChannels);
    const pairedGenerations = splitChannels && Boolean(reg.supportsPairedListenerGenerations);

    this.connectionAttempt += 1;
    this.connectionGeneration = pairedGenerations ? randomUUID() : undefined;
    this.controlMissedPongs = 0;
    this.streamMissedPongs = 0;

    const controlUrl = buildUpstreamWsUrl(reg.wsUrl, {
      deviceId: this.options.deviceId,
      connectionName: this.options.connectionName,
      channel: splitChannels ? "control" : undefined,
      connectionGeneration: this.connectionGeneration,
      connectionAttempt: pairedGenerations ? this.connectionAttempt : undefined,
    });

    const controlSocket = new WebSocket(controlUrl, {
      headers: {
        Authorization: `Bearer ${this.options.lettaApiKey}`,
      },
    });
    this.controlWs = controlSocket;

    controlSocket.addEventListener("open", () => {
      if (this.closed || currentSession !== this.sessionToken || this.controlWs !== controlSocket) {
        controlSocket.close(1000, "Stale session");
        return;
      }
      this.reconnectFailures = 0;
      this.startHeartbeat(currentSession);
      this.flushQueue(controlSocket, this.controlQueue);

      if (splitChannels && !pairedGenerations) {
        this.openStreamSocket(currentSession, reg);
      } else if (!splitChannels) {
        this.notifyReady(reg, false, false);
      }
    });

    controlSocket.addEventListener("message", (event) => {
      if (this.closed || currentSession !== this.sessionToken || this.controlWs !== controlSocket) {
        return;
      }
      const raw = decodeWsData(event.data);
      if (raw === null) return;

      const frame = parseJsonObject(raw);
      if (isPongFrame(frame)) {
        this.controlMissedPongs = 0;
        return;
      }
      if (isListenerReadyFrame(frame)) {
        if (
          pairedGenerations &&
          this.streamWs === null &&
          (frame.connection_generation === undefined ||
            frame.connection_generation === this.connectionGeneration) &&
          (frame.connection_attempt === undefined ||
            frame.connection_attempt === this.connectionAttempt)
        ) {
          this.openStreamSocket(currentSession, reg);
        }
        return;
      }

      this.options.onMessage(raw, "control");
    });

    controlSocket.addEventListener("error", (event) => {
      if (this.closed || currentSession !== this.sessionToken) return;
      this.options.onError?.(event);
    });

    controlSocket.addEventListener("close", (event) => {
      if (currentSession !== this.sessionToken) return;
      this.handleSocketClose(currentSession, "control", event.code, event.reason);
    });
  }

  private openStreamSocket(currentSession: number, reg: RegistrationResponse): void {
    if (this.closed || currentSession !== this.sessionToken || this.streamWs !== null) return;

    const pairedGenerations = Boolean(reg.supportsPairedListenerGenerations);
    const streamUrl = buildUpstreamWsUrl(reg.wsUrl, {
      deviceId: this.options.deviceId,
      connectionName: this.options.connectionName,
      channel: "stream",
      connectionGeneration: this.connectionGeneration,
      connectionAttempt: pairedGenerations ? this.connectionAttempt : undefined,
    });

    const streamSocket = new WebSocket(streamUrl, {
      headers: {
        Authorization: `Bearer ${this.options.lettaApiKey}`,
      },
    });
    this.streamWs = streamSocket;
    this.streamMissedPongs = 0;

    streamSocket.addEventListener("open", () => {
      if (this.closed || currentSession !== this.sessionToken || this.streamWs !== streamSocket) {
        streamSocket.close(1000, "Stale session");
        return;
      }
      this.flushQueue(streamSocket, this.streamQueue);
      this.notifyReady(reg, true, pairedGenerations);
    });

    streamSocket.addEventListener("message", (event) => {
      if (this.closed || currentSession !== this.sessionToken || this.streamWs !== streamSocket) {
        return;
      }
      const raw = decodeWsData(event.data);
      if (raw === null) return;

      const frame = parseJsonObject(raw);
      if (isPongFrame(frame)) {
        this.streamMissedPongs = 0;
        return;
      }
      if (isListenerReadyFrame(frame)) {
        return;
      }

      this.options.onMessage(raw, "stream");
    });

    streamSocket.addEventListener("error", (event) => {
      if (this.closed || currentSession !== this.sessionToken) return;
      this.options.onError?.(event);
    });

    streamSocket.addEventListener("close", (event) => {
      if (currentSession !== this.sessionToken) return;
      this.handleSocketClose(currentSession, "stream", event.code, event.reason);
    });
  }

  private notifyReady(
    reg: RegistrationResponse,
    splitChannels: boolean,
    pairedGenerations: boolean,
  ): void {
    this.options.onReady?.({
      connectionId: reg.connectionId,
      splitChannels,
      pairedGenerations,
      generation: this.connectionGeneration,
      attempt: this.connectionAttempt,
    });
  }

  private startHeartbeat(currentSession: number): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || currentSession !== this.sessionToken) {
        this.clearTimers();
        return;
      }

      if (this.controlWs && this.controlWs.readyState === WebSocket.OPEN) {
        if (this.controlMissedPongs >= this.heartbeatMaxMissed) {
          this.handleHeartbeatTimeout(currentSession, "control");
          return;
        }
        this.controlMissedPongs += 1;
        this.controlWs.send(JSON.stringify({ type: "ping" }));
      }

      if (this.streamWs && this.streamWs.readyState === WebSocket.OPEN) {
        if (this.streamMissedPongs >= this.heartbeatMaxMissed) {
          this.handleHeartbeatTimeout(currentSession, "stream");
          return;
        }
        this.streamMissedPongs += 1;
        this.streamWs.send(JSON.stringify({ type: "ping" }));
      }
    }, this.heartbeatIntervalMs);
  }

  private handleHeartbeatTimeout(currentSession: number, channel: "control" | "stream"): void {
    if (this.closed || currentSession !== this.sessionToken || this.reconnecting) return;
    this.reconnecting = true;
    this.sessionToken += 1;
    this.clearTimers();
    this.teardownSockets(4000, `Heartbeat timeout on ${channel}`);
    this.options.onDisconnect?.({
      code: 4000,
      reason: `Heartbeat timeout on ${channel}`,
      channel,
    });
    this.scheduleReconnect();
  }

  private handleSocketClose(
    currentSession: number,
    channel: "control" | "stream",
    code: number,
    reason: string,
  ): void {
    if (this.closed || currentSession !== this.sessionToken || this.reconnecting) return;
    this.reconnecting = true;
    this.sessionToken += 1;
    this.clearTimers();
    this.teardownSockets(1000, "Tearing down paired upstream session");

    this.options.onDisconnect?.({ code, reason, channel });

    if (code === TERMINAL_REPLACED_CODE && reason === TERMINAL_REPLACED_REASON) {
      this.closed = true;
      this.options.onTerminalClose?.(reason);
      return;
    }

    if (code === RE_REGISTER_CODE && reason.includes(RE_REGISTER_REASON)) {
      this.registration = null;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectFailures,
      this.reconnectMaxDelayMs,
    );
    this.reconnectFailures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectCycle();
    }, delay);
  }
}
