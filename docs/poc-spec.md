---
title: Letta WebSocket Multiplexer POC
status: draft
target: VPS (Linux + Docker + gVisor)
---

# Letta WebSocket Multiplexer POC

## Objective
Expose a **single unified remote environment** to `chat.letta.com` from a self-hosted VPS while isolating every Letta conversation (`conversation_id`) inside its own ephemeral sandbox container running an unmodified `letta server`.

## Why This Architecture
- **Cost:** Replaces per-hour Letta Cloud Sandboxes ($0.24/hr) with a flat-rate VPS.
- **UX:** Avoids flooding the `chat.letta.com` environment picker with one named runtime per container.
- **Maintenance:** Keeps upstream `@letta-ai/letta-code` unmodified. By routing strictly on the stable transport envelope and forwarding unknown command/event payloads opaquely, weekly additive changes to Letta's command vocabulary require zero multiplexer updates.

## Core Design

### 1. Control-Plane vs. Conversation-Plane Split
- **Upstream connection:** The multiplexer holds a single outbound WebSocket connection to Letta's hosted relay (presenting as one remote computer).
- **Control-plane target:** One lightweight, persistent, non-sandboxed `letta server` handles computer-level frames that lack a `runtime.conversation_id` (capability discovery, listing/creating agents, listing conversations, secrets).
- **Conversation-plane targets:** Frames scoped to `runtime.conversation_id` (starting at `runtime_start`) are routed to a dedicated gVisor container (`--runtime=runsc`) running `letta server` locally inside it.

### 2. Envelope-Level Routing & Sequence Rewriting
- **Opaque forwarding:** Do not validate or enumerate every command/event `type`. Inspect only routing fields: `runtime.conversation_id`, `request_id`, `event_seq`, and `idempotency_key`.
- **Sequence numbering:** Because `event_seq` is strictly monotonic per WebSocket connection, the multiplexer must rewrite outbound `event_seq` into a single monotonic stream before forwarding to the upstream relay.
- **Request correlation:** Track `request_id` → target (`control-plane` or `conversation_id`) so direct responses route back cleanly.

### 3. Sandbox Lifecycle
- **Lazy provisioning:** Spin up a container on the first `runtime_start` (or first conversation-scoped frame) for a given `conversation_id`.
- **State separation:** Keep agent memory (`MemFS` / state) decoupled from the ephemeral container filesystem.
- **Idle reaping:** Stop and remove containers after $N$ minutes of inactivity (configurable).

## POC Milestones
1. **Protocol inspection:** Inspect `letta-ai/letta-code`'s `src/websocket/listener/` and `protocol_v2.ts` to confirm exact handshake, relay auth, ACK, and `runtime_start` frame shapes.
2. **Passthrough proxy:** Build a minimal relay proxy that connects to Letta Cloud and forwards all frames to a single local `letta server` (verifying `chat.letta.com` connectivity).
3. **Envelope router:** Add `conversation_id` routing, `request_id` correlation, and outbound `event_seq` rewriting between the control-plane server and a second `letta server`.
4. **gVisor container spawning:** Wire lazy Docker + `runsc` container creation and idle teardown per `conversation_id`.
