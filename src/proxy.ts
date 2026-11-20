import type { ProxyConfig } from "./config.ts";
import { DownstreamClient } from "./downstream.ts";
import { fetchAppServerInfo, waitForDownstreamHealth } from "./register.ts";
import {
  type ConversationTargetProvider,
  type DownstreamTarget,
  EnvelopeRouter,
} from "./router.ts";
import { UpstreamRelayClient } from "./upstream.ts";
import { StaticWorkerPool } from "./worker-pool.ts";

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

  private controlPlane: DownstreamClient | null = null;
  private conversationProvider: ConversationTargetProvider | null = null;
  private router: EnvelopeRouter | null = null;
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
      `Waiting for control-plane letta server at ${this.config.downstreamHttpUrl}/healthz`,
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
      `Control-plane ready (letta-code ${version}, ${cmdCount} supported_commands, ${this.config.workerWsUrls.length} configured worker(s))`,
    );

    if (this.stopped) return;

    let controlTarget: DownstreamTarget;
    const controlClient = new DownstreamClient({
      wsUrl: this.config.downstreamWsUrl,
      token: this.config.downstreamWsToken,
      reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
      onMessage: (raw) => {
        this.router?.handleDownstreamMessage(controlTarget, raw);
      },
      onOpen: () => {
        this.logger.info(`Connected to control-plane ${this.config.downstreamWsUrl}`);
      },
      onClose: (code, reason) => {
        this.logger.warn(`Control-plane closed (${code}: ${reason || "no reason"})`);
      },
      onError: (err) => {
        this.logger.error(`Control-plane error: ${String(err)}`);
      },
    });
    controlTarget = {
      id: "control-plane",
      send: (raw) => controlClient.send(raw),
      close: () => controlClient.close(),
    };
    this.controlPlane = controlClient;
    await controlClient.connect();

    if (this.stopped) {
      controlClient.close();
      return;
    }

    const workerPool = new StaticWorkerPool({
      workerUrls: this.config.workerWsUrls,
      fallbackTarget: controlTarget,
      token: this.config.workerWsToken,
      reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
      onMessage: (target, raw) => {
        this.router?.handleDownstreamMessage(target, raw);
      },
      onWorkerOpen: (workerId, url) => {
        this.logger.info(`Connected to ${workerId} (${url})`);
      },
      onWorkerClose: (workerId, code, reason) => {
        this.logger.warn(`${workerId} closed (${code}: ${reason || "no reason"})`);
      },
      onWorkerError: (workerId, err) => {
        this.logger.error(`${workerId} error: ${String(err)}`);
      },
    });
    this.conversationProvider = workerPool;

    const router = new EnvelopeRouter({
      controlPlane: controlTarget,
      conversationProvider: workerPool,
      sendToUpstream: (raw, frameType) => this.upstream?.send(raw, frameType) ?? null,
      debugFrames: this.config.debugFrames,
      logger: this.logger,
    });
    this.router = router;

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
        void this.router?.handleUpstreamMessage(raw, channel);
      },
      onReady: (info) => {
        this.router?.resetEventSeq();
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
    this.conversationProvider?.closeAll();
    this.conversationProvider = null;
    this.controlPlane?.close();
    this.controlPlane = null;
    this.router = null;
  }
}

export { PassthroughProxy as MultiplexerProxy };
