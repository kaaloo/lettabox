import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { MsbComputeType, SandboxBackend } from "./config.ts";
import { DownstreamClient } from "./downstream.ts";
import { type MsbRunner, type MsbRunResult, SdkMsbRunner } from "./msb-runner.ts";
import { parseJsonObject } from "./protocol.ts";
import { waitForDownstreamHealth } from "./register.ts";
import type { ConversationTargetProvider, DownstreamTarget } from "./router.ts";

export interface SandboxLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const MANAGED_LABEL_KEY = "letta-sandbox.managed";
export const MANAGED_LABEL_VALUE = "true";

export interface ActiveSandboxInfo {
  id: string;
  sandboxName: string;
  conversationId?: string;
  hostPort?: number;
  serviceUrl?: string;
  busy: boolean;
  lastActivityAt: number;
}

export interface MicrosandboxProviderOptions {
  backend?: SandboxBackend;
  image: string;
  msbBin?: string;
  msbHome?: string;
  msbApiKey?: string;
  msbApiUrl?: string;
  msbProfile?: string;
  msbComputeType?: MsbComputeType;
  guestPort?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  warmPoolSize?: number;
  lettaApiKey: string;
  lettaServerUrl: string;
  useSecretInjection?: boolean;
  command?: string[];
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
  startTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  spawnFailureCooldownMs?: number;
  maxReconnectAttempts?: number;
  msb?: MsbRunner;
  allocatePort?: () => Promise<number>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: SandboxLogger;
  onMessage: (target: DownstreamTarget, raw: string) => void;
  onBusyChange?: (anyBusy: boolean) => void;
}

interface ManagedMicrosandbox {
  readonly id: string;
  readonly sandboxName: string;
  readonly hostPort?: number;
  readonly serviceUrl?: string;
  readonly wsUrl: string;
  readonly client: DownstreamClient;
  readonly target: DownstreamTarget;
  lastActivityAt: number;
  busy: boolean;
  conversationId?: string;
  pendingRequestId?: string;
  stopping: boolean;
}

const BUSY_LOOP_STATUSES = new Set(["running", "processing", "waiting", "thinking", "streaming"]);
const IDLE_LOOP_STATUSES = new Set(["idle", "ready", "completed", "error", "aborted", "cancelled"]);

export const DEFAULT_MSB_BOOTSTRAP_SCRIPT =
  'umask 077; printf "%s\\n" "$LETTA_WS_TOKEN" > /tmp/letta-ws-token; unset LETTA_WS_TOKEN; exec letta server --listen "ws://0.0.0.0:${LETTA_LISTEN_PORT:-4500}" --ws-auth capability-token --ws-token-file /tmp/letta-ws-token';

export function makeMsbSandboxName(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const nonce = randomBytes(3).toString("hex");
  return `letta-msb-${hash}-${nonce}`;
}

export function allocateEphemeralLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral loopback port")));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function updateBusyFromDownstreamFrame(sandbox: ManagedMicrosandbox, raw: string): void {
  const frame = parseJsonObject(raw);
  if (!frame || typeof frame.type !== "string") return;

  if (frame.type === "input_accepted") {
    sandbox.busy = true;
    return;
  }
  if (frame.type === "turn_finished") {
    sandbox.busy = false;
    return;
  }
  if (frame.type === "update_loop_status") {
    const status =
      typeof frame.status === "string"
        ? frame.status.toLowerCase()
        : typeof frame.loop_status === "string"
          ? frame.loop_status.toLowerCase()
          : undefined;
    if (status && BUSY_LOOP_STATUSES.has(status)) {
      sandbox.busy = true;
    } else if (status && IDLE_LOOP_STATUSES.has(status)) {
      sandbox.busy = false;
    }
  }
}

export class MicrosandboxProvider implements ConversationTargetProvider {
  private readonly options: MicrosandboxProviderOptions;
  private readonly backend: SandboxBackend;
  private readonly msb: MsbRunner;
  private readonly guestPort: number;
  private readonly warmPoolSize: number;
  private readonly idleTimeoutMs: number;
  private readonly reaperIntervalMs: number;
  private readonly startTimeoutMs: number;
  private readonly spawnFailureCooldownMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly allocatePort: () => Promise<number>;
  private readonly now: () => number;

