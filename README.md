# Letta WebSocket Multiplexer POC (`letta-sandbox`)

Expose a **single unified remote environment** to `chat.letta.com` from a self-hosted VPS while isolating every Letta conversation (`conversation_id`) inside its own ephemeral gVisor sandbox container running an unmodified `letta server`.

## Documentation

- [POC Specification](docs/poc-spec.md) — architecture, goals, and milestones.
- [Milestone 1: Protocol Inspection Notes](docs/milestone-1-protocol-notes.md) — verified upstream `letta-ai/letta-code` transport, registration, split-channel, heartbeat, routing envelope, and `event_seq` findings.

## Status

- [x] **Milestone 1:** Protocol inspection of `letta-ai/letta-code` (`src/websocket/app-server.ts`, `src/websocket/listen-register.ts`, `src/websocket/listener/*`, `src/types/protocol_v2.ts`)
- [x] **Milestone 2:** Passthrough proxy (verified live with `chat.letta.com`)
- [ ] **Milestone 3:** Envelope router (`conversation_id` routing, `request_id` correlation, `event_seq` rewriting — implemented & verified against mock multi-server suite; ready for live multi-server test)
- [ ] **Milestone 4:** Lazy gVisor (`runsc`) container spawning and idle reaping per `conversation_id`

## Development

```zsh
bun install
bun run typecheck
bun test
```

## Running the Multiplexer (Milestone 2 / Milestone 3)

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

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LETTA_API_KEY` | *(required)* | Letta Cloud API key for registration & relay auth |
| `LETTA_SERVER_URL` | `https://api.letta.com` | Letta Cloud API base URL |
| `LETTA_CONNECTION_NAME` | `letta-sandbox-<hostname>` | Display name shown in `chat.letta.com` |
| `LETTA_DEVICE_ID` | persisted in `~/.letta-sandbox/device-id` | Stable UUID for this remote environment |
| `CONTROL_PLANE_URL` / `DOWNSTREAM_URL` | `ws://127.0.0.1:4500/ws` | Control-plane `letta server --listen` WebSocket URL |
| `WORKER_URLS` | *(empty — falls back to control-plane)* | Comma-separated conversation worker `letta server --listen` WebSocket URLs |
| `DOWNSTREAM_WS_TOKEN` / `DOWNSTREAM_WS_TOKEN_FILE` | *(optional)* | Capability token when using `--ws-auth capability-token` |
| `WORKER_WS_TOKEN` / `WORKER_WS_TOKEN_FILE` | *(falls back to `DOWNSTREAM_WS_TOKEN`)* | Capability token for worker instances |
| `DEBUG_FRAMES` | `false` | Set `1` or `true` to log routed frame envelope summaries & `event_seq` rewrites |

