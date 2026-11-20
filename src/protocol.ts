export const STREAM_CHANNEL_MESSAGE_TYPES = new Set<string>([
  "stream_delta",
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
]);

export type UpstreamChannel = "control" | "stream";

export interface AppServerInfo {
  lettaCodeVersion?: string;
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
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
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
  const parts: string[] = [];
  if (typeof frame.type === "string") parts.push(`type=${frame.type}`);
  if (typeof frame.request_id === "string") parts.push(`req=${frame.request_id}`);
  const runtime = frame.runtime;
  if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
    const convId = (runtime as Record<string, unknown>).conversation_id;
    if (typeof convId === "string") parts.push(`conv=${convId}`);
  } else if (typeof frame.conversation_id === "string") {
    parts.push(`conv=${frame.conversation_id}`);
  }
  if (typeof frame.event_seq === "number") parts.push(`seq=${frame.event_seq}`);
  return parts.length > 0 ? parts.join(" ") : "<empty-frame>";
}
