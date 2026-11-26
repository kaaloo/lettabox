import { describe, expect, test } from "bun:test";
import {
  buildConversationTitleMessages,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_MESSAGE_LIMIT,
  CONVERSATION_TITLE_SYSTEM_PROMPT,
  ConversationTitler,
  DEFAULT_TITLE_SUMMARIZATION_MODEL,
  extractPaginatedMessages,
  normalizeConversationTitle,
} from "../src/conversation-titler.ts";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | null;
}

function makeRecorderFetch(handler: (req: RecordedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) {
        headers[k.toLowerCase()] = v;
      }
    }
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const body = rawBody ? (JSON.parse(rawBody) as unknown) : undefined;
    const recorded: RecordedRequest = {
      method,
      url,
      headers,
      body,
      signal: init?.signal,
    };
    requests.push(recorded);
    return handler(recorded);
  }) as typeof fetch;

  return { fetchImpl, requests };
}

describe("normalizeConversationTitle", () => {
  test("collapses whitespace, trims matching outer quotes, and caps length", () => {
    expect(normalizeConversationTitle('  "Lettabox   Automatic\nNaming Test"  ')).toBe(
      "Lettabox Automatic Naming Test",
    );
    expect(normalizeConversationTitle("  'Single Quoted Title'  ")).toBe("Single Quoted Title");
    expect(normalizeConversationTitle('  "Unmatched Quote  ')).toBe('"Unmatched Quote');
    expect(normalizeConversationTitle("   \n\t  ")).toBeNull();
    expect(normalizeConversationTitle('""')).toBeNull();
    expect(normalizeConversationTitle("/rename convo")).toBeNull();
    const longTitle = "a".repeat(CONVERSATION_TITLE_MAX_LENGTH + 25);
    expect(normalizeConversationTitle(longTitle)).toHaveLength(CONVERSATION_TITLE_MAX_LENGTH);
  });
});