  private readonly conversationMap = new Map<string, ManagedMicrosandbox>();
  private readonly pendingMap = new Map<string, ManagedMicrosandbox>();
  private readonly inFlightSpawns = new Map<string, Promise<ManagedMicrosandbox>>();
  private readonly spawnCooldowns = new Map<
    string,
    { failures: number; retryAfter: number; lastError: string }
  >();
  private readonly warmPool: ManagedMicrosandbox[] = [];
  private readonly warmRefills = new Set<Promise<void>>();
  private warmRefillRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private warmRefillFailures = 0;
  private readonly reservedPorts = new Set<number>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private lastAnyBusy = false;

  constructor(options: MicrosandboxProviderOptions) {
    this.options = options;
    this.backend = options.backend ?? "local";
    this.msb =
      options.msb ??
      new SdkMsbRunner({
        backend: this.backend,
        msbBin: options.msbBin,
        msbHome: options.msbHome,
        msbApiKey: options.msbApiKey,
        msbApiUrl: options.msbApiUrl,
        msbProfile: options.msbProfile,
        msbComputeType: options.msbComputeType,
        image: options.image,
        logger: options.logger,
      });
    this.guestPort = options.guestPort ?? 4500;
    this.warmPoolSize = Math.max(0, options.warmPoolSize ?? 0);
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.reaperIntervalMs =
      options.reaperIntervalMs ??
      Math.max(1_000, Math.min(30_000, Math.floor(this.idleTimeoutMs / 2)));
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.spawnFailureCooldownMs =
      options.spawnFailureCooldownMs ?? (this.backend === "cloud" ? 2_000 : 0);
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 2;
    this.allocatePort = options.allocatePort ?? allocateEphemeralLoopbackPort;
    this.now = options.now ?? (() => Date.now());

    this.startReaper();
  }

  async ensureReady(): Promise<void> {
    await this.msb.ensureReady?.(this.options.image);
    if (this.warmPoolSize > 0 && !this.closed) {
      this.options.logger?.info(
        `Pre-warming ${this.warmPoolSize} standby microsandbox(es) before connecting upstream...`,
      );
      this.refillWarmPool();
      await Promise.allSettled([...this.warmRefills]);
    }
  }

  get activeCount(): number {
    return this.conversationMap.size + this.pendingMap.size;
  }

  get warmPoolCount(): number {
    return this.warmPool.filter((s) => !s.stopping && s.client.isOpen).length;
  }

  listActiveSandboxes(): ActiveSandboxInfo[] {
    const all = [...this.conversationMap.values(), ...this.pendingMap.values()];
    return all
      .filter((s) => !s.stopping && !s.client.isClosed)
      .map((s) => ({
        id: s.id,
        sandboxName: s.sandboxName,
        conversationId: s.conversationId,
        ...(s.hostPort !== undefined ? { hostPort: s.hostPort } : {}),
        ...(s.serviceUrl !== undefined ? { serviceUrl: s.serviceUrl } : {}),
        busy: s.busy,
        lastActivityAt: s.lastActivityAt,
      }));
  }

  async acquireForConversation(conversationId: string): Promise<DownstreamTarget> {
    if (this.closed) {
      throw new Error("MicrosandboxProvider is closed");
    }

    const existing = this.conversationMap.get(conversationId);
    if (existing) {
      if (!existing.stopping && !existing.client.isClosed) {
        existing.lastActivityAt = this.now();
        return existing.target;
      }
      // Evict dead/closed sandbox so a fresh microVM is spawned immediately
      this.conversationMap.delete(conversationId);
      void this.destroySandbox(existing, "evicted dead sandbox");
    }

    const spawnKey = `conv:${conversationId}`;
    let inFlight = this.inFlightSpawns.get(spawnKey);
    if (!inFlight) {
      this.assertNotInSpawnCooldown(spawnKey);

      const warm = this.claimWarmSandbox({ conversationId });
      if (warm) {
        this.spawnCooldowns.delete(spawnKey);
        this.conversationMap.set(conversationId, warm);
        return warm.target;
      }

      inFlight = this.spawnSandbox({ conversationId })
        .then((sandbox) => {
          this.spawnCooldowns.delete(spawnKey);
          if (this.closed) {
            void this.destroySandbox(sandbox, "provider closed during spawn");
            throw new Error("MicrosandboxProvider closed during spawn");
          }
          this.conversationMap.set(conversationId, sandbox);
          this.refillWarmPool();
          return sandbox;
        })
        .catch((err) => {
          this.recordSpawnFailure(spawnKey, err);
          throw err;
        })
        .finally(() => {
          this.inFlightSpawns.delete(spawnKey);
          this.notifyBusyChange();
        });
      this.inFlightSpawns.set(spawnKey, inFlight);
      this.notifyBusyChange();
    }

    const sandbox = await inFlight;
    sandbox.lastActivityAt = this.now();
    return sandbox.target;
  }

