import { createHash, randomBytes } from "node:crypto";
import { CliDockerRunner, type DockerRunner } from "./docker-runner.ts";
import { DownstreamClient } from "./downstream.ts";
import { waitForDownstreamHealth } from "./register.ts";
import type { ConversationTargetProvider, DownstreamTarget } from "./router.ts";

export interface SandboxLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface DockerGvisorProviderOptions {
  image: string;
  runtime?: string;
  containerPort?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  network?: string;
  lettaApiKey: string;
  lettaServerUrl: string;
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
  startTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  docker?: DockerRunner;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: SandboxLogger;
  onMessage: (target: DownstreamTarget, raw: string) => void;
}

interface ManagedSandbox {
  readonly id: string;
  readonly containerId: string;
  readonly wsUrl: string;
  readonly client: DownstreamClient;
  readonly target: DownstreamTarget;
  lastActivityAt: number;
  conversationId?: string;
  pendingRequestId?: string;
  stopping: boolean;
}

export const MANAGED_LABEL_KEY = "letta-sandbox.managed";
export const MANAGED_LABEL_VALUE = "true";

export function makeContainerName(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const nonce = randomBytes(3).toString("hex");
  return `letta-sbx-${hash}-${nonce}`;
}

export class DockerGvisorProvider implements ConversationTargetProvider {
  private readonly options: DockerGvisorProviderOptions;
  private readonly docker: DockerRunner;
  private readonly containerPort: number;
  private readonly idleTimeoutMs: number;
  private readonly reaperIntervalMs: number;
  private readonly startTimeoutMs: number;
  private readonly now: () => number;

