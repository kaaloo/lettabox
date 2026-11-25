import { decodeWsData } from "./protocol.ts";

export interface DownstreamClientOptions {
  wsUrl: string;
  token?: string;
  headers?: Record<string, string>;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnectAttempts?: number;
  maxQueuedMessages?: number;
  onMessage: (raw: string) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onPermanentClose?: (code: number, reason: string) => void;
  onError?: (err: unknown) => void;
}

export class DownstreamClient {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly headers?: Record<string, string>;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly maxReconnectAttempts?: number;
  private readonly maxQueuedMessages: number;
  private readonly onMessage: (raw: string) => void;
  private readonly onOpenCb?: () => void;
  private readonly onCloseCb?: (code: number, reason: string) => void;
  private readonly onPermanentCloseCb?: (code: number, reason: string) => void;
  private readonly onErrorCb?: (err: unknown) => void;

  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outboundQueue: string[] = [];

  constructor(options: DownstreamClientOptions) {
    this.wsUrl = options.wsUrl;
    this.token = options.token;
    this.headers = options.headers;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts;
    this.maxQueuedMessages = options.maxQueuedMessages ?? 256;
    this.onMessage = options.onMessage;
    this.onOpenCb = options.onOpen;
    this.onCloseCb = options.onClose;
    this.onPermanentCloseCb = options.onPermanentClose;
    this.onErrorCb = options.onError;
  }

  connect(): Promise<void> {
    this.closed = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.openSocket(
        () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(raw: string): boolean {
    if (this.closed) {
      return false;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
      return true;
    }
    if (this.outboundQueue.length >= this.maxQueuedMessages) {
      this.outboundQueue.shift();
    }
    this.outboundQueue.push(raw);
    return false;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.outboundQueue.length = 0;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "Proxy shutting down");
      }
    }
  }

  private openSocket(onFirstOpen?: () => void, onFirstError?: (err: unknown) => void): void {
    if (this.closed) return;

    const options: Bun.WebSocketOptions = {};
    const mergedHeaders: Record<string, string> = {
      ...this.headers,
    };
    if (this.token) {
      mergedHeaders.Authorization = `Bearer ${this.token}`;
    }
    if (Object.keys(mergedHeaders).length > 0) {
      options.headers = mergedHeaders;
    }

    const socket = new WebSocket(this.wsUrl, options);
    this.ws = socket;
    let openedOnce = false;

    socket.addEventListener("open", () => {
      if (this.ws !== socket || this.closed) {
        socket.close(1000, "Stale socket");
        return;
      }
      openedOnce = true;
      this.reconnectAttempts = 0;
      this.flushQueue();
      this.onOpenCb?.();
      onFirstOpen?.();
    });

    socket.addEventListener("message", (event) => {
      if (this.ws !== socket || this.closed) return;
      const decoded = decodeWsData(event.data);
      if (decoded !== null) {
        this.onMessage(decoded);
      }
    });

    socket.addEventListener("error", (event) => {
      if (this.ws !== socket) return;
      this.onErrorCb?.(event);
      if (!openedOnce && onFirstError) {
        onFirstError(new Error(`Failed to connect to downstream WebSocket ${this.wsUrl}`));
      }
    });

    socket.addEventListener("close", (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.onCloseCb?.(event.code, event.reason);
      if (!openedOnce && onFirstError) {
        onFirstError(
          new Error(
            `Downstream WebSocket closed before opening (${event.code}: ${event.reason || "no reason"})`,
          ),
        );
      }
      if (!this.closed) {
        this.scheduleReconnect(event.code, event.reason);
      }
    });
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.outboundQueue.length > 0) {
      const next = this.outboundQueue.shift();
      if (next !== undefined) {
        this.ws.send(next);
      }
    }
  }

  private scheduleReconnect(code: number, reason: string): void {
    if (this.closed || this.reconnectTimer !== null) return;
    if (
      this.maxReconnectAttempts !== undefined &&
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      this.closed = true;
      this.outboundQueue.length = 0;
      this.onPermanentCloseCb?.(code, reason);
      return;
    }
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempts,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
