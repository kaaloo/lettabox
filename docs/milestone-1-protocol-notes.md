# Milestone 1: Upstream Protocol Inspection Notes

Source inspected: `letta-ai/letta-code` (`src/cli/subcommands/server.ts`, `src/websocket/app-server.ts`, `src/websocket/listen-register.ts`, `src/websocket/listener/*`, `src/types/protocol_v2.ts`, `src/types/runtime-start-protocol.ts`, `src/types/runtime-scope.ts`).

## 1. Downstream Transport: `letta server --listen` (App Server Mode)

Unmodified `@letta-ai/letta-code` already ships an inbound WebSocket server mode:

```zsh
letta server --listen ws://127.0.0.1:4500
```

For non-loopback / container bridge listeners, `--ws-auth` is required:

```zsh
letta server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token
```

Key properties from `src/websocket/app-server.ts`:

- Default WebSocket path is `/ws` (also accepts `/`).
- Accepted sockets are attached directly via `attachOpenListenerSocket(...)`—the exact same `ListenerRuntime` and Protocol V2 handler used by remote Cloud relay mode.
- Exposes HTTP endpoints:
  - `GET /healthz` and `GET /readyz` → `200 ok`
  - `GET /app-server-info` → JSON capability response (including `supported_commands`)
- Rejects legacy `?channel=` query params (`426 Upgrade Required`)—downstream app-server connections are **always single-socket**.
- Uses RFC 6455 protocol-level WebSocket `ping`/`pong` (30s interval, 90s timeout), NOT app-level JSON pings.

**Architectural implication:** The multiplexer does **not** need to mock Letta Cloud's HTTP registration server for downstream processes. It connects outbound to Letta Cloud Relay (upstream) and outbound to each `letta server --listen` instance (control-plane + gVisor containers).

---

## 2. Upstream Cloud Registration & Handshake

### Step A: HTTP Registration (`src/websocket/listen-register.ts`)

