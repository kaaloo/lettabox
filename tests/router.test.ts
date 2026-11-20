import { describe, expect, test } from "bun:test";
import {
  type ConversationTargetProvider,
  type DownstreamTarget,
  EnvelopeRouter,
} from "../src/router.ts";

function makeFakeTarget(id: string) {
  const sent: string[] = [];
  let closed = false;
  const target: DownstreamTarget = {
    id,
    send(raw: string) {
      sent.push(raw);
      return true;
    },
    close() {
      closed = true;
    },
  };
  return {
    target,
    sent,
    get closed() {
      return closed;
    },
    parsed() {
      return sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    },
  };
}

function makeFakeProvider(options: { delayMs?: number } = {}) {
  const workers = new Map<string, ReturnType<typeof makeFakeTarget>>();
  const convMap = new Map<string, ReturnType<typeof makeFakeTarget>>();
  const pendingMap = new Map<string, ReturnType<typeof makeFakeTarget>>();
  let counter = 0;

  const createWorker = () => {
    counter += 1;
    const w = makeFakeTarget(`worker-${counter}`);
    workers.set(w.target.id, w);
    return w;
  };

  const provider: ConversationTargetProvider = {
    async acquireForConversation(conversationId: string) {
      let existing = convMap.get(conversationId);
      if (!existing) {
        if (options.delayMs) await Bun.sleep(options.delayMs);
        existing = convMap.get(conversationId);
        if (!existing) {
          existing = createWorker();
          convMap.set(conversationId, existing);
        }
      }
      return existing.target;
    },
    async acquirePending(requestId: string) {
      let existing = pendingMap.get(requestId);
      if (!existing) {
        if (options.delayMs) await Bun.sleep(options.delayMs);
        existing = createWorker();
        pendingMap.set(requestId, existing);
      }
      return existing.target;
    },
    bindPendingToConversation(requestId: string, conversationId: string) {
      const w = pendingMap.get(requestId);
      if (!w) return undefined;
      pendingMap.delete(requestId);
      convMap.set(conversationId, w);
      return w.target;
    },
    releasePending(requestId: string) {
      pendingMap.delete(requestId);
    },
    getTarget(conversationId: string) {
      return convMap.get(conversationId)?.target;
    },
    closeAll() {
      for (const w of workers.values()) w.target.close();
      workers.clear();
      convMap.clear();
      pendingMap.clear();
    },
  };

  return { provider, workers, convMap, pendingMap };
}