describe("buildConversationTitleMessages & extractPaginatedMessages", () => {
  test("extracts user and assistant text, strips system reminders, and ignores tool/reasoning messages", () => {
    const messages = [
      { message_type: "system_message", content: "You are an agent" },
      {
        message_type: "user_message",
        content: "<system-reminder>hidden context</system-reminder>\n   ",
      },
      {
        message_type: "user_message",
        content:
          "<system-reminder>system note</system-reminder>\nDebug lettabox conversation naming",
      },
      { message_type: "reasoning_message", content: "Thinking..." },
      { message_type: "tool_call_message", tool_call: { name: "Bash" } },
      { message_type: "tool_return_message", tool_return: "ok" },
      {
        message_type: "assistant_message",
        content: [
          { type: "text", text: "Headless letta server " },
          { type: "text", text: "never triggers titling." },
        ],
      },
      {
        message_type: "user_message",
        content: [
          { type: "text", text: "<system-reminder>skip</system-reminder>Here is a screenshot" },
          { type: "image" },
        ],
      },
    ];

    expect(buildConversationTitleMessages(messages)).toEqual([
      { role: "user", content: "Debug lettabox conversation naming" },
      { role: "assistant", content: "Headless letta server never triggers titling." },
      { role: "user", content: "Here is a screenshot\n[image]" },
    ]);
  });

  test("extractPaginatedMessages supports raw arrays and wrapped items/messages", () => {
    expect(extractPaginatedMessages([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(extractPaginatedMessages({ items: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(extractPaginatedMessages({ messages: [{ id: 3 }] })).toEqual([{ id: 3 }]);
    expect(extractPaginatedMessages(null)).toEqual([]);
  });
});

describe("ConversationTitler", () => {
  test("generates and persists a title after end_turn and settles to avoid duplicate runs", async () => {
    const debugLogs: string[] = [];
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/conversations/conv-123") {
        return Response.json({ id: "conv-123", summary: null, archived: false });
      }
      if (req.method === "GET" && url.pathname === "/v1/conversations/conv-123/messages") {
        // Returned in desc order (newest first), matching order=desc
        return Response.json([
          { message_type: "assistant_message", content: "It looks like headless server skips it." },
          {
            message_type: "user_message",
            content: "<system-reminder>ctx</system-reminder>Test automatic conversation naming",
          },
        ]);
      }
      if (req.method === "POST" && url.pathname === "/v1/conversations/conv-123/summarize") {
        return Response.json({ summary: '  "Lettabox Automatic Naming Test"  ' });
      }
      if (req.method === "PATCH" && url.pathname === "/v1/conversations/conv-123") {
        return Response.json({ id: "conv-123", summary: "Lettabox Automatic Naming Test" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com/",
      lettaApiKey: "secret-key",
      fetchImpl,
      logger: { debug: (m) => debugLogs.push(m), warn: () => {} },
    });

    await titler.handleTurnFinished("conv-123", "end_turn");

    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /v1/conversations/conv-123",
      "GET /v1/conversations/conv-123/messages",
      "POST /v1/conversations/conv-123/summarize",
      "GET /v1/conversations/conv-123",
      "PATCH /v1/conversations/conv-123",
    ]);

    // Verify headers
    for (const req of requests) {
      expect(req.headers.authorization).toBe("Bearer secret-key");
      expect(req.headers["x-letta-source"]).toBe("letta-code");
    }

    // Verify message list query params (repeated arrayFormat matching letta-node)
    const messagesUrl = new URL(requests[1]?.url ?? "");
    expect(messagesUrl.searchParams.get("limit")).toBe(String(CONVERSATION_TITLE_MESSAGE_LIMIT));
    expect(messagesUrl.searchParams.get("order")).toBe("desc");
    expect(messagesUrl.searchParams.getAll("include_return_message_types")).toEqual([
      "user_message",
      "assistant_message",
    ]);

    // Verify summarize request payload has chronological messages & default Luna model
    expect(requests[2]?.body).toEqual({
      prompt: CONVERSATION_TITLE_SYSTEM_PROMPT,
      model: DEFAULT_TITLE_SUMMARIZATION_MODEL,
      messages: [
        { role: "user", content: "Test automatic conversation naming" },
        { role: "assistant", content: "It looks like headless server skips it." },
      ],
    });

    // Verify PATCH payload has normalized summary
    expect(requests[4]?.body).toEqual({
      summary: "Lettabox Automatic Naming Test",
    });

    // Privacy: debug log should mention conversation ID without leaking title text
    expect(debugLogs.some((line) => line.includes("conv-123"))).toBe(true);
    expect(debugLogs.some((line) => line.includes("Lettabox Automatic Naming Test"))).toBe(false);

    // Subsequent end_turn on the same conversation is a zero-fetch no-op
    expect(titler.handleTurnFinished("conv-123", "end_turn")).toBeNull();
    expect(requests).toHaveLength(5);
  });

  test("ignores non-end_turn stop reasons and default conversation", async () => {
    const { fetchImpl, requests } = makeRecorderFetch(() => Response.json({}));
    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      fetchImpl,
    });

    expect(titler.handleTurnFinished("default", "end_turn")).toBeNull();
    expect(titler.handleTurnFinished("", "end_turn")).toBeNull();
    expect(titler.handleTurnFinished("conv-1", "cancelled")).toBeNull();
    expect(titler.handleTurnFinished("conv-1", "error")).toBeNull();
    expect(titler.handleTurnFinished("conv-1", "max_turns")).toBeNull();
    expect(titler.handleTurnFinished("conv-1", "requires_approval")).toBeNull();
    expect(titler.handleTurnFinished("conv-1", undefined)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test("skips and settles conversations that already have summary, are archived, or are hidden", async () => {
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/conv-titled")) {
        return Response.json({ id: "conv-titled", summary: "Existing Title" });
      }
      if (pathname.endsWith("/conv-archived")) {
        return Response.json({ id: "conv-archived", summary: null, archived: true });
      }
      if (pathname.endsWith("/conv-hidden")) {
        return Response.json({ id: "conv-hidden", summary: null, hidden: true });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      fetchImpl,
    });

    await titler.handleTurnFinished("conv-titled", "end_turn");
    await titler.handleTurnFinished("conv-archived", "end_turn");
    await titler.handleTurnFinished("conv-hidden", "end_turn");

    // Only the initial GET was made for each; no /messages, /summarize, or PATCH
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /v1/conversations/conv-titled",
      "GET /v1/conversations/conv-archived",
      "GET /v1/conversations/conv-hidden",
    ]);

    // All three are now settled so future turns skip immediately
    expect(titler.handleTurnFinished("conv-titled", "end_turn")).toBeNull();
    expect(titler.handleTurnFinished("conv-archived", "end_turn")).toBeNull();
    expect(titler.handleTurnFinished("conv-hidden", "end_turn")).toBeNull();
    expect(requests).toHaveLength(3);
  });

  test("TOCTOU guard skips PATCH when summary is set externally while summarize is in flight", async () => {
    let getCount = 0;
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      const pathname = new URL(req.url).pathname;
      if (req.method === "GET" && pathname === "/v1/conversations/conv-race") {
        getCount += 1;
        return Response.json({
          id: "conv-race",
          summary: getCount === 1 ? null : "Manually Renamed Title",
        });
      }
      if (req.method === "GET" && pathname === "/v1/conversations/conv-race/messages") {
        return Response.json([{ message_type: "user_message", content: "Hello" }]);
      }
      if (req.method === "POST" && pathname === "/v1/conversations/conv-race/summarize") {
        return Response.json({ summary: "AI Generated Title" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      fetchImpl,
    });

    await titler.handleTurnFinished("conv-race", "end_turn");

    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /v1/conversations/conv-race",
      "GET /v1/conversations/conv-race/messages",
      "POST /v1/conversations/conv-race/summarize",
      "GET /v1/conversations/conv-race",
    ]);
    expect(titler.handleTurnFinished("conv-race", "end_turn")).toBeNull();
  });

  test("markTitled aborts an in-flight summarize request and prevents PATCH", async () => {
    let summarizeSignal: AbortSignal | null | undefined;
    let resolveSummarizeStarted!: () => void;
    const summarizeStarted = new Promise<void>((resolve) => {
      resolveSummarizeStarted = resolve;
    });

    const { fetchImpl, requests } = makeRecorderFetch(async (req) => {
      const pathname = new URL(req.url).pathname;
      if (req.method === "GET" && pathname === "/v1/conversations/conv-abort") {
        return Response.json({ id: "conv-abort", summary: null });
      }
      if (req.method === "GET" && pathname === "/v1/conversations/conv-abort/messages") {
        return Response.json([{ message_type: "user_message", content: "Hello" }]);
      }
      if (req.method === "POST" && pathname === "/v1/conversations/conv-abort/summarize") {
        summarizeSignal = req.signal;
        resolveSummarizeStarted();
        return await new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      fetchImpl,
    });

    const pending = titler.handleTurnFinished("conv-abort", "end_turn");
    await summarizeStarted;
    titler.markTitled("conv-abort");
    await pending;

    expect(summarizeSignal?.aborted).toBe(true);
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(titler.handleTurnFinished("conv-abort", "end_turn")).toBeNull();
  });

  test("deduplicates concurrent handleTurnFinished calls for the same conversation", async () => {
    let releaseGet!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const { fetchImpl, requests } = makeRecorderFetch(async (req) => {
      const pathname = new URL(req.url).pathname;
      if (req.method === "GET" && pathname === "/v1/conversations/conv-dup") {
        await gate;
        return Response.json({ id: "conv-dup", summary: "Already Set" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      fetchImpl,
    });

    const first = titler.handleTurnFinished("conv-dup", "end_turn");
    const second = titler.handleTurnFinished("conv-dup", "end_turn");
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    releaseGet();
    await first;
    expect(requests).toHaveLength(1);
  });

  test("retries transient summarize failure on next turn without writing fallback, then caps at maxAttempts", async () => {
    let summarizeCalls = 0;
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      const pathname = new URL(req.url).pathname;
      if (req.method === "GET" && pathname === "/v1/conversations/conv-retry") {
        return Response.json({ id: "conv-retry", summary: null });
      }
      if (req.method === "GET" && pathname === "/v1/conversations/conv-retry/messages") {
        return Response.json([{ message_type: "user_message", content: "Retry me" }]);
      }
      if (req.method === "POST" && pathname === "/v1/conversations/conv-retry/summarize") {
        summarizeCalls += 1;
        if (summarizeCalls === 1) {
          return new Response("upstream error", { status: 502 });
        }
        return Response.json({ summary: "Recovered Title" });
      }
      if (req.method === "PATCH" && pathname === "/v1/conversations/conv-retry") {
        return Response.json({ id: "conv-retry", summary: "Recovered Title" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      maxAttempts: 2,
      fetchImpl,
    });

    // Turn 1 fails transiently -> no PATCH written
    await titler.handleTurnFinished("conv-retry", "end_turn");
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);

    // Turn 2 succeeds and persists AI title
    await titler.handleTurnFinished("conv-retry", "end_turn");
    const patches = requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ summary: "Recovered Title" });
  });

  test("caps repeated transient failures at maxAttempts and settles permanent 404/403 immediately", async () => {
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.includes("conv-404")) {
        return new Response("not found", { status: 404 });
      }
      if (pathname.includes("conv-500")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      maxAttempts: 2,
      fetchImpl,
    });

    // 404 settles on first attempt
    await titler.handleTurnFinished("conv-404", "end_turn");
    expect(titler.handleTurnFinished("conv-404", "end_turn")).toBeNull();
    expect(requests.filter((r) => r.url.includes("conv-404"))).toHaveLength(1);

    // 500 retries once (maxAttempts=2), then settles
    await titler.handleTurnFinished("conv-500", "end_turn");
    await titler.handleTurnFinished("conv-500", "end_turn");
    expect(titler.handleTurnFinished("conv-500", "end_turn")).toBeNull();
    expect(requests.filter((r) => r.url.includes("conv-500"))).toHaveLength(2);
  });

  test("timeout counts as transient failure and stop() aborts in-flight requests cleanly", async () => {
    const abortedSignals: boolean[] = [];
    const { fetchImpl } = makeRecorderFetch(async (req) => {
      return await new Promise<Response>((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => {
          abortedSignals.push(true);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    // Timeout case
    const timeoutTitler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      timeoutMs: 25,
      maxAttempts: 1,
      fetchImpl,
    });
    await timeoutTitler.handleTurnFinished("conv-slow", "end_turn");
    expect(abortedSignals).toHaveLength(1);
    expect(timeoutTitler.handleTurnFinished("conv-slow", "end_turn")).toBeNull();

    // stop() case
    const stopTitler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      timeoutMs: 60_000,
      fetchImpl,
    });
    const pending = stopTitler.handleTurnFinished("conv-stop", "end_turn");
    stopTitler.stop();
    await pending;
    expect(abortedSignals).toHaveLength(2);
    expect(stopTitler.handleTurnFinished("conv-after-stop", "end_turn")).toBeNull();
  });

  test("encodes conversationId in URLs and evicts oldest settled entries when bounded", async () => {
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/conv%2Fspecial")) {
        return Response.json({ id: "conv/special", summary: "Already Named" });
      }
      return Response.json({ summary: "Named" });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      maxTrackedConversations: 2,
      fetchImpl,
    });

    await titler.handleTurnFinished("conv/special", "end_turn");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/conversations/conv%2Fspecial");

    await titler.handleTurnFinished("conv-2", "end_turn");
    await titler.handleTurnFinished("conv-3", "end_turn");
    // conv/special was evicted once maxTrackedConversations=2 was exceeded
    const reTriggered = titler.handleTurnFinished("conv/special", "end_turn");
    expect(reTriggered).not.toBeNull();
    await reTriggered;
  });

  test("fails closed without PATCH when GET conversation returns a non-object payload", async () => {
    const { fetchImpl, requests } = makeRecorderFetch((req) => {
      if (req.method === "GET" && new URL(req.url).pathname === "/v1/conversations/conv-weird") {
        return Response.json(["not-an-object"]);
      }
      return new Response("unexpected", { status: 500 });
    });

    const titler = new ConversationTitler({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "k",
      maxAttempts: 1,
      fetchImpl,
    });

    await titler.handleTurnFinished("conv-weird", "end_turn");
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /v1/conversations/conv-weird",
    ]);
    expect(titler.handleTurnFinished("conv-weird", "end_turn")).toBeNull();
  });
});
