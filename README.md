# Letta WebSocket Multiplexer POC (`letta-sandbox`)

Expose a **single unified remote environment** to `chat.letta.com` from a self-hosted VPS while isolating every Letta conversation (`conversation_id`) inside its own ephemeral gVisor sandbox container running an unmodified `letta server`.

## Documentation

- [POC Specification](docs/poc-spec.md) — architecture, goals, and milestones.
- [Milestone 1: Protocol Inspection Notes](docs/milestone-1-protocol-notes.md) — verified upstream `letta-ai/letta-code` transport, registration, split-channel, heartbeat, routing envelope, and `event_seq` findings.

## Status

- [x] **Milestone 1:** Protocol inspection of `letta-ai/letta-code` (`src/websocket/app-server.ts`, `src/websocket/listen-register.ts`, `src/websocket/listener/*`, `src/types/protocol_v2.ts`)
- [ ] **Milestone 2:** Passthrough proxy (Letta Cloud relay ↔ single local `letta server --listen`)
- [ ] **Milestone 3:** Envelope router (`conversation_id` routing, `request_id` correlation, `event_seq` rewriting)
- [ ] **Milestone 4:** Lazy gVisor (`runsc`) container spawning and idle reaping per `conversation_id`

## Development

```zsh
bun install
bun run typecheck
bun run dev
```
