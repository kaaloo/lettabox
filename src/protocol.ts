export const STREAM_CHANNEL_MESSAGE_TYPES = new Set<string>([
  "stream_delta",
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
]);

export const STATELESS_CONVERSATION_CRUD_TYPES = new Set<string>([
  "conversation_retrieve",
  "conversation_update",
  "conversation_recompile",
  "conversation_fork",
  "conversation_messages_list",
  "conversation_compact",
]);

export const PTY_COMMAND_TYPES = new Set<string>([
  "terminal_spawn",
  "terminal_input",
  "terminal_resize",
  "terminal_kill",
]);

export const DEFAULT_CONVERSATION_ID = "default";

export type UpstreamChannel = "control" | "stream";

export interface AppServerInfo {
  lettaCodeVersion?: string;
  letta_code_version?: string;
  version?: string;
  supported_commands?: string[];
  supportedCommands?: string[];
  [key: string]: unknown;
}

export interface RegistrationResponse {
  connectionId: string;
  wsUrl: string;
  supportsSplitStatusChannels?: boolean;
  supportsPairedListenerGenerations?: boolean;
}

export interface ListenerReadyFrame {
  type: "listener_ready";
  connection_generation?: string;
  connection_attempt?: number;
}

export interface RoutingEnvelope {
  type?: string;
  requestId?: string;
  runtimeConversationId?: string;
  topLevelConversationId?: string;
  hasCreateConversation: boolean;
  eventSeq?: number;
}

export function selectUpstreamChannel(
  frameType: string | undefined,
  splitChannelsEnabled: boolean,
): UpstreamChannel {
  if (splitChannelsEnabled && frameType && STREAM_CHANNEL_MESSAGE_TYPES.has(frameType)) {
    return "stream";
  }
  return "control";
}

export function decodeWsData(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function getFrameType(frame: Record<string, unknown> | null): string | undefined {
  if (!frame) return undefined;
  return typeof frame.type === "string" ? frame.type : undefined;
}

export function extractRoutingEnvelope(frame: Record<string, unknown> | null): RoutingEnvelope {
  if (!frame) {
    return { hasCreateConversation: false };
  }

  const type = typeof frame.type === "string" ? frame.type : undefined;
  const requestId = typeof frame.request_id === "string" ? frame.request_id : undefined;
  const topLevelConversationId =
    typeof frame.conversation_id === "string" && frame.conversation_id.length > 0
      ? frame.conversation_id
      : undefined;

  let runtimeConversationId: string | undefined;
  const runtime = frame.runtime;
  if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
    const conv = (runtime as Record<string, unknown>).conversation_id;
    if (typeof conv === "string" && conv.length > 0) {
      runtimeConversationId = conv;
    }
  }

  const hasCreateConversation = Boolean(frame.create_conversation);
  const eventSeq = typeof frame.event_seq === "number" ? frame.event_seq : undefined;

  return {
    type,
    requestId,
    runtimeConversationId,
    topLevelConversationId,
    hasCreateConversation,
    eventSeq,
  };
}

export function rewriteEventSeq(
  raw: string,
  frame: Record<string, unknown> | null,
  nextSeq: () => number,
): { raw: string; rewrittenSeq?: number } {
  if (!frame || typeof frame.event_seq !== "number") {
    return { raw };
  }
  const seq = nextSeq();
  const rewritten = { ...frame, event_seq: seq };
  return { raw: JSON.stringify(rewritten), rewrittenSeq: seq };
}

export function isPongFrame(frame: Record<string, unknown> | null): boolean {
  return getFrameType(frame) === "pong";
}

export function isListenerReadyFrame(
  frame: Record<string, unknown> | null,
): frame is Record<string, unknown> & ListenerReadyFrame {
  return getFrameType(frame) === "listener_ready";
}

export function summarizeFrame(frame: Record<string, unknown> | null): string {
  if (!frame) return "<non-json>";
  const env = extractRoutingEnvelope(frame);
  const parts: string[] = [];
  if (env.type) parts.push(`type=${env.type}`);
  if (env.requestId) parts.push(`req=${env.requestId}`);
  const convId = env.runtimeConversationId ?? env.topLevelConversationId;
  if (convId) parts.push(`conv=${convId}`);
  if (env.eventSeq !== undefined) parts.push(`seq=${env.eventSeq}`);
  return parts.length > 0 ? parts.join(" ") : "<empty-frame>";
}