  async acquirePending(requestId: string): Promise<DownstreamTarget> {
    if (this.closed) {
      throw new Error("MicrosandboxProvider is closed");
    }

    const existing = this.pendingMap.get(requestId);
    if (existing) {
      if (!existing.stopping && !existing.client.isClosed) {
        existing.lastActivityAt = this.now();
        return existing.target;
      }
      this.pendingMap.delete(requestId);
      void this.destroySandbox(existing, "evicted dead pending sandbox");
    }

    const spawnKey = `req:${requestId}`;
    let inFlight = this.inFlightSpawns.get(spawnKey);
    if (!inFlight) {
      this.assertNotInSpawnCooldown(spawnKey);

      const warm = this.claimWarmSandbox({ pendingRequestId: requestId });
      if (warm) {
        this.spawnCooldowns.delete(spawnKey);
        this.pendingMap.set(requestId, warm);
        return warm.target;
      }

      inFlight = this.spawnSandbox({ pendingRequestId: requestId })
        .then((sandbox) => {
          this.spawnCooldowns.delete(spawnKey);
          if (this.closed) {
            void this.destroySandbox(sandbox, "provider closed during spawn");
            throw new Error("MicrosandboxProvider closed during spawn");
          }
          this.pendingMap.set(requestId, sandbox);
          this.refillWarmPool();
          return sandbox;
        })
        .catch((err) => {
          this.recordSpawnFailure(spawnKey, err);
          throw err;
        })
        .finally(() => {
          this.inFlightSpawns.delete(spawnKey);
          this.notifyBusyChange();
        });
      this.inFlightSpawns.set(spawnKey, inFlight);
      this.notifyBusyChange();
    }

    const sandbox = await inFlight;
    sandbox.lastActivityAt = this.now();
    return sandbox.target;
  }

  private assertNotInSpawnCooldown(spawnKey: string): void {
    if (this.spawnFailureCooldownMs <= 0) return;
    const entry = this.spawnCooldowns.get(spawnKey);
    if (!entry) return;
    const remainingMs = entry.retryAfter - this.now();
    if (remainingMs > 0) {
      throw new Error(
        `Sandbox spawn for ${spawnKey} in backoff for ${remainingMs}ms after ${entry.failures} failure(s): ${entry.lastError}`,
      );
    }
  }

  private recordSpawnFailure(spawnKey: string, err: unknown): void {
    if (this.spawnFailureCooldownMs <= 0 || this.closed) return;
    const prev = this.spawnCooldowns.get(spawnKey);
    const failures = (prev?.failures ?? 0) + 1;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 30_000;
    const delay = Math.min(this.spawnFailureCooldownMs * 2 ** (failures - 1), maxDelay);
    this.spawnCooldowns.set(spawnKey, {
      failures,
      retryAfter: this.now() + delay,
      lastError: String(err),
    });
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
    return sandbox && !sandbox.stopping && !sandbox.client.isClosed ? sandbox.target : undefined;
  }

  async reapIdleOnce(): Promise<string[]> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const toReap: ManagedMicrosandbox[] = [];