- **Endpoint:** `POST ${LETTA_SERVER_URL}/v1/environments/register` (default `https://api.letta.com`)
- **Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer <LETTA_API_KEY>`
  - `X-Letta-Source: letta-code`
- **Request Body:**

  ```json
  {
    "deviceId": "<stable-device-uuid>",
    "listenerInstanceId": "server-<sha256(connectionName).slice(0,16)>",
    "connectionName": "<environment-display-name>",
    "metadata": {
      "lettaCodeVersion": "<from control-plane /app-server-info>",
      "os": "linux",
      "nodeVersion": "...",
      "environmentMessageProtocol": "v2-input",
      "supportsPairedListenerGenerations": true,
      "supported_commands": ["...fetched from control-plane /app-server-info..."],
      "launch_subagent_notify_caller": true,
      "subagent_message": true,
      "external_fork_context": true
    }
  }
  ```
- **Response:**

  ```json
  {
    "connectionId": "...",
    "wsUrl": "wss://...",
    "supportsSplitStatusChannels": true,
    "supportsPairedListenerGenerations": true
  }
  ```

### Step B: WebSocket Upgrade & Split Channels (`src/websocket/listener/lifecycle.ts`, `split-stream-lifecycle.ts`)

- **Upgrade header:** `Authorization: Bearer <LETTA_API_KEY>`
- **Query params:**
  - `deviceId=<deviceId>`
  - `connectionName=<connectionName>`
  - If `supportsSplitStatusChannels === true`:
    - Control socket: `channel=control`
    - Stream socket: `channel=stream`
  - If `supportsPairedListenerGenerations === true` (and split channels enabled):
    - Both sockets also set `connectionGeneration=<uuid>` and `connectionAttempt=<monotonic-int>`
    - Open `control` socket first, wait for server frame:

      ```json
      {
        "type": "listener_ready",
        "connection_generation": "<uuid>",
        "connection_attempt": 1
      }
      ```
    - Then open `stream` socket with the same `connectionGeneration` & `connectionAttempt`.
    - If either socket closes, tear down the pair and reconnect cleanly.

### Outbound Channel Routing (`src/websocket/listener/protocol-outbound-routing.ts`)

When split channels are active, exactly **5 outbound message types** go on the `stream` socket:

- `stream_delta`
- `update_device_status`
- `update_loop_status`
- `update_queue`
- `update_subagent_state`

All other outbound frames (`input_accepted`, `*_response`, `control_request`, etc.) go on the `control` socket.

### Step C: Upstream Heartbeat & Re-Registration (`src/websocket/listener/heartbeat.ts`, `constants.ts`)

- Send app-level JSON `{"type":"ping"}` every **30s** on `control` (and `stream` if open).
- Relay replies with `{"type":"pong"}`—handle and swallow at the multiplexer layer (do not forward downstream).
- Cloud marks environments offline after ~120s of silence; terminate and reconnect after 3 missed pongs (**90s**).
- On WebSocket close code `1008` with reason `"Environment not found"`, re-run `POST /v1/environments/register` before reconnecting.
- On close code `1000` with reason `"Replaced by new connection"`, treat as terminal (do not reconnect in a tight loop).

---

## 3. Envelope Routing & Edge Cases (`src/types/protocol_v2.ts`, `runtime-start-protocol.ts`)

### Standard Conversation-Scoped Frames

Carry `runtime`:

```ts
interface RuntimeScope {
  agent_id: string | null;
  conversation_id: string;
  acting_user_id?: string;
}
```
Examples: `input`, `abort_message`, `sync`, `change_device_state`, `update_model`, `update_toolset`, `turn_finished_ack`.

### Edge Case 1: `runtime_start`

- Carries `conversation_id` at the **top level** (`frame.conversation_id`), NOT inside `frame.runtime`.
- May omit `conversation_id` and pass `create_conversation` instead! In that case, `conversation_id` is only known when `runtime_start_response` returns with `response.runtime.conversation_id`.
- **Routing rule:**
  - If `frame.conversation_id` is present → route to (or lazily spawn) that conversation's sandbox container.
  - If `frame.create_conversation` is present → allocate a fresh sandbox container, associate it with `frame.request_id`, forward `runtime_start`, and index the container under `response.runtime.conversation_id` when `runtime_start_response` arrives (ensuring `cwd`, git context, and initial `update_device_status` reflect the sandbox, not the control-plane).

### Edge Case 2: Stateless Conversation CRUD Commands

These carry a top-level `conversation_id` but are pure Letta Cloud API proxies:

- `conversation_retrieve`
- `conversation_update`
- `conversation_recompile`
- `conversation_fork`
- `conversation_messages_list`
- `conversation_compact`

Routing these to the **control-plane** avoids cold-starting sandbox containers just to browse history in `chat.letta.com`.

### Edge Case 3: Interactive PTY Terminals

`terminal_spawn`, `terminal_input`, `terminal_resize`, `terminal_kill` carry `terminal_id` (no `conversation_id`). For the POC, route these to the control-plane (or track `terminal_id -> target` if scoped later).

---

## 4. ACKs & `event_seq` Rewriting

- **Input ACK (`src/websocket/listener/input-ack.ts`):**
  Inbound `input` frames are acknowledged by downstream with:

  ```json
  {
    "type": "input_accepted",
    "request_id": "...",
    "runtime": { "agent_id": "...", "conversation_id": "..." },
    "accepted": true,
    "disposition": "started"
  }
  ```

  Forward opaquely on the upstream `control` socket.
- **Sequence numbering (`RuntimeEnvelope`):**
  Every protocol event emitted by a downstream server includes:

  ```ts
  {
    runtime: ConversationRuntimeScope;
    event_seq: number;
    emitted_at: string;
    idempotency_key: string; // `${type}:${eventSeq}:${uuid}`
  }
  ```

  The multiplexer maintains one strictly monotonic counter (`1, 2, 3, ...`) per upstream connection and rewrites `frame.event_seq` on any outbound JSON frame where `typeof frame.event_seq === "number"`. `idempotency_key` already embeds a UUID and does not require rewriting.