  private readonly conversationMap = new Map<string, ManagedSandbox>();
  private readonly pendingMap = new Map<string, ManagedSandbox>();
  private readonly inFlightSpawns = new Map<string, Promise<ManagedSandbox>>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: DockerGvisorProviderOptions) {
    this.options = options;
    this.docker = options.docker ?? new CliDockerRunner();
    this.containerPort = options.containerPort ?? 4500;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
    this.reaperIntervalMs =
      options.reaperIntervalMs ?? Math.max(1_000, Math.min(30_000, Math.floor(this.idleTimeoutMs / 2)));
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());

    this.startReaper();
  }

  get activeCount(): number {
    return this.conversationMap.size + this.pendingMap.size;
  }

  async acquireForConversation(conversationId: string): Promise<DownstreamTarget> {
    if (this.closed) {
      throw new Error("DockerGvisorProvider is closed");
    }

    const existing = this.conversationMap.get(conversationId);
    if (existing && !existing.stopping) {
      existing.lastActivityAt = this.now();
      return existing.target;
    }

    const spawnKey = `conv:${conversationId}`;
    let inFlight = this.inFlightSpawns.get(spawnKey);
    if (!inFlight) {
      inFlight = this.spawnSandbox({ conversationId })
        .then((sandbox) => {
          if (this.closed) {
            void this.destroySandbox(sandbox, "provider closed during spawn");
            throw new Error("DockerGvisorProvider closed during spawn");
          }
          this.conversationMap.set(conversationId, sandbox);
          return sandbox;
        })
        .finally(() => {
          this.inFlightSpawns.delete(spawnKey);
        });
      this.inFlightSpawns.set(spawnKey, inFlight);
    }

    const sandbox = await inFlight;
    sandbox.lastActivityAt = this.now();
    return sandbox.target;
  }

  async acquirePending(requestId: string): Promise<DownstreamTarget> {
    if (this.closed) {
      throw new Error("DockerGvisorProvider is closed");
    }

    const existing = this.pendingMap.get(requestId);
    if (existing && !existing.stopping) {
      existing.lastActivityAt = this.now();
      return existing.target;
    }

    const spawnKey = `req:${requestId}`;
    let inFlight = this.inFlightSpawns.get(spawnKey);
    if (!inFlight) {
      inFlight = this.spawnSandbox({ pendingRequestId: requestId })
        .then((sandbox) => {
          if (this.closed) {
            void this.destroySandbox(sandbox, "provider closed during spawn");
            throw new Error("DockerGvisorProvider closed during spawn");
          }
          this.pendingMap.set(requestId, sandbox);
          return sandbox;
        })
        .finally(() => {
          this.inFlightSpawns.delete(spawnKey);
        });
      this.inFlightSpawns.set(spawnKey, inFlight);
    }

    const sandbox = await inFlight;
    sandbox.lastActivityAt = this.now();
    return sandbox.target;
  }

  bindPendingToConversation(
    requestId: string,
    conversationId: string,
  ): DownstreamTarget | undefined {
    const sandbox = this.pendingMap.get(requestId);
    if (!sandbox) return undefined;
    this.pendingMap.delete(requestId);
    sandbox.pendingRequestId = undefined;
    sandbox.conversationId = conversationId;
    sandbox.lastActivityAt = this.now();
    this.conversationMap.set(conversationId, sandbox);
    return sandbox.target;
  }

  releasePending(requestId: string): void {
    const sandbox = this.pendingMap.get(requestId);
    if (!sandbox) return;
    this.pendingMap.delete(requestId);
    void this.destroySandbox(sandbox, `pending request ${requestId} released`);
  }

  getTarget(conversationId: string): DownstreamTarget | undefined {
    const sandbox = this.conversationMap.get(conversationId);
    return sandbox && !sandbox.stopping ? sandbox.target : undefined;
  }

  async reapIdleOnce(): Promise<string[]> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const toReap: ManagedSandbox[] = [];

    for (const [convId, sandbox] of this.conversationMap) {
      if (!sandbox.stopping && sandbox.lastActivityAt <= cutoff) {
        this.conversationMap.delete(convId);
        toReap.push(sandbox);
      }
    }
    for (const [reqId, sandbox] of this.pendingMap) {
      if (!sandbox.stopping && sandbox.lastActivityAt <= cutoff) {
        this.pendingMap.delete(reqId);
        toReap.push(sandbox);
      }
    }

    const reapedIds: string[] = [];
    await Promise.all(
      toReap.map(async (sandbox) => {
        await this.destroySandbox(sandbox, "idle timeout");
        reapedIds.push(sandbox.containerId);
      }),
    );
    return reapedIds;
  }

  closeAll(): void {
    void this.closeAllAsync();
  }

  async closeAllAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    const allSandboxes = [...this.conversationMap.values(), ...this.pendingMap.values()];
    this.conversationMap.clear();
    this.pendingMap.clear();

    await Promise.all(
      allSandboxes.map((sandbox) => this.destroySandbox(sandbox, "shutdown")),
    );
  }

  private startReaper(): void {
    if (this.reaperTimer !== null) return;
    this.reaperTimer = setInterval(() => {
      void this.reapIdleOnce().catch((err) => {
        this.options.logger?.error(`Idle reaper error: ${String(err)}`);
      });
    }, this.reaperIntervalMs);
    // Allow process to exit cleanly even if timer is active
    if (typeof this.reaperTimer === "object" && "unref" in this.reaperTimer) {
      this.reaperTimer.unref();
    }
  }

  private async spawnSandbox(scope: {
    conversationId?: string;
    pendingRequestId?: string;
  }): Promise<ManagedSandbox> {
    const key = scope.conversationId ?? scope.pendingRequestId ?? "ephemeral";
    const containerName = makeContainerName(key);
    const capabilityToken = randomBytes(32).toString("hex");

    const labels: Record<string, string> = {
      [MANAGED_LABEL_KEY]: MANAGED_LABEL_VALUE,
    };
    if (scope.conversationId) {
      labels["letta-sandbox.conversation"] = scope.conversationId;
    }

    this.options.logger?.info(
      `Spawning sandbox container ${containerName} (runtime=${this.options.runtime || "default"}) for ${key}`,
    );

    const containerId = await this.docker.runContainer({
      name: containerName,
      image: this.options.image,
      runtime: this.options.runtime,
      containerPort: this.containerPort,
      memoryLimit: this.options.memoryLimit,
      cpuLimit: this.options.cpuLimit,
      pidsLimit: this.options.pidsLimit,
      network: this.options.network,
      labels,
      env: {
        LETTA_API_KEY: this.options.lettaApiKey,
        LETTA_SERVER_URL: this.options.lettaServerUrl,
        LETTA_WS_TOKEN: capabilityToken,
        LETTA_LISTEN_PORT: String(this.containerPort),
      },
    });

    try {
      const published = await this.docker.getPublishedPort(containerId, this.containerPort);
      const httpUrl = `http://${published.host}:${published.port}`;
      const wsUrl = `ws://${published.host}:${published.port}/ws`;

      await waitForDownstreamHealth(httpUrl, {
        timeoutMs: this.startTimeoutMs,
        pollIntervalMs: 100,
        token: capabilityToken,
        fetchImpl: this.options.fetchImpl,
      });

      const id = `sbx-${containerName.slice("letta-sbx-".length)}`;
      let sandbox!: ManagedSandbox;

      const client = new DownstreamClient({
        wsUrl,
        token: capabilityToken,
        reconnectBaseDelayMs: this.options.reconnectBaseDelayMs,
        reconnectMaxDelayMs: this.options.reconnectMaxDelayMs,
        onMessage: (raw) => {
          sandbox.lastActivityAt = this.now();
          this.options.onMessage(sandbox.target, raw);
        },
        onError: (err) => {
          if (!sandbox.stopping) {
            this.options.logger?.error(`Sandbox ${id} WS error: ${String(err)}`);
          }
        },
      });

      const target: DownstreamTarget = {
        id,
        send: (raw) => {
          sandbox.lastActivityAt = this.now();
          return client.send(raw);
        },
        close: () => {
          void this.destroySandbox(sandbox, "target closed");
        },
      };

      sandbox = {
        id,
        containerId,
        wsUrl,
        client,
        target,
        lastActivityAt: this.now(),
        conversationId: scope.conversationId,
        pendingRequestId: scope.pendingRequestId,
        stopping: false,
      };

      await client.connect();
      this.options.logger?.info(`Sandbox ${id} ready at ${wsUrl} (container=${containerId.slice(0, 12)})`);
      return sandbox;
    } catch (err) {
      this.options.logger?.error(
        `Failed to initialize sandbox ${containerName} (${containerId.slice(0, 12)}), cleaning up: ${String(err)}`,
      );
      await this.docker.stopContainer(containerId).catch(() => {});
      throw err;
    }
  }

  private async destroySandbox(sandbox: ManagedSandbox, reason: string): Promise<void> {
    if (sandbox.stopping) return;
    sandbox.stopping = true;
    sandbox.client.close();
    this.options.logger?.info(
      `Reaping sandbox ${sandbox.id} (container=${sandbox.containerId.slice(0, 12)}, reason=${reason})`,
    );
    try {
      await this.docker.stopContainer(sandbox.containerId);
    } catch (err) {
      this.options.logger?.warn(
        `Failed to stop container ${sandbox.containerId.slice(0, 12)}: ${String(err)}`,
      );
    }
  }
}
