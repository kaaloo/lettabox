import type { ProxyConfig } from "./config.ts";
import { DownstreamClient } from "./downstream.ts";
import { getFrameType, parseJsonObject, summarizeFrame } from "./protocol.ts";
import { fetchAppServerInfo, waitForDownstreamHealth } from "./register.ts";
import { UpstreamRelayClient } from "./upstream.ts";

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

const defaultLogger: Logger = {
  info: (msg) => console.log(`[letta-sandbox] ${msg}`),
  warn: (msg) => console.warn(`[letta-sandbox] WARN: ${msg}`),
  error: (msg) => console.error(`[letta-sandbox] ERROR: ${msg}`),
  debug: (msg) => console.log(`[letta-sandbox] DEBUG: ${msg}`),
};

export interface PassthroughProxyOptions {
  config: ProxyConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  onTerminalClose?: (reason: string) => void;
  onUpstreamReady?: () => void;
}

export class PassthroughProxy {
  private readonly config: ProxyConfig;
  private readonly logger: Logger;
  private readonly fetchImpl?: typeof fetch;
  private readonly onTerminalClose?: (reason: string) => void;
  private readonly onUpstreamReady?: () => void;

  private downstream: DownstreamClient | null = null;
  private upstream: UpstreamRelayClient | null = null;
  private stopped = false;

  constructor(options: PassthroughProxyOptions) {
    this.config = options.config;
    this.logger = options.logger ?? defaultLogger;
    this.fetchImpl = options.fetchImpl;
    this.onTerminalClose = options.onTerminalClose;
    this.onUpstreamReady = options.onUpstreamReady;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.logger.info(
      `Waiting for downstream letta server at ${this.config.downstreamHttpUrl}/healthz`,
    );

    await waitForDownstreamHealth(this.config.downstreamHttpUrl, {
      timeoutMs: this.config.downstreamReadyTimeoutMs,
      token: this.config.downstreamWsToken,
      fetchImpl: this.fetchImpl,
    });

    const appServerInfo = await fetchAppServerInfo(this.config.downstreamHttpUrl, {
      token: this.config.downstreamWsToken,
      fetchImpl: this.fetchImpl,
    });
    const version = appServerInfo.lettaCodeVersion ?? appServerInfo.version ?? "unknown";
    const cmdCount = (appServerInfo.supported_commands ?? appServerInfo.supportedCommands ?? [])
      .length;
    this.logger.info(
      `Downstream ready (letta-code ${version}, ${cmdCount} supported_commands)`,
    );

    if (this.stopped) return;

    const downstream = new DownstreamClient({
      wsUrl: this.config.downstreamWsUrl,
      token: this.config.downstreamWsToken,
      reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
      onMessage: (raw) => {
        const frame = parseJsonObject(raw);
        const frameType = getFrameType(frame);
        const channel = this.upstream?.send(raw, frameType);
        if (this.config.debugFrames) {
          this.logger.debug(
            `downstream -> upstream(${channel ?? "none"}): ${summarizeFrame(frame)}`,
          );
        }
      },
      onOpen: () => {
        this.logger.info(`Connected to downstream ${this.config.downstreamWsUrl}`);
      },
      onClose: (code, reason) => {
        this.logger.warn(`Downstream closed (${code}: ${reason || "no reason"})`);
      },
      onError: (err) => {
        this.logger.error(`Downstream error: ${String(err)}`);
      },
    });
    this.downstream = downstream;
    await downstream.connect();

    if (this.stopped) {
      downstream.close();
      return;
    }

    const upstream = new UpstreamRelayClient({
      lettaServerUrl: this.config.lettaServerUrl,
      lettaApiKey: this.config.lettaApiKey,
      deviceId: this.config.deviceId,
      listenerInstanceId: this.config.listenerInstanceId,
      connectionName: this.config.connectionName,
      appServerInfo,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      heartbeatMaxMissed: this.config.heartbeatMaxMissed,
      reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
      fetchImpl: this.fetchImpl,
      onMessage: (raw, channel) => {
        if (this.config.debugFrames) {
          const frame = parseJsonObject(raw);
          this.logger.debug(`upstream(${channel}) -> downstream: ${summarizeFrame(frame)}`);
        }
        this.downstream?.send(raw);
      },
      onReady: (info) => {
        this.logger.info(
          `Upstream ready (connectionId=${info.connectionId}, split=${info.splitChannels}, paired=${info.pairedGenerations}, attempt=${info.attempt})`,
        );
        this.onUpstreamReady?.();
      },
      onDisconnect: ({ code, reason, channel }) => {
        this.logger.warn(
          `Upstream ${channel} closed (${code}: ${reason || "no reason"})`,
        );
      },
      onTerminalClose: (reason) => {
        this.logger.warn(`Upstream terminal close: ${reason}`);
        this.stop();
        this.onTerminalClose?.(reason);
      },
      onError: (err) => {
        this.logger.error(`Upstream error: ${String(err)}`);
      },
    });
    this.upstream = upstream;
    await upstream.start();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.upstream?.close();
    this.upstream = null;
    this.downstream?.close();
    this.downstream = null;
  }
}
