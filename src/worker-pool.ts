import { DownstreamClient } from "./downstream.ts";
import type { ConversationTargetProvider, DownstreamTarget } from "./router.ts";

export interface StaticWorkerPoolOptions {
  workerUrls: string[];
  fallbackTarget: DownstreamTarget;
  token?: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onMessage: (target: DownstreamTarget, raw: string) => void;
  onWorkerOpen?: (workerId: string, url: string) => void;
  onWorkerClose?: (workerId: string, code: number, reason: string) => void;
  onWorkerError?: (workerId: string, err: unknown) => void;
}

interface ManagedWorker {
  readonly id: string;
  readonly url: string;
  readonly client: DownstreamClient;
  readonly target: DownstreamTarget;
  connectPromise: Promise<void> | null;
}

export class StaticWorkerPool implements ConversationTargetProvider {
  private readonly workers: ManagedWorker[] = [];
  private readonly fallbackTarget: DownstreamTarget;
  private readonly conversationMap = new Map<string, ManagedWorker>();
  private readonly pendingMap = new Map<string, ManagedWorker>();
  private nextWorkerIndex = 0;

  constructor(options: StaticWorkerPoolOptions) {
    this.fallbackTarget = options.fallbackTarget;

    for (let i = 0; i < options.workerUrls.length; i += 1) {
      const url = options.workerUrls[i]!;
      const id = `worker-${i + 1}`;
      let managed: ManagedWorker;

      const client = new DownstreamClient({
        wsUrl: url,
        token: options.token,
        reconnectBaseDelayMs: options.reconnectBaseDelayMs,
        reconnectMaxDelayMs: options.reconnectMaxDelayMs,
        onMessage: (raw) => options.onMessage(managed.target, raw),
        onOpen: () => options.onWorkerOpen?.(id, url),
        onClose: (code, reason) => options.onWorkerClose?.(id, code, reason),
        onError: (err) => options.onWorkerError?.(id, err),
      });

      const target: DownstreamTarget = {
        id,
        send: (raw) => client.send(raw),
        close: () => client.close(),
      };

      managed = {
        id,
        url,
        client,
        target,
        connectPromise: null,
      };
      this.workers.push(managed);
    }
  }

  get workerCount(): number {
    return this.workers.length;
  }

  async acquireForConversation(conversationId: string): Promise<DownstreamTarget> {
    if (this.workers.length === 0) {
      return this.fallbackTarget;
    }

    let worker = this.conversationMap.get(conversationId);
    if (!worker) {
      worker = this.pickNextWorker();
      this.conversationMap.set(conversationId, worker);
    }

    await this.ensureConnected(worker);
    return worker.target;
  }

  async acquirePending(requestId: string): Promise<DownstreamTarget> {
    if (this.workers.length === 0) {
      return this.fallbackTarget;
    }

    let worker = this.pendingMap.get(requestId);
    if (!worker) {
      worker = this.pickNextWorker();
      this.pendingMap.set(requestId, worker);
    }

    await this.ensureConnected(worker);
    return worker.target;
  }

  bindPendingToConversation(
    requestId: string,
    conversationId: string,
  ): DownstreamTarget | undefined {
    const worker = this.pendingMap.get(requestId);
    if (!worker) return undefined;
    this.pendingMap.delete(requestId);
    this.conversationMap.set(conversationId, worker);
    return worker.target;
  }

  releasePending(requestId: string): void {
    this.pendingMap.delete(requestId);
  }

  getTarget(conversationId: string): DownstreamTarget | undefined {
    if (this.workers.length === 0) {
      return this.fallbackTarget;
    }
    return this.conversationMap.get(conversationId)?.target;
  }

  closeAll(): void {
    this.conversationMap.clear();
    this.pendingMap.clear();
    for (const worker of this.workers) {
      worker.client.close();
      worker.connectPromise = null;
    }
  }

  private pickNextWorker(): ManagedWorker {
    const worker = this.workers[this.nextWorkerIndex % this.workers.length]!;
    this.nextWorkerIndex += 1;
    return worker;
  }

  private async ensureConnected(worker: ManagedWorker): Promise<void> {
    if (worker.client.isOpen) return;
    if (!worker.connectPromise) {
      worker.connectPromise = worker.client.connect().catch((err) => {
        worker.connectPromise = null;
        throw err;
      });
    }
    await worker.connectPromise;
  }
}
