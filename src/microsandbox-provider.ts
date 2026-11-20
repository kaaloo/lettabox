import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { DownstreamClient } from "./downstream.ts";
import { CliMsbRunner, type MsbRunner } from "./msb-runner.ts";
import { waitForDownstreamHealth } from "./register.ts";
import type { ConversationTargetProvider, DownstreamTarget } from "./router.ts";

export interface SandboxLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const MANAGED_LABEL_KEY = "letta-sandbox.managed";
export const MANAGED_LABEL_VALUE = "true";

export interface MicrosandboxProviderOptions {
  image: string;
  msbBin?: string;
  guestPort?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  lettaApiKey: string;
  lettaServerUrl: string;
  useSecretInjection?: boolean;
  command?: string[];
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
  startTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  msb?: MsbRunner;
  allocatePort?: () => Promise<number>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: SandboxLogger;
  onMessage: (target: DownstreamTarget, raw: string) => void;
}

interface ManagedMicrosandbox {
  readonly id: string;
  readonly sandboxName: string;
  readonly hostPort: number;
  readonly wsUrl: string;
  readonly client: DownstreamClient;
  readonly target: DownstreamTarget;
  lastActivityAt: number;
  conversationId?: string;
  pendingRequestId?: string;
  stopping: boolean;
}

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

export class MicrosandboxProvider implements ConversationTargetProvider {
  private readonly options: MicrosandboxProviderOptions;
  private readonly msb: MsbRunner;
  private readonly guestPort: number;
  private readonly idleTimeoutMs: number;
  private readonly reaperIntervalMs: number;
  private readonly startTimeoutMs: number;
  private readonly allocatePort: () => Promise<number>;
  private readonly now: () => number;

  private readonly conversationMap = new Map<string, ManagedMicrosandbox>();
  private readonly pendingMap = new Map<string, ManagedMicrosandbox>();
  private readonly inFlightSpawns = new Map<string, Promise<ManagedMicrosandbox>>();
  private readonly reservedPorts = new Set<number>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: MicrosandboxProviderOptions) {
    this.options = options;
    this.msb = options.msb ?? new CliMsbRunner(options.msbBin);
    this.guestPort = options.guestPort ?? 4500;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
    this.reaperIntervalMs =
      options.reaperIntervalMs ??
      Math.max(1_000, Math.min(30_000, Math.floor(this.idleTimeoutMs / 2)));
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.allocatePort = options.allocatePort ?? allocateEphemeralLoopbackPort;
    this.now = options.now ?? (() => Date.now());

    this.startReaper();
  }

  get activeCount(): number {
    return this.conversationMap.size + this.pendingMap.size;
  }

  async acquireForConversation(conversationId: string): Promise<DownstreamTarget> {
    if (this.closed) {
      throw new Error("MicrosandboxProvider is closed");
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
            throw new Error("MicrosandboxProvider closed during spawn");
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
      throw new Error("MicrosandboxProvider is closed");
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
            throw new Error("MicrosandboxProvider closed during spawn");
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
    const toReap: ManagedMicrosandbox[] = [];

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

  private async spawnSandbox(scope: {
    conversationId?: string;
    pendingRequestId?: string;
  }): Promise<ManagedMicrosandbox> {
    const key = scope.conversationId ?? scope.pendingRequestId ?? "ephemeral";
    const sandboxName = makeMsbSandboxName(key);
    const capabilityToken = randomBytes(32).toString("hex");
    const hostPort = await this.reserveHostPort();

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
      `Spawning microsandbox ${sandboxName} (port=127.0.0.1:${hostPort}->${this.guestPort}, secretProxy=${useSecretInjection}) for ${key}`,
    );

    let createdName = sandboxName;
    try {
      createdName = await this.msb.runSandbox({
        name: sandboxName,
        image: this.options.image,
        hostPort,
        guestPort: this.guestPort,
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
      this.reservedPorts.delete(hostPort);
      throw err;
    }

    try {
      const httpUrl = `http://127.0.0.1:${hostPort}`;
      const wsUrl = `ws://127.0.0.1:${hostPort}/ws`;

      await waitForDownstreamHealth(httpUrl, {
        timeoutMs: this.startTimeoutMs,
        pollIntervalMs: 100,
        token: capabilityToken,
        fetchImpl: this.options.fetchImpl,
      });

      const id = `msb-${createdName.slice("letta-msb-".length)}`;
      let sandbox!: ManagedMicrosandbox;

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
          void this.destroySandbox(sandbox, "target closed");
        },
      };

      sandbox = {
        id,
        sandboxName: createdName,
        hostPort,
        wsUrl,
        client,
        target,
        lastActivityAt: this.now(),
        conversationId: scope.conversationId,
        pendingRequestId: scope.pendingRequestId,
        stopping: false,
      };

      await client.connect();
      this.options.logger?.info(`Microsandbox ${id} ready at ${wsUrl}`);
      return sandbox;
    } catch (err) {
      this.options.logger?.error(
        `Failed to initialize microsandbox ${createdName}, cleaning up: ${String(err)}`,
      );
      this.reservedPorts.delete(hostPort);
      await this.msb.removeSandbox(createdName).catch(() => {});
      throw err;
    }
  }

  private async destroySandbox(sandbox: ManagedMicrosandbox, reason: string): Promise<void> {
    if (sandbox.stopping) return;
    sandbox.stopping = true;
    sandbox.client.close();
    this.reservedPorts.delete(sandbox.hostPort);
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
