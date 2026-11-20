# Letta WebSocket Multiplexer POC (`letta-sandbox`)

Expose a **single unified remote environment** to `chat.letta.com` from a self-hosted VPS while isolating every Letta conversation (`conversation_id`) inside its own ephemeral gVisor sandbox container running an unmodified `letta server`.

## Documentation

- [POC Specification](docs/poc-spec.md) — architecture, goals, and milestones.
- [Milestone 1: Protocol Inspection Notes](docs/milestone-1-protocol-notes.md) — verified upstream `letta-ai/letta-code` transport, registration, split-channel, heartbeat, routing envelope, and `event_seq` findings.

## Status

- [x] **Milestone 1:** Protocol inspection of `letta-ai/letta-code` (`src/websocket/app-server.ts`, `src/websocket/listen-register.ts`, `src/websocket/listener/*`, `src/types/protocol_v2.ts`)
- [ ] **Milestone 2:** Passthrough proxy (implemented & verified against mock relay; ready for live `chat.letta.com` smoke test)
- [ ] **Milestone 3:** Envelope router (`conversation_id` routing, `request_id` correlation, `event_seq` rewriting)
- [ ] **Milestone 4:** Lazy gVisor (`runsc`) container spawning and idle reaping per `conversation_id`

## Development

```zsh
bun install
bun run typecheck
bun test
```

## Running Milestone 2 (Passthrough Proxy)

Start an unmodified local `letta server` in app-server mode:

```zsh
letta server --listen ws://127.0.0.1:4500
```

Then start the passthrough proxy with your Letta API key:

```zsh
LETTA_API_KEY="sk-let-..." \
LETTA_CONNECTION_NAME="my-vps" \
DOWNSTREAM_URL="ws://127.0.0.1:4500/ws" \
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
| `DOWNSTREAM_URL` | `ws://127.0.0.1:4500/ws` | Local `letta server --listen` WebSocket URL |
| `DOWNSTREAM_WS_TOKEN` / `DOWNSTREAM_WS_TOKEN_FILE` | *(optional)* | Capability token when using `--ws-auth capability-token` |
| `DEBUG_FRAMES` | `false` | Set `1` or `true` to log routed frame envelope summaries |

