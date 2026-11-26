import { DEFAULT_CONVERSATION_ID } from "./protocol.ts";

export const DEFAULT_TITLE_SUMMARIZATION_MODEL = "openai/gpt-6-luna";
export const CONVERSATION_TITLE_MAX_LENGTH = 100;
export const CONVERSATION_TITLE_MESSAGE_LIMIT = 10_000;
export const DEFAULT_TITLE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TITLE_ATTEMPTS = 2;
export const DEFAULT_MAX_TRACKED_CONVERSATIONS = 10_000;

export const CONVERSATION_TITLE_SYSTEM_PROMPT = `You are a conversation title generator.

Output ONLY a short, descriptive title for the conversation above.
Rules:
- 2 to 7 words
- describe the actual topic, not the mood
- no quotes, markdown, prefixes, or trailing punctuation
- never call any tools — reply with plain text only
- avoid generic titles like "New conversation" or "Help request"`;

const PERMANENT_HTTP_STATUSES = new Set([401, 403, 404, 405, 501]);

export interface ConversationTitleMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ConversationTitlerLogger {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface ConversationTitlerOptions {
  lettaServerUrl: string;
  lettaApiKey: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  maxTrackedConversations?: number;
  fetchImpl?: typeof fetch;
  logger?: ConversationTitlerLogger;
}

interface ConversationRecord {
  summary?: unknown;
  archived?: unknown;
  hidden?: unknown;
}

interface InFlightEntry {
  controller: AbortController;
  promise: Promise<void>;
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export function normalizeConversationTitle(value: string): string | null {
  let normalized = value.replace(/\s+/g, " ").trim();

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (!normalized || normalized.startsWith("/")) {
    return null;
  }

  return normalized.slice(0, CONVERSATION_TITLE_MAX_LENGTH);
}

function stripSystemReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") {
    return stripSystemReminders(content);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; text?: unknown };
      if (typeof record.text === "string") {
        parts.push(record.text);
      } else if (record.type === "image") {
        parts.push("[image]");
      }
    }
    return stripSystemReminders(parts.join("\n"));
  }
  return "";
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    let collected = "";
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        collected += (part as { text: string }).text;
      }
    }
    return collected;
  }
  return "";
}

export function extractPaginatedMessages(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as { items?: unknown; messages?: unknown };
    if (Array.isArray(record.items)) {
      return record.items;
    }
    if (Array.isArray(record.messages)) {
      return record.messages;
    }
  }
  return [];
}

export function buildConversationTitleMessages(messages: unknown[]): ConversationTitleMessage[] {
  const result: ConversationTitleMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { message_type?: unknown; content?: unknown };
    if (message.message_type === "user_message") {
      const content = extractUserText(message.content).trim();
      if (content) {
        result.push({ role: "user", content });
      }
    } else if (message.message_type === "assistant_message") {
      const content = extractAssistantText(message.content).trim();
      if (content) {
        result.push({ role: "assistant", content });
      }
    }
  }
  return result;
}

function hasNonEmptySummary(record: ConversationRecord | null): boolean {
  return typeof record?.summary === "string" && record.summary.trim().length > 0;
}

function shouldSkipConversation(record: ConversationRecord | null): boolean {
  if (!record) return false;
  return hasNonEmptySummary(record) || record.archived === true || record.hidden === true;
}

export class ConversationTitler {
  private readonly baseUrl: string;
  private readonly lettaApiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxTrackedConversations: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: ConversationTitlerLogger;

  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly settled = new Set<string>();
  private readonly failureCounts = new Map<string, number>();
  private stopped = false;

