import {
  DEFAULT_CONVERSATION_ID,
  extractRoutingEnvelope,
  PTY_COMMAND_TYPES,
  parseJsonObject,
  rewriteEventSeq,
  STATELESS_CONVERSATION_CRUD_TYPES,
  summarizeFrame,
} from "./protocol.ts";

export interface DownstreamTarget {
  readonly id: string;
  send(raw: string): boolean;
  close(): void;
}

export interface ConversationTargetProvider {
  acquireForConversation(conversationId: string): Promise<DownstreamTarget>;
  acquirePending(requestId: string): Promise<DownstreamTarget>;
  bindPendingToConversation(
    requestId: string,
    conversationId: string,
  ): DownstreamTarget | undefined;
  releasePending(requestId: string): void;
  getTarget(conversationId: string): DownstreamTarget | undefined;
  closeAll(): void;
}

export interface RouterLogger {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface TurnFinishedEvent {
  conversationId: string;
  stopReason?: string;
}

export interface EnvelopeRouterOptions {
  controlPlane: DownstreamTarget;
  conversationProvider: ConversationTargetProvider;
  sendToUpstream: (raw: string, frameType?: string) => "control" | "stream" | null;
  debugFrames?: boolean;
  logger?: RouterLogger;
  maxTrackedRequests?: number;
  onTurnFinished?: (event: TurnFinishedEvent) => void;
  onConversationManualTitle?: (conversationId: string) => void;
}

interface TrackedInboundRequest {
  target: DownstreamTarget;
  isCreateConversation: boolean;
}

export class EnvelopeRouter {
  private readonly controlPlane: DownstreamTarget;
  private readonly conversationProvider: ConversationTargetProvider;
  private readonly sendToUpstream: (raw: string, frameType?: string) => "control" | "stream" | null;
  private readonly debugFrames: boolean;
  private readonly logger?: RouterLogger;
  private readonly maxTrackedRequests: number;
  private readonly onTurnFinished?: (event: TurnFinishedEvent) => void;
  private readonly onConversationManualTitle?: (conversationId: string) => void;

  private eventSeq = 0;
  private readonly inboundRequests = new Map<string, TrackedInboundRequest>();
  private readonly outboundControlRequests = new Map<string, DownstreamTarget>();
  private readonly orderedQueues = new Map<string, Promise<void>>();

  constructor(options: EnvelopeRouterOptions) {
    this.controlPlane = options.controlPlane;
    this.conversationProvider = options.conversationProvider;
    this.sendToUpstream = options.sendToUpstream;
    this.debugFrames = options.debugFrames ?? false;
    this.logger = options.logger;
    this.maxTrackedRequests = options.maxTrackedRequests ?? 1_000;
    this.onTurnFinished = options.onTurnFinished;
    this.onConversationManualTitle = options.onConversationManualTitle;
  }

  get currentEventSeq(): number {
    return this.eventSeq;
  }

  resetEventSeq(): void {
    this.eventSeq = 0;
  }

  getTrackedInboundTarget(requestId: string): DownstreamTarget | undefined {
    return this.inboundRequests.get(requestId)?.target;
  }

  handleUpstreamMessage(raw: string, channel: "control" | "stream" = "control"): Promise<void> {
    const frame = parseJsonObject(raw);
    const env = extractRoutingEnvelope(frame);

    const queueKey = this.computeOrderKey(env);
    const prev = this.orderedQueues.get(queueKey) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.dispatchUpstream(raw, frame, env, channel));

    this.orderedQueues.set(queueKey, next);
    void next.finally(() => {
      if (this.orderedQueues.get(queueKey) === next) {
        this.orderedQueues.delete(queueKey);
      }
    });
    return next;
  }

  handleDownstreamMessage(source: DownstreamTarget, raw: string): void {
    const frame = parseJsonObject(raw);
    const env = extractRoutingEnvelope(frame);

    // Track worker-initiated control_request so upstream control_response routes back cleanly
    if (env.type === "control_request" && env.requestId) {
      this.trackBounded(this.outboundControlRequests, env.requestId, source);
    }

    // Bind pending create_conversation worker once runtime_start_response returns conversation_id
    if (env.requestId) {
      const tracked = this.inboundRequests.get(env.requestId);
      if (tracked) {
        if (env.type === "runtime_start_response" && tracked.isCreateConversation) {
          const convId = env.runtimeConversationId ?? env.topLevelConversationId;
          if (convId && convId !== DEFAULT_CONVERSATION_ID) {
            this.conversationProvider.bindPendingToConversation(env.requestId, convId);
          } else {
            this.conversationProvider.releasePending(env.requestId);
          }
          this.inboundRequests.delete(env.requestId);
        } else if (env.type && env.type.endsWith("_response")) {
          this.inboundRequests.delete(env.requestId);
        }
      }
    }

    const { raw: outRaw, rewrittenSeq } = rewriteEventSeq(raw, frame, () => {
      this.eventSeq += 1;
      return this.eventSeq;
    });

    const channel = this.sendToUpstream(outRaw, env.type);
    if (this.debugFrames) {
      const seqNote =
        rewrittenSeq !== undefined && env.eventSeq !== rewrittenSeq
          ? ` (rewrote seq ${env.eventSeq}->${rewrittenSeq})`
          : "";
      this.logger?.debug(
        `${source.id} -> upstream(${channel ?? "none"}): ${summarizeFrame(frame)}${seqNote}`,
      );
    }

    if (env.type === "turn_finished" && this.onTurnFinished) {
      const convId = env.runtimeConversationId ?? env.topLevelConversationId;
      if (convId && convId !== DEFAULT_CONVERSATION_ID) {
        const stopReason = typeof frame?.stop_reason === "string" ? frame.stop_reason : undefined;
        this.onTurnFinished({ conversationId: convId, stopReason });
      }
    }
  }

