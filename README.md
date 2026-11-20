# Letta WebSocket Multiplexer POC (`letta-sandbox`)

Expose a **single unified remote environment** to `chat.letta.com` from a self-hosted VPS while isolating every Letta conversation (`conversation_id`) inside its own ephemeral gVisor sandbox container running an unmodified `letta server`.

## Documentation

- [POC Specification](docs/poc-spec.md) — architecture, goals, and milestones.
- [Milestone 1: Protocol Inspection Notes](docs/milestone-1-protocol-notes.md) — verified upstream `letta-ai/letta-code` transport, registration, split-channel, heartbeat, routing envelope, and `event_seq` findings.

## Status

- [x] **Milestone 1:** Protocol inspection of `letta-ai/letta-code` (`src/websocket/app-server.ts`, `src/websocket/listen-register.ts`, `src/websocket/listener/*`, `src/types/protocol_v2.ts`)
- [x] **Milestone 2:** Passthrough proxy (verified live with `chat.letta.com`)
- [x] **Milestone 3:** Envelope router (`conversation_id` routing, `request_id` correlation, `event_seq` rewriting — verified live with `chat.letta.com`)
- [ ] **Milestone 4:** Lazy gVisor (`runsc`) container spawning and idle reaping per `conversation_id` (implemented & verified against mock Docker suite; ready for live Docker/gVisor test)

## Development

```zsh
bun install
bun run typecheck
bun test
```

## Running in Static Worker Mode (Milestone 2 / Milestone 3)

Start the control-plane `letta server` and one or more conversation worker `letta server` instances:

```zsh
# Control-plane (computer-level commands, default sync, stateless conversation CRUD)
letta server --listen ws://127.0.0.1:4500

# Conversation worker(s) (optional; omit WORKER_URLS to run in single-server Milestone 2 mode)
letta server --listen ws://127.0.0.1:4501
letta server --listen ws://127.0.0.1:4502
```

Then start the multiplexer:

```zsh
LETTA_API_KEY="sk-let-..." \
LETTA_CONNECTION_NAME="letta-sandbox" \
CONTROL_PLANE_URL="ws://127.0.0.1:4500/ws" \
WORKER_URLS="ws://127.0.0.1:4501/ws,ws://127.0.0.1:4502/ws" \
DEBUG_FRAMES=1 \
bun run start
```

## Running in Docker + gVisor Mode (Milestone 4)

Build the sandbox worker image (unmodified `@letta-ai/letta-code` with `--ws-auth capability-token`):

```zsh
docker build -f docker/Dockerfile.sandbox -t letta-sandbox-worker:latest .
```

Start the lightweight control-plane `letta server`:

```zsh
letta server --listen ws://127.0.0.1:4500
```

Start the multiplexer in `docker` mode (on a Linux VPS with gVisor `runsc` installed; pass `SANDBOX_RUNTIME=""` to test with default Docker `runc` on macOS/Docker Desktop):

```zsh
LETTA_API_KEY="sk-let-..." \
LETTA_CONNECTION_NAME="letta-sandbox" \
CONTROL_PLANE_URL="ws://127.0.0.1:4500/ws" \
SANDBOX_MODE="docker" \
SANDBOX_IMAGE="letta-sandbox-worker:latest" \
SANDBOX_RUNTIME="runsc" \
SANDBOX_IDLE_TIMEOUT_MS="900000" \
DEBUG_FRAMES=1 \
bun run start
```

## Running in Microsandbox (`msb`) Mode

Uses hardware-isolated microVMs via the `msb` CLI (works on macOS Apple Silicon and Linux with KVM). When `LETTA_SERVER_URL` is HTTPS (the default `https://api.letta.com`), the provider automatically uses `msb`'s host-side secret injection (`--secret LETTA_API_KEY:headers=[Authorization]@api.letta.com`) so the real `LETTA_API_KEY` stays on the host and never enters the microVM.

```zsh
# Control-plane
letta server --listen ws://127.0.0.1:4500

# Multiplexer with Microsandbox microVMs
LETTA_API_KEY="sk-let-..." \
LETTA_CONNECTION_NAME="letta-sandbox" \
CONTROL_PLANE_URL="ws://127.0.0.1:4500/ws" \
SANDBOX_MODE="msb" \
SANDBOX_IMAGE="<your-oci-image-with-letta-code>" \
SANDBOX_IDLE_TIMEOUT_MS="900000" \
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
| `SANDBOX_MODE` | `static` | `static` (`WORKER_URLS`), `docker` (gVisor/Docker), or `microsandbox` / `msb` (`msb` microVMs) |
| `WORKER_URLS` | *(empty — falls back to control-plane)* | Comma-separated worker URLs when `SANDBOX_MODE=static` |
| `SANDBOX_IMAGE` | `letta-sandbox-worker:latest` | OCI image for ephemeral conversation sandboxes |
| `SANDBOX_RUNTIME` | `runsc` | Docker OCI runtime (`runsc` for gVisor; set `""` for default Docker runtime) |
| `MSB_PATH` | `msb` | Path to the `msb` binary when `SANDBOX_MODE=microsandbox` / `msb` |
| `MSB_SECRET_INJECTION` | `true` | Use host-side `--secret` injection for `LETTA_API_KEY` on HTTPS Letta servers |
| `SANDBOX_IDLE_TIMEOUT_MS` | `900000` (15m) | Idle duration before a conversation sandbox is reaped |
| `SANDBOX_MEMORY_LIMIT` / `SANDBOX_CPU_LIMIT` / `SANDBOX_PIDS_LIMIT` | `1g` / `1` / `256` | Per-sandbox resource limits |
| `DOWNSTREAM_WS_TOKEN` / `DOWNSTREAM_WS_TOKEN_FILE` | *(optional)* | Capability token when using `--ws-auth capability-token` |
| `WORKER_WS_TOKEN` / `WORKER_WS_TOKEN_FILE` | *(falls back to `DOWNSTREAM_WS_TOKEN`)* | Capability token for static worker instances |
| `DEBUG_FRAMES` | `false` | Set `1` or `true` to log routed frame envelope summaries & `event_seq` rewrites |