  constructor(options: ConversationTitlerOptions) {
    this.baseUrl = options.lettaServerUrl.replace(/\/+$/, "");
    this.lettaApiKey = options.lettaApiKey;
    this.model = options.model ?? DEFAULT_TITLE_SUMMARIZATION_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_TITLE_ATTEMPTS;
    this.maxTrackedConversations =
      options.maxTrackedConversations ?? DEFAULT_MAX_TRACKED_CONVERSATIONS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  markTitled(conversationId: string): void {
    if (!conversationId || conversationId === DEFAULT_CONVERSATION_ID) return;
    this.markSettled(conversationId);
    const active = this.inFlight.get(conversationId);
    if (active) {
      active.controller.abort();
    }
  }

  handleTurnFinished(conversationId: string, stopReason?: string): Promise<void> | null {
    if (this.stopped) return null;
    if (stopReason !== "end_turn") return null;
    if (!conversationId || conversationId === DEFAULT_CONVERSATION_ID) return null;
    if (this.settled.has(conversationId) || this.inFlight.has(conversationId)) return null;

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    if (
      typeof timeoutId === "object" &&
      "unref" in timeoutId &&
      typeof timeoutId.unref === "function"
    ) {
      timeoutId.unref();
    }

    const promise = this.runForConversation(conversationId, controller.signal, () => timedOut)
      .catch((err) => {
        this.logger?.debug(
          `Unexpected auto-title error for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (this.inFlight.get(conversationId)?.controller === controller) {
          this.inFlight.delete(conversationId);
        }
      });

    this.inFlight.set(conversationId, { controller, promise });
    return promise;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
    this.inFlight.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
  }

  private async runForConversation(
    conversationId: string,
    signal: AbortSignal,
    isTimedOut: () => boolean,
  ): Promise<void> {
    try {
      const initial = await this.fetchConversation(conversationId, signal);
      if (this.isCancelled(conversationId, signal)) return;
      if (!initial) {
        this.recordFailure(conversationId, "unexpected conversation response shape");
        return;
      }
      if (shouldSkipConversation(initial)) {
        this.markSettled(conversationId);
        return;
      }

      const messages = await this.fetchConversationMessages(conversationId, signal);
      if (this.isCancelled(conversationId, signal)) return;
      if (messages.length === 0) {
        return;
      }

      const title = await this.summarizeConversation(conversationId, messages, signal);
      if (this.isCancelled(conversationId, signal)) return;
      if (!title) {
        this.recordFailure(conversationId, "empty normalized summary");
        return;
      }

      // Re-check right before PATCH to avoid overwriting a manual rename or upstream auto-title
      const latest = await this.fetchConversation(conversationId, signal);
      if (this.isCancelled(conversationId, signal)) return;
      if (!latest) {
        this.recordFailure(conversationId, "unexpected conversation response shape before patch");
        return;
      }
      if (shouldSkipConversation(latest)) {
        this.markSettled(conversationId);
        return;
      }

      await this.updateConversationSummary(conversationId, title, signal);
      this.markSettled(conversationId);
      this.logger?.debug(`Auto-titled conversation ${conversationId}`);
    } catch (err) {
      if (this.stopped || this.settled.has(conversationId)) {
        return;
      }
      if (signal.aborted && !isTimedOut()) {
        return;
      }
      if (err instanceof HttpStatusError && PERMANENT_HTTP_STATUSES.has(err.status)) {
        this.markSettled(conversationId);
        this.logger?.debug(
          `Auto-title skipped permanently for ${conversationId} (HTTP ${err.status})`,
        );
        return;
      }
      this.recordFailure(conversationId, err instanceof Error ? err.message : String(err));
    }
  }

  private isCancelled(conversationId: string, signal: AbortSignal): boolean {
    return this.stopped || signal.aborted || this.settled.has(conversationId);
  }

  private recordFailure(conversationId: string, reason: string): void {
    const nextCount = (this.failureCounts.get(conversationId) ?? 0) + 1;
    if (nextCount >= this.maxAttempts) {
      this.markSettled(conversationId);
    } else {
      this.setBoundedMap(this.failureCounts, conversationId, nextCount);
    }
    this.logger?.debug(
      `Auto-title attempt ${nextCount}/${this.maxAttempts} failed for ${conversationId}: ${reason}`,
    );
  }

  private markSettled(conversationId: string): void {
    this.failureCounts.delete(conversationId);
    if (this.settled.size >= this.maxTrackedConversations && !this.settled.has(conversationId)) {
      const oldest = this.settled.values().next().value;
      if (oldest !== undefined) {
        this.settled.delete(oldest);
      }
    }
    this.settled.add(conversationId);
  }

  private setBoundedMap<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= this.maxTrackedConversations && !map.has(key)) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
    map.set(key, value);
  }

  private buildHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.lettaApiKey}`,
      "X-Letta-Source": "letta-code",
    };
    if (includeJsonContentType) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      throw new HttpStatusError(res.status, `${method} ${path} failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  private async fetchConversation(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ConversationRecord | null> {
    const data = await this.requestJson<unknown>(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      signal,
    );
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as ConversationRecord;
    }
    return null;
  }

  private async fetchConversationMessages(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ConversationTitleMessage[]> {
    const params = new URLSearchParams();
    params.set("limit", String(CONVERSATION_TITLE_MESSAGE_LIMIT));
    params.set("order", "desc");
    params.append("include_return_message_types", "user_message");
    params.append("include_return_message_types", "assistant_message");

    const data = await this.requestJson<unknown>(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`,
      signal,
    );
    const items = extractPaginatedMessages(data).slice().reverse();
    return buildConversationTitleMessages(items);
  }

  private async summarizeConversation(
    conversationId: string,
    messages: ConversationTitleMessage[],
    signal: AbortSignal,
  ): Promise<string | null> {
    const data = await this.requestJson<{ summary?: unknown }>(
      "POST",
      `/v1/conversations/${encodeURIComponent(conversationId)}/summarize`,
      signal,
      {
        prompt: CONVERSATION_TITLE_SYSTEM_PROMPT,
        messages,
        model: this.model,
      },
    );
    if (typeof data?.summary !== "string") {
      return null;
    }
    return normalizeConversationTitle(data.summary);
  }

  private async updateConversationSummary(
    conversationId: string,
    summary: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.requestJson<unknown>(
      "PATCH",
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      signal,
      { summary },
    );
  }
}
