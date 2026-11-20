# Letta WebSocket Multiplexer (`letta-sandbox`)

Expose a **single unified remote environment** to `chat.letta.com` while isolating every Letta conversation (`conversation_id`) inside its own ephemeral **Microsandbox (`msb`) microVM** running an unmodified `letta server`.

Works cross-platform on **macOS (Apple Silicon)** and **Linux (KVM)** using the official multi-arch `ghcr.io/letta-ai/letta-code:latest` OCI image—with **host-side secret injection** so your `LETTA_API_KEY` stays on the host and never enters the microVM.

## Architecture

```text
chat.letta.com / Letta Cloud Relay
        │  (single paired-generation split-channel WebSocket: control + stream)
        ▼
  letta-sandbox (Envelope Router + event_seq rewriter)
   ├── Control-plane (1 persistent letta server --listen)
   │     └─ computer-level commands, conv=default sync, stateless conversation CRUD, PTY
   └── Conversation-plane (MicrosandboxProvider — 1 ephemeral msb microVM per conversation_id)
         ├─ conv-A ─▶ microVM A (letta server --listen + capability-token auth)
         ├─ conv-B ─▶ microVM B (letta server --listen + capability-token auth)
         └─ idle reaper terminates & removes inactive microVMs automatically
```

## Documentation

- [POC Specification](docs/poc-spec.md) — architecture, goals, and milestones.
- [Milestone 1: Protocol Inspection Notes](docs/milestone-1-protocol-notes.md) — verified upstream `letta-ai/letta-code` transport, registration, split-channel, heartbeat, routing envelope, and `event_seq` findings.

## Status

- [x] **Milestone 1:** Protocol inspection of `letta-ai/letta-code` (`src/websocket/app-server.ts`, `src/websocket/listen-register.ts`, `src/websocket/listener/*`, `src/types/protocol_v2.ts`)
- [x] **Milestone 2:** Passthrough proxy (verified live with `chat.letta.com`)
- [x] **Milestone 3:** Envelope router (`conversation_id` routing, `request_id` correlation, `event_seq` rewriting — verified live with `chat.letta.com`)
- [x] **Milestone 4:** Lazy Microsandbox (`msb`) microVM spawning, host-side secret injection, and idle reaping per `conversation_id` (verified live with `chat.letta.com`)

## Development

```zsh
bun install
bun run typecheck
bun test
```

## Running in Microsandbox (`msb`) Mode

Uses hardware-isolated microVMs via the `msb` CLI (works on macOS Apple Silicon and Linux with KVM) with the official multi-arch `ghcr.io/letta-ai/letta-code:latest` image (no custom image build required). When `LETTA_SERVER_URL` is HTTPS (the default `https://api.letta.com`), the provider automatically uses `msb`'s host-side secret injection (`--secret LETTA_API_KEY:headers=[Authorization]@api.letta.com`) so the real `LETTA_API_KEY` stays on the host and never enters the microVM.

```zsh
# Optional: pre-pull the official Letta Code OCI image (AMD64 & ARM64)
msb pull ghcr.io/letta-ai/letta-code:latest

# Terminal 1: Control-plane
letta server --listen ws://127.0.0.1:4500

# Terminal 2: Multiplexer with Microsandbox microVMs
LETTA_API_KEY="sk-let-..." \
LETTA_CONNECTION_NAME="letta-sandbox" \
CONTROL_PLANE_URL="ws://127.0.0.1:4500/ws" \
SANDBOX_MODE="msb" \
SANDBOX_IDLE_TIMEOUT_MS="900000" \
DEBUG_FRAMES=1 \
bun run start
```

Inspect active microVMs at any time:

```zsh
msb ls --label letta-sandbox.managed=true
```

## Running in Static Worker Mode

For debugging or routing across pre-running local `letta server --listen` processes:

```zsh
# Control-plane
letta server --listen ws://127.0.0.1:4500

# Conversation worker(s) (optional; omit WORKER_URLS for single-server passthrough)
letta server --listen ws://127.0.0.1:4501
letta server --listen ws://127.0.0.1:4502

# Multiplexer
LETTA_API_KEY="sk-let-..." \
LETTA_CONNECTION_NAME="letta-sandbox" \
CONTROL_PLANE_URL="ws://127.0.0.1:4500/ws" \
WORKER_URLS="ws://127.0.0.1:4501/ws,ws://127.0.0.1:4502/ws" \
DEBUG_FRAMES=1 \
bun run start
```

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LETTA_API_KEY` | *(required)* | Letta Cloud API key for registration & relay auth |
| `LETTA_SERVER_URL` | `https://api.letta.com` | Letta Cloud API base URL |
| `LETTA_CONNECTION_NAME` | `letta-sandbox-<hostname>` | Display name shown in `chat.letta.com` |
| `LETTA_DEVICE_ID` | persisted in `~/.letta-sandbox/device-id` | Stable UUID for this remote environment |
| `CONTROL_PLANE_URL` / `DOWNSTREAM_URL` | `ws://127.0.0.1:4500/ws` | Control-plane `letta server --listen` WebSocket URL |
| `SANDBOX_MODE` | `static` | `static` (`WORKER_URLS`) or `microsandbox` / `msb` (`msb` microVMs) |
| `WORKER_URLS` | *(empty — falls back to control-plane)* | Comma-separated worker URLs when `SANDBOX_MODE=static` |
| `SANDBOX_IMAGE` | `ghcr.io/letta-ai/letta-code:latest` | OCI image for ephemeral conversation microVMs |
| `MSB_PATH` | `msb` | Path to the `msb` binary when `SANDBOX_MODE=microsandbox` / `msb` |
| `MSB_SECRET_INJECTION` | `true` | Use host-side `--secret` injection for `LETTA_API_KEY` on HTTPS Letta servers |
| `SANDBOX_IDLE_TIMEOUT_MS` | `900000` (15m) | Idle duration before a conversation microVM is reaped |
| `SANDBOX_MEMORY_LIMIT` / `SANDBOX_CPU_LIMIT` | `1G` / `1` | Per-microVM resource limits |
| `DOWNSTREAM_WS_TOKEN` / `DOWNSTREAM_WS_TOKEN_FILE` | *(optional)* | Capability token when using `--ws-auth capability-token` |
| `WORKER_WS_TOKEN` / `WORKER_WS_TOKEN_FILE` | *(falls back to `DOWNSTREAM_WS_TOKEN`)* | Capability token for static worker instances |
| `DEBUG_FRAMES` | `false` | Set `1` or `true` to log routed frame envelope summaries & `event_seq` rewrites |