  private computeOrderKey(env: ReturnType<typeof extractRoutingEnvelope>): string {
    if (
      env.type &&
      (STATELESS_CONVERSATION_CRUD_TYPES.has(env.type) || PTY_COMMAND_TYPES.has(env.type))
    ) {
      return "control-plane";
    }
    if (env.type === "runtime_start") {
      if (env.topLevelConversationId && env.topLevelConversationId !== DEFAULT_CONVERSATION_ID) {
        return `conv:${env.topLevelConversationId}`;
      }
      if (env.hasCreateConversation && env.requestId) {
        return `create:${env.requestId}`;
      }
    }
    const convId = env.runtimeConversationId ?? env.topLevelConversationId;
    if (convId && convId !== DEFAULT_CONVERSATION_ID) {
      return `conv:${convId}`;
    }
    return "control-plane";
  }

  private async dispatchUpstream(
    raw: string,
    frame: Record<string, unknown> | null,
    env: ReturnType<typeof extractRoutingEnvelope>,
    channel: "control" | "stream",
  ): Promise<void> {
    let target: DownstreamTarget = this.controlPlane;
    let isCreateConversation = false;

    try {
      const resolved = await this.resolveTarget(env);
      target = resolved.target;
      isCreateConversation = resolved.isCreateConversation;
    } catch (err) {
      this.logger?.error(`Failed to resolve target for ${summarizeFrame(frame)}: ${String(err)}`);
      return;
    }

    if (env.requestId) {
      this.trackBounded(this.inboundRequests, env.requestId, {
        target,
        isCreateConversation,
      });
    }

    if (env.type === "conversation_update" && this.onConversationManualTitle) {
      const convId = env.topLevelConversationId ?? env.runtimeConversationId;
      const body = frame?.body;
      const summary =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).summary
          : undefined;
      if (
        convId &&
        convId !== DEFAULT_CONVERSATION_ID &&
        typeof summary === "string" &&
        summary.trim().length > 0
      ) {
        this.onConversationManualTitle(convId);
      }
    }

    if (this.debugFrames) {
      this.logger?.debug(`upstream(${channel}) -> ${target.id}: ${summarizeFrame(frame)}`);
    }

    target.send(raw);
  }

  private async resolveTarget(
    env: ReturnType<typeof extractRoutingEnvelope>,
  ): Promise<{ target: DownstreamTarget; isCreateConversation: boolean }> {
    // 1. Stateless conversation CRUD & PTY commands always go to control-plane
    if (
      env.type &&
      (STATELESS_CONVERSATION_CRUD_TYPES.has(env.type) || PTY_COMMAND_TYPES.has(env.type))
    ) {
      return { target: this.controlPlane, isCreateConversation: false };
    }

    // 2. runtime_start carries top-level conversation_id or create_conversation
    if (env.type === "runtime_start") {
      if (env.topLevelConversationId && env.topLevelConversationId !== DEFAULT_CONVERSATION_ID) {
        const target = await this.conversationProvider.acquireForConversation(
          env.topLevelConversationId,
        );
        return { target, isCreateConversation: false };
      }
      if (env.hasCreateConversation && env.requestId) {
        const target = await this.conversationProvider.acquirePending(env.requestId);
        return { target, isCreateConversation: true };
      }
      return { target: this.controlPlane, isCreateConversation: false };
    }

    // 3. Conversation-scoped frames (runtime.conversation_id or top-level conversation_id)
    const convId = env.runtimeConversationId ?? env.topLevelConversationId;
    if (convId) {
      if (convId === DEFAULT_CONVERSATION_ID) {
        return { target: this.controlPlane, isCreateConversation: false };
      }
      // Passive UI syncs should hit an already-running conversation sandbox, but must
      // not cold-spawn new sandboxes for every open tab before user interaction.
      if (env.type === "sync") {
        const existing = this.conversationProvider.getTarget(convId);
        return { target: existing ?? this.controlPlane, isCreateConversation: false };
      }
      const target = await this.conversationProvider.acquireForConversation(convId);
      return { target, isCreateConversation: false };
    }

    // 4. Reply to a worker-initiated control_request (correlated by request_id)
    if (env.requestId) {
      const correlated = this.outboundControlRequests.get(env.requestId);
      if (correlated) {
        this.outboundControlRequests.delete(env.requestId);
        return { target: correlated, isCreateConversation: false };
      }
    }

    // 5. All computer-level / unscoped frames go to control-plane
    return { target: this.controlPlane, isCreateConversation: false };
  }

  private trackBounded<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= this.maxTrackedRequests && !map.has(key)) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
      }
    }
    map.set(key, value);
  }
}