describe("EnvelopeRouter", () => {
  test("routes computer-level, default conv, stateless CRUD, and PTY commands to control-plane", async () => {
    const control = makeFakeTarget("control-plane");
    const fake = makeFakeProvider();
    const upstreamSent: Array<{ raw: string; type?: string }> = [];

    const router = new EnvelopeRouter({
      controlPlane: control.target,
      conversationProvider: fake.provider,
      sendToUpstream: (raw, type) => {
        upstreamSent.push({ raw, type });
        return "control";
      },
    });

    const controlFrames = [
      { type: "list_models", request_id: "r1" },
      { type: "sync", runtime: { agent_id: null, conversation_id: "default" } },
      { type: "conversation_retrieve", request_id: "r2", conversation_id: "conv-1" },
      { type: "conversation_update", request_id: "r3", conversation_id: "conv-1" },
      { type: "conversation_recompile", request_id: "r4", conversation_id: "conv-1" },
      { type: "conversation_fork", request_id: "r5", conversation_id: "conv-1" },
      { type: "conversation_messages_list", request_id: "r6", conversation_id: "conv-1" },
      { type: "conversation_compact", request_id: "r7", conversation_id: "conv-1" },
      { type: "terminal_spawn", request_id: "r8", terminal_id: "t1" },
      { type: "terminal_input", terminal_id: "t1", data: "ls\n" },
      { type: "terminal_resize", terminal_id: "t1", cols: 80, rows: 24 },
      { type: "terminal_kill", terminal_id: "t1" },
    ];

    for (const f of controlFrames) {
      await router.handleUpstreamMessage(JSON.stringify(f));
    }

    expect(control.parsed()).toEqual(controlFrames);
    expect(fake.workers.size).toBe(0);
  });

  test("routes runtime_start with conversation_id and direct conversation-scoped frames to isolated workers", async () => {
    const control = makeFakeTarget("control-plane");
    const fake = makeFakeProvider();

    const router = new EnvelopeRouter({
      controlPlane: control.target,
      conversationProvider: fake.provider,
      sendToUpstream: () => "control",
    });

    await router.handleUpstreamMessage(
      JSON.stringify({ type: "runtime_start", request_id: "r1", conversation_id: "conv-a" }),
    );
    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "input",
        request_id: "r2",
        runtime: { agent_id: "ag-1", conversation_id: "conv-a" },
        text: "hello a",
      }),
    );
    // Conversation B starts directly with sync + input (no runtime_start)
    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "sync",
        runtime: { agent_id: "ag-1", conversation_id: "conv-b" },
      }),
    );
    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "input",
        request_id: "r3",
        runtime: { agent_id: "ag-1", conversation_id: "conv-b" },
        text: "hello b",
      }),
    );

    expect(control.sent).toHaveLength(0);
    expect(fake.workers.size).toBe(2);
    expect(fake.convMap.get("conv-a")!.parsed().map((f) => f.type)).toEqual([
      "runtime_start",
      "input",
    ]);
    expect(fake.convMap.get("conv-b")!.parsed().map((f) => f.type)).toEqual(["sync", "input"]);
  });

  test("binds create_conversation runtime_start pending worker on runtime_start_response", async () => {
    const control = makeFakeTarget("control-plane");
    const fake = makeFakeProvider();
    const upstreamSent: Record<string, unknown>[] = [];

    const router = new EnvelopeRouter({
      controlPlane: control.target,
      conversationProvider: fake.provider,
      sendToUpstream: (raw) => {
        upstreamSent.push(JSON.parse(raw) as Record<string, unknown>);
        return "control";
      },
    });

    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "runtime_start",
        request_id: "req-create-1",
        create_conversation: { agent_id: "ag-1" },
      }),
    );

    expect(fake.workers.size).toBe(1);
    const pendingWorker = fake.pendingMap.get("req-create-1")!;
    expect(pendingWorker).toBeDefined();

    // Downstream replies with runtime_start_response containing the new conversation_id
    router.handleDownstreamMessage(
      pendingWorker.target,
      JSON.stringify({
        type: "runtime_start_response",
        request_id: "req-create-1",
        runtime: { agent_id: "ag-1", conversation_id: "conv-new-99" },
      }),
    );

    expect(fake.pendingMap.size).toBe(0);
    expect(fake.provider.getTarget("conv-new-99")).toBe(pendingWorker.target);

    // Follow-up input for conv-new-99 must hit the exact same worker
    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "input",
        request_id: "req-msg-1",
        runtime: { agent_id: "ag-1", conversation_id: "conv-new-99" },
        text: "first prompt",
      }),
    );

    expect(fake.workers.size).toBe(1);
    expect(pendingWorker.parsed().map((f) => f.type)).toEqual(["runtime_start", "input"]);
    expect(upstreamSent).toHaveLength(1);
  });

  test("correlates worker-initiated control_request with upstream control_response by request_id", async () => {
    const control = makeFakeTarget("control-plane");
    const fake = makeFakeProvider();

    const router = new EnvelopeRouter({
      controlPlane: control.target,
      conversationProvider: fake.provider,
      sendToUpstream: () => "control",
    });

    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "input",
        request_id: "r1",
        runtime: { agent_id: "ag-1", conversation_id: "conv-perm" },
      }),
    );
    const worker = fake.convMap.get("conv-perm")!;

    // Worker sends control_request upstream (e.g. tool approval)
    router.handleDownstreamMessage(
      worker.target,
      JSON.stringify({
        type: "control_request",
        request_id: "perm-req-42",
        tool: "bash",
      }),
    );

    // Upstream sends control_response with ONLY request_id (no runtime.conversation_id)
    await router.handleUpstreamMessage(
      JSON.stringify({
        type: "control_response",
        request_id: "perm-req-42",
        approved: true,
      }),
    );

    expect(control.sent).toHaveLength(0);
    expect(worker.parsed().map((f) => f.type)).toEqual(["input", "control_request" /* not sent */, "control_response"].filter((t) => t !== "control_request"));
    expect(worker.parsed()[1]).toEqual({
      type: "control_response",
      request_id: "perm-req-42",
      approved: true,
    });
  });

  test("rewrites outbound event_seq monotonically across multiple downstream targets", () => {
    const control = makeFakeTarget("control-plane");
    const worker1 = makeFakeTarget("worker-1");
    const worker2 = makeFakeTarget("worker-2");
    const fake = makeFakeProvider();
    const upstreamSent: Record<string, unknown>[] = [];

    const router = new EnvelopeRouter({
      controlPlane: control.target,
      conversationProvider: fake.provider,
      sendToUpstream: (raw) => {
        upstreamSent.push(JSON.parse(raw) as Record<string, unknown>);
        return "stream";
      },
    });

    router.handleDownstreamMessage(
      control.target,
      JSON.stringify({
        type: "update_device_status",
        event_seq: 1,
        idempotency_key: "update_device_status:1:uuid-a",
      }),
    );
    router.handleDownstreamMessage(
      worker1.target,
      JSON.stringify({
        type: "stream_delta",
        event_seq: 1,
        idempotency_key: "stream_delta:1:uuid-b",
      }),
    );
    router.handleDownstreamMessage(
      worker2.target,
      JSON.stringify({
        type: "stream_delta",
        event_seq: 1,
        idempotency_key: "stream_delta:1:uuid-c",
      }),
    );
    router.handleDownstreamMessage(
      worker1.target,
      JSON.stringify({
        type: "input_accepted",
        request_id: "req-1",
      }),
    );
    router.handleDownstreamMessage(
      worker1.target,
      JSON.stringify({
        type: "turn_finished",
        event_seq: 2,
        idempotency_key: "turn_finished:2:uuid-d",
      }),
    );

    expect(upstreamSent.map((f) => f.event_seq)).toEqual([1, 2, 3, undefined, 4]);
    // idempotency_key is preserved untouched
    expect(upstreamSent[1]!.idempotency_key).toBe("stream_delta:1:uuid-b");

    router.resetEventSeq();
    router.handleDownstreamMessage(
      control.target,
      JSON.stringify({ type: "update_device_status", event_seq: 99 }),
    );
    expect(upstreamSent[5]!.event_seq).toBe(1);
  });

  test("preserves FIFO ordering for concurrent frames on a cold conversation", async () => {
    const control = makeFakeTarget("control-plane");
    const fake = makeFakeProvider({ delayMs: 25 });

    const router = new EnvelopeRouter({
      controlPlane: control.target,
      conversationProvider: fake.provider,
      sendToUpstream: () => "control",
    });

    const p1 = router.handleUpstreamMessage(
      JSON.stringify({ type: "sync", runtime: { agent_id: "a", conversation_id: "conv-cold" } }),
    );
    const p2 = router.handleUpstreamMessage(
      JSON.stringify({
        type: "change_device_state",
        runtime: { agent_id: "a", conversation_id: "conv-cold" },
      }),
    );
    const p3 = router.handleUpstreamMessage(
      JSON.stringify({
        type: "input",
        request_id: "r1",
        runtime: { agent_id: "a", conversation_id: "conv-cold" },
        text: "ordered",
      }),
    );

    await Promise.all([p1, p2, p3]);
    expect(fake.workers.size).toBe(1);
    expect(fake.convMap.get("conv-cold")!.parsed().map((f) => f.type)).toEqual([
      "sync",
      "change_device_state",
      "input",
    ]);
  });
});