    for (const [convId, sandbox] of this.conversationMap) {
      if (!sandbox.stopping && !sandbox.busy && sandbox.lastActivityAt <= cutoff) {
        this.conversationMap.delete(convId);
        toReap.push(sandbox);
      }
    }
    for (const [reqId, sandbox] of this.pendingMap) {
      if (!sandbox.stopping && !sandbox.busy && sandbox.lastActivityAt <= cutoff) {
        this.pendingMap.delete(reqId);
        toReap.push(sandbox);
      }
    }

    const reapedNames: string[] = [];
    await Promise.all(
      toReap.map(async (sandbox) => {
        await this.destroySandbox(sandbox, "idle timeout");
        reapedNames.push(sandbox.sandboxName);
      }),
    );
    return reapedNames;
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
    if (this.warmRefillRetryTimer !== null) {
      clearTimeout(this.warmRefillRetryTimer);
      this.warmRefillRetryTimer = null;
    }

    const allSandboxes = [
      ...this.conversationMap.values(),
      ...this.pendingMap.values(),
      ...this.warmPool,
    ];
    this.conversationMap.clear();
    this.pendingMap.clear();
    this.warmPool.length = 0;

    await Promise.all([
      ...allSandboxes.map((sandbox) => this.destroySandbox(sandbox, "shutdown")),
      ...[...this.warmRefills],
    ]);
  }

  private claimWarmSandbox(scope: {
    conversationId?: string;
    pendingRequestId?: string;
  }): ManagedMicrosandbox | undefined {
    while (this.warmPool.length > 0) {
      const candidate = this.warmPool.shift();
      if (!candidate) break;
      if (candidate.stopping || !candidate.client.isOpen) {
        void this.destroySandbox(candidate, "evicted disconnected warm standby");
        continue;
      }
      candidate.conversationId = scope.conversationId;
      candidate.pendingRequestId = scope.pendingRequestId;
      candidate.lastActivityAt = this.now();
      const key = scope.conversationId ?? scope.pendingRequestId ?? "ephemeral";
      this.options.logger?.info(`Claimed warm microsandbox ${candidate.id} for ${key}`);
      this.refillWarmPool();
      return candidate;
    }
    return undefined;
  }

  private refillWarmPool(): void {
    if (this.closed || this.warmPoolSize <= 0) return;
    if (this.warmRefillRetryTimer !== null) {
      clearTimeout(this.warmRefillRetryTimer);
      this.warmRefillRetryTimer = null;
    }
    while (this.warmPool.length + this.warmRefills.size < this.warmPoolSize) {
      let failed = false;
      const refill = this.spawnSandbox({ warmStandby: true })
        .then((sandbox) => {
          this.warmRefillFailures = 0;
          if (this.closed) {
            return this.destroySandbox(sandbox, "provider closed during warm refill");
          }
          if (this.warmPool.length >= this.warmPoolSize) {
            return this.destroySandbox(sandbox, "warm pool already full");
          }
          this.warmPool.push(sandbox);
          return undefined;
        })
        .catch((err) => {
          failed = true;
          if (!this.closed) {
            this.options.logger?.warn(`Warm standby microsandbox refill failed: ${String(err)}`);
          }
        })
        .finally(() => {
          this.warmRefills.delete(refill);
          if (failed) {
            this.scheduleWarmRefillRetry();
          }
        });
      this.warmRefills.add(refill);
    }
  }

  private scheduleWarmRefillRetry(): void {
    if (this.closed || this.warmPoolSize <= 0 || this.warmRefillRetryTimer !== null) return;
    if (this.warmPool.length + this.warmRefills.size >= this.warmPoolSize) return;
    const baseDelay = this.options.reconnectBaseDelayMs ?? 1_000;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 30_000;
    const delay = Math.min(baseDelay * 2 ** this.warmRefillFailures, maxDelay);
    this.warmRefillFailures += 1;
    this.warmRefillRetryTimer = setTimeout(() => {
      this.warmRefillRetryTimer = null;
      this.refillWarmPool();
    }, delay);
    if (typeof this.warmRefillRetryTimer === "object" && "unref" in this.warmRefillRetryTimer) {
      this.warmRefillRetryTimer.unref();
    }
  }

  private startReaper(): void {
    if (this.reaperTimer !== null) return;
    this.reaperTimer = setInterval(() => {
      void this.reapIdleOnce().catch((err) => {
        this.options.logger?.error(`Microsandbox idle reaper error: ${String(err)}`);
      });
    }, this.reaperIntervalMs);
    if (typeof this.reaperTimer === "object" && "unref" in this.reaperTimer) {
      this.reaperTimer.unref();
    }
  }

  private async reserveHostPort(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await this.allocatePort();
      if (!this.reservedPorts.has(port)) {
        this.reservedPorts.add(port);
        return port;
      }
    }
    throw new Error("Failed to reserve a unique host port for microsandbox");
  }

  private evictSandbox(sandbox: ManagedMicrosandbox): void {
    if (sandbox.conversationId && this.conversationMap.get(sandbox.conversationId) === sandbox) {
      this.conversationMap.delete(sandbox.conversationId);
    }
    if (sandbox.pendingRequestId && this.pendingMap.get(sandbox.pendingRequestId) === sandbox) {
      this.pendingMap.delete(sandbox.pendingRequestId);
    }
    const warmIdx = this.warmPool.indexOf(sandbox);
    if (warmIdx !== -1) {
      this.warmPool.splice(warmIdx, 1);
      this.refillWarmPool();
    }
  }

  private async spawnSandbox(scope: {
    conversationId?: string;
    pendingRequestId?: string;
    warmStandby?: boolean;
  }): Promise<ManagedMicrosandbox> {
    const t0 = Date.now();
    const isCloud = this.backend === "cloud";
    const key =
      scope.conversationId ??
      scope.pendingRequestId ??
      (scope.warmStandby ? "warm-standby" : "ephemeral");
    const sandboxName = makeMsbSandboxName(key);
    const capabilityToken = randomBytes(32).toString("hex");
    const hostPort = isCloud ? undefined : await this.reserveHostPort();

    const labels: Record<string, string> = {
      [MANAGED_LABEL_KEY]: MANAGED_LABEL_VALUE,
    };
    if (scope.conversationId) {
      labels["letta-sandbox.conversation"] = scope.conversationId;
    }

    const parsedServerUrl = new URL(this.options.lettaServerUrl);
    const useSecretInjection =
      (this.options.useSecretInjection ?? true) && parsedServerUrl.protocol === "https:";

    const env: Record<string, string> = {
      LETTA_SERVER_URL: this.options.lettaServerUrl,
      LETTA_WS_TOKEN: capabilityToken,
      LETTA_LISTEN_PORT: String(this.guestPort),
    };
    if (!useSecretInjection) {
      env.LETTA_API_KEY = this.options.lettaApiKey;
    }

    this.options.logger?.info(
      isCloud
        ? `Spawning cloud microsandbox ${sandboxName} (guestPort=${this.guestPort}, secretProxy=${useSecretInjection}) for ${key}`
        : `Spawning microsandbox ${sandboxName} (port=127.0.0.1:${hostPort}->${this.guestPort}, secretProxy=${useSecretInjection}) for ${key}`,
    );

    let runResult: MsbRunResult;
    try {
      runResult = await this.msb.runSandbox({
        name: sandboxName,
        image: this.options.image,
        backend: this.backend,
        hostPort,
        guestPort: this.guestPort,
        ephemeral: isCloud ? true : undefined,
        cpus: this.options.cpuLimit,
        memory: this.options.memoryLimit,
        labels,
        env,
        secret: useSecretInjection
          ? {
              envName: "LETTA_API_KEY",
              value: this.options.lettaApiKey,
              allowedHosts: [parsedServerUrl.hostname],
              headers: ["Authorization"],
            }
          : undefined,
        entrypoint: this.options.command ? undefined : "/bin/sh",
        command: this.options.command ?? ["-c", DEFAULT_MSB_BOOTSTRAP_SCRIPT],
      });
    } catch (err) {
      if (hostPort !== undefined) {
        this.reservedPorts.delete(hostPort);
      }
      throw err;
    }
    const tBoot = Date.now();
    const createdName = runResult.name;
    const effectiveHostPort = runResult.hostPort ?? hostPort;
    const cloudHeaders = isCloud ? { "msb-skip-browser-warning": "1" } : undefined;

    try {
      const { httpUrl, wsUrl } = runResult;

      await waitForDownstreamHealth(httpUrl, {
        timeoutMs: this.startTimeoutMs,
        pollIntervalMs: isCloud ? 250 : 100,
        token: capabilityToken,
        headers: cloudHeaders,
        fetchImpl: this.options.fetchImpl,
      });
      const tHealth = Date.now();

      const id = `msb-${createdName.slice("letta-msb-".length)}`;
      let sandbox!: ManagedMicrosandbox;

      const client = new DownstreamClient({
        wsUrl,
        token: capabilityToken,
        headers: cloudHeaders,
        reconnectBaseDelayMs: this.options.reconnectBaseDelayMs,
        reconnectMaxDelayMs: this.options.reconnectMaxDelayMs,
        maxReconnectAttempts: this.maxReconnectAttempts,
        onMessage: (raw) => {
          sandbox.lastActivityAt = this.now();
          updateBusyFromDownstreamFrame(sandbox, raw);
          this.notifyBusyChange();
          this.options.onMessage(sandbox.target, raw);
        },
        onPermanentClose: (code, reason) => {
          if (sandbox.stopping) return;
          this.options.logger?.warn(
            `Microsandbox ${id} disconnected permanently (${code}: ${reason || "no reason"}); evicting for clean respawn`,
          );
          this.evictSandbox(sandbox);
          void this.destroySandbox(sandbox, "downstream disconnected permanently");
        },
        onError: (err) => {
          if (!sandbox.stopping) {
            this.options.logger?.error(`Microsandbox ${id} WS error: ${String(err)}`);
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
          this.evictSandbox(sandbox);
          void this.destroySandbox(sandbox, "target closed");
        },
      };

      sandbox = {
        id,
        sandboxName: createdName,
        hostPort: effectiveHostPort,
        serviceUrl: runResult.serviceUrl,
        wsUrl,
        client,
        target,
        lastActivityAt: this.now(),
        busy: false,
        conversationId: scope.conversationId,
        pendingRequestId: scope.pendingRequestId,
        stopping: false,
      };

      await client.connect();
      const tWs = Date.now();
      this.options.logger?.info(
        `Microsandbox ${id} ready at ${wsUrl} (boot=${tBoot - t0}ms, health=${tHealth - tBoot}ms, ws=${tWs - tHealth}ms, total=${tWs - t0}ms)`,
      );
      return sandbox;
    } catch (err) {
      const guestLogs = await this.msb.readSandboxLogs?.(createdName).catch(() => undefined);
      this.options.logger?.error(
        `Failed to initialize microsandbox ${createdName}, cleaning up: ${String(err)}${
          guestLogs ? `\n[guest logs]\n${guestLogs}` : ""
        }`,
      );
      if (hostPort !== undefined) {
        this.reservedPorts.delete(hostPort);
      }
      await this.msb.removeSandbox(createdName).catch(() => {});
      throw err;
    }
  }

  private notifyBusyChange(): void {
    const anyBusy = this.inFlightSpawns.size > 0 || this.listActiveSandboxes().some((s) => s.busy);
    if (anyBusy !== this.lastAnyBusy) {
      this.lastAnyBusy = anyBusy;
      this.options.onBusyChange?.(anyBusy);
    }
  }

  private async destroySandbox(sandbox: ManagedMicrosandbox, reason: string): Promise<void> {
    if (sandbox.stopping) return;
    sandbox.stopping = true;
    sandbox.busy = false;
    this.notifyBusyChange();
    sandbox.client.close();
    if (sandbox.hostPort !== undefined) {
      this.reservedPorts.delete(sandbox.hostPort);
    }
    this.options.logger?.info(
      `Reaping microsandbox ${sandbox.id} (name=${sandbox.sandboxName}, reason=${reason})`,
    );
    try {
      await this.msb.removeSandbox(sandbox.sandboxName);
    } catch (err) {
      this.options.logger?.warn(
        `Failed to remove microsandbox ${sandbox.sandboxName}: ${String(err)}`,
      );
    }
  }
}
