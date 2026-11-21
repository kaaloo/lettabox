import type { ProxyConfig } from "./config.ts";
import { DownstreamClient } from "./downstream.ts";
import { type ActiveSandboxInfo, MicrosandboxProvider } from "./microsandbox-provider.ts";
import type { MsbRunner } from "./msb-runner.ts";
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
  info: (msg) => console.log(`[lettabox] ${msg}`),
  warn: (msg) => console.warn(`[lettabox] WARN: ${msg}`),
  error: (msg) => console.error(`[lettabox] ERROR: ${msg}`),
  debug: (msg) => console.log(`[lettabox] DEBUG: ${msg}`),
};

export interface PassthroughProxyOptions {
  config: ProxyConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  msb?: MsbRunner;
  allocatePort?: () => Promise<number>;
  onTerminalClose?: (reason: string, isError?: boolean) => void;
  onUpstreamReady?: () => void;
  onUpstreamDisconnect?: () => void;
  onWorkingChange?: (working: boolean) => void;
}

export class PassthroughProxy {
  private readonly config: ProxyConfig;
  private readonly logger: Logger;
  private readonly fetchImpl?: typeof fetch;
  private readonly msb?: MsbRunner;
  private readonly allocatePort?: () => Promise<number>;
  private readonly onTerminalClose?: (reason: string, isError?: boolean) => void;
  private readonly onUpstreamReady?: () => void;
  private readonly onUpstreamDisconnect?: () => void;
  private readonly onWorkingChange?: (working: boolean) => void;

  private controlPlane: DownstreamClient | null = null;
  private conversationProvider: ConversationTargetProvider | null = null;
  private msbProvider: MicrosandboxProvider | null = null;
  private asyncCloseProvider: (() => Promise<void>) | null = null;
  private router: EnvelopeRouter | null = null;
  private upstream: UpstreamRelayClient | null = null;
  private stopped = false;

  constructor(options: PassthroughProxyOptions) {
    this.config = options.config;
    this.logger = options.logger ?? defaultLogger;
    this.fetchImpl = options.fetchImpl;
    this.msb = options.msb;
    this.allocatePort = options.allocatePort;
    this.onTerminalClose = options.onTerminalClose;
    this.onUpstreamReady = options.onUpstreamReady;
    this.onUpstreamDisconnect = options.onUpstreamDisconnect;
    this.onWorkingChange = options.onWorkingChange;
  }

  listActiveSandboxes(): ActiveSandboxInfo[] {
    return this.msbProvider?.listActiveSandboxes() ?? [];
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
    const modeDesc =
      this.config.sandboxMode === "microsandbox"
        ? `microsandbox mode (image=${this.config.sandbox.image}, secretProxy=${this.config.sandbox.msbSecretInjection})`
        : `${this.config.workerWsUrls.length} configured worker(s)`;
    this.logger.info(
      `Control-plane ready (letta-code ${version}, ${cmdCount} supported_commands, ${modeDesc})`,
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

    let provider: ConversationTargetProvider;
    if (this.config.sandboxMode === "microsandbox") {
      const msbProvider = new MicrosandboxProvider({
        image: this.config.sandbox.image,
        msbBin: this.config.sandbox.msbBin,
        msbHome: this.config.sandbox.msbHome,
        guestPort: this.config.sandbox.containerPort,
        memoryLimit: this.config.sandbox.memoryLimit,
        cpuLimit: this.config.sandbox.cpuLimit,
        warmPoolSize: this.config.sandbox.warmPoolSize,
        lettaApiKey: this.config.lettaApiKey,
        lettaServerUrl: this.config.lettaServerUrl,
        useSecretInjection: this.config.sandbox.msbSecretInjection,
        idleTimeoutMs: this.config.sandbox.idleTimeoutMs,
        reaperIntervalMs: this.config.sandbox.reaperIntervalMs,
        startTimeoutMs: this.config.sandbox.startTimeoutMs,
        reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
        reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
        msb: this.msb,
        allocatePort: this.allocatePort,
        fetchImpl: this.fetchImpl,
        logger: this.logger,
        onMessage: (target, raw) => {
          this.router?.handleDownstreamMessage(target, raw);
        },
        onBusyChange: (anyBusy) => {
          this.onWorkingChange?.(anyBusy);
        },
      });
      this.msbProvider = msbProvider;
      this.asyncCloseProvider = () => msbProvider.closeAllAsync();
      provider = msbProvider;
      await msbProvider.ensureReady();
      if (this.stopped) return;
    } else {
      provider = new StaticWorkerPool({
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
      this.asyncCloseProvider = null;
    }
    this.conversationProvider = provider;

    const router = new EnvelopeRouter({
      controlPlane: controlTarget,
      conversationProvider: provider,
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
        this.logger.warn(`Upstream ${channel} closed (${code}: ${reason || "no reason"})`);
        this.onUpstreamDisconnect?.();
      },
      onTerminalClose: (reason, isError) => {
        if (isError) {
          this.logger.error(`Upstream terminal auth/connection error: ${reason}`);
        } else {
          this.logger.warn(`Upstream terminal close: ${reason}`);
        }
        void this.stopAsync().finally(() => {
          this.onTerminalClose?.(reason, isError);
        });
      },
      onError: (err) => {
        this.logger.error(`Upstream error: ${String(err)}`);
      },
    });
    this.upstream = upstream;
    await upstream.start();
  }

  stop(): void {
    void this.stopAsync();
  }

  async stopAsync(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.onUpstreamDisconnect?.();
    this.upstream?.close();
    this.upstream = null;
    if (this.asyncCloseProvider) {
      await this.asyncCloseProvider();
      this.asyncCloseProvider = null;
    } else {
      this.conversationProvider?.closeAll();
    }
    this.conversationProvider = null;
    this.msbProvider = null;
    this.controlPlane?.close();
    this.controlPlane = null;
    this.router = null;
  }
}

export { PassthroughProxy as MultiplexerProxy };
