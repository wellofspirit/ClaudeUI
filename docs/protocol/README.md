# cli.js Protocol Manual

Reference documentation for the complete wire protocol between ClaudeUI's SDK harness (`src/main/sdk/`) and `vendor/claude-cli/cli.js`. This is a maintenance manual — it's meant to be kept complete, current, and specific so a future session with zero context can:

- Understand how a message crosses the wire
- Look up the full shape of any message cli.js can send
- Look up the full shape of any message we can send cli.js
- Look up what any CLI flag does without guessing
- Build a new integration (new control request, new stream event consumer) without re-reverse-engineering cli.js

## Verified against

```
cli.js version: 2.1.114
upstream SDK:   @anthropic-ai/claude-code 2.1.114 (Bun standalone binary)
```

The doc should be re-verified each time `package.json#claudeCliVersion` bumps. See `12-maintenance.md` for the drift check workflow.

---

## Table of contents

| # | Doc | What |
|---|---|---|
| 01 | [Transport](01-transport.md) | Spawn, stdio, ndjson, env, startup/teardown, signals, wire log |
| 02 | [CLI flags](02-cli-flags.md) | Every `--flag` cli.js accepts — effect, default, interactions |
| 03 | [Inbound messages](03-inbound-messages.md) | Every stream-json `type` cli.js emits to us |
| 04 | [System subtypes](04-system-subtypes.md) | Every `system/<subtype>` variant and its fields |
| 05 | [Stream events](05-stream-events.md) | `stream_event` deltas — every event.type and delta.type |
| 06 | [Outbound messages](06-outbound-messages.md) | Every stream-json `type` cli.js accepts from us on stdin |
| 07 | [Control outbound](07-control-outbound.md) | Every control_request subtype we send cli.js |
| 08 | [Control inbound](08-control-inbound.md) | Every control_request subtype cli.js sends us |
| 09 | [Initialize](09-initialize.md) | Deep dive on the initialize request/response |
| 10 | [MCP hosting](10-mcp-hosting.md) | `mcp_message` wire protocol + server lifecycle |
| 11 | [Cancellation](11-cancellation.md) | Three-tier cancellation + timeouts |
| 12 | [Maintenance](12-maintenance.md) | How to keep the manual and harness in sync |
| 13 | [Context window](13-context-window.md) | How cli.js resolves model context windows + ClaudeUI's mirror |

---

## Architecture at a glance

```
┌─────────────────────────────────────────┐
│  ClaudeUI (Electron main)               │
│    src/main/sdk/query.ts                │
│    - spawns cli.js                      │
│    - speaks stream-json over stdio      │
│    - hosts SDK MCP servers in-process   │
│    - routes control_requests            │
└──────────────┬──────────────────────────┘
               │ stdin:  NdjsonWriter
               │ stdout: NdjsonReader
               │ stderr: pass-through
               ▼
┌─────────────────────────────────────────┐
│  cli.js                                 │
│    --output-format stream-json          │
│    --input-format stream-json           │
│    --verbose                            │
└─────────────────────────────────────────┘
```

Every line in either direction is exactly `{JSON}\n`. No framing, no length prefix. One object per line.

---

## Message families

Four kinds of things cross the wire:

1. **Stream messages** — `{type: 'assistant'|'user'|'system'|'result'|...}` — the observable state of the agent.
2. **Control requests** — `{type: 'control_request', request_id, request: {subtype, ...}}` — synchronous RPCs. Both sides can initiate.
3. **Control responses** — `{type: 'control_response', response: {subtype: 'success'|'error', request_id, response|error}}` — match by `request_id`.
4. **Control cancels** — `{type: 'control_cancel_request', request_id}` — one-way cancel signal for an in-flight control_request.

See `01-transport.md` for the details, `03-inbound-messages.md` and `06-outbound-messages.md` for the stream messages, `07`/`08` for control requests.

---

## Quick-start pointers

- **"What does cli.js send us when X happens?"** → `03-inbound-messages.md` (type overview) then `04-system-subtypes.md` or `05-stream-events.md` (detail).
- **"How do I trigger Y in cli.js?"** → `07-control-outbound.md` (control subtype); or set a flag at spawn per `02-cli-flags.md`.
- **"cli.js is asking me something, what shape do I respond with?"** → `08-control-inbound.md`.
- **"How does MCP routing work end-to-end?"** → `10-mcp-hosting.md`.
- **"Session got into a bad state"** → `01-transport.md` wire-log section + `11-cancellation.md`.

---

## Who is this for

- **Future sessions** working on a new cli.js feature or integration.
- **Debugging** a wire-protocol issue that `DEBUG_SDK=1` doesn't immediately diagnose.
- **Maintenance** when cli.js bumps upstream and patches or message shapes drift.

It is NOT:
- A tutorial for MCP protocol (see the MCP spec)
- A tutorial for the Anthropic API (see docs.anthropic.com)
- A design document (see `docs/sdk-layer.md` and ADRs)

---

## Conventions

- **Code anchors**: where a behavior was verified, we cite `cli.js@char<offset>` (the character offset in the extracted file) or `src/main/sdk/<file>.ts:<line>`.
- **Gating**: when a message or subtype only fires under a specific flag or env var, it's marked **Gate:** at the top of its section.
- **Versions**: if a field was added in a specific cli.js version, it's annotated `(added 2.1.X)`. If it was removed, `(removed 2.1.Y)`.
- **JSON shapes**: given as JSON with comment annotations (not valid JSON). The actual wire format is strict JSON.

---

## Contributing

See `12-maintenance.md` for the full drift-check workflow. Short form:

1. When you discover a new wire shape / subtype / flag, document it here before (or alongside) the code change.
2. When you fix a drift, update the affected doc with the new cli.js version.
3. Don't use vague language ("mostly always", "sometimes") — if you're unsure, verify with bundle-analyzer and cite the offset.

Keep the manual exhaustive. Partial is worse than missing — a half-accurate doc is a trap.
