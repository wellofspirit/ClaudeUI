# cli.js Protocol Manual

Reference documentation for the complete wire protocol between ClaudeUI's SDK harness (`src/core/sdk/`) and `vendor/claude-cli/cli.js`. This is a maintenance manual — it's meant to be kept complete, current, and specific so a future session with zero context can:

- Understand how a message crosses the wire
- Look up the full shape of any message cli.js can send
- Look up the full shape of any message we can send cli.js
- Look up what any CLI flag does without guessing
- Build a new integration (new control request, new stream event consumer) without re-reverse-engineering cli.js

## Verified against

```
cli.js version: 2.1.268
upstream SDK:   @anthropic-ai/claude-code 2.1.268 (Bun 1.4.1 standalone binary, chunked ESM graph)
```

> Bundle-format note: since 2.1.261 the vendored `vendor/claude-cli/cli.js` is a
> concatenation of minified ESM chunks behind `// @bun-chunk` delimiter lines
> (1,631 at 2.1.261, 1,652 at 2.1.268, 2,121 at 2.1.285 on win32-x64 — see 01-transport §1.12).
> Char anchors recorded in these docs before 2.1.261 refer to the old monolithic
> bundle — re-locate by string literal.

The doc should be re-verified each time `package.json#claudeCliVersion` bumps. See `12-maintenance.md` for the drift check workflow. **2.1.280 verification:** all 14 patch application/upstream-detection steps and all 12 patch test suites passed on Windows. Live tests used the app-selected account directory through `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `SKIP_SECURESTORAGE=1`, not the system login. The localhost SSE ordering and per-request usage fixtures passed (6 tests); the native binary's top-level `--help` catalog (66 long flags) was compared with 02-cli-flags; the production OAuth URL/client ID and JSON refresh-body shape were checked in the native binary. The context catalog drift check found an `opus` alias/pricing change, mirrored in `src/shared/`. The banner remains at 2.1.268 because these checks do not establish full wire-catalog, hidden-flag, or provider-specific manual verification.

**2.1.285 verification (2026-09-30):** all three registry patches apply (4 of 2,121 chunks modified; `voice-server` re-anchored because the fallback text became an imported constant, see its README). The rebundled binary runs, and the trailer's new flag bits 11 and 12 are dropped (01 §1.12). Both live patch suites passed twice on Windows (`test:patch`, 18/18 checks per run, Haiku 4.5). A stream-json probe exercised `voice_server_start`/`stop` end to end, and the localhost SSE ordering fixtures passed (5 tests). Drift checks: `--help` gained `--client-data-url` and `--desktop` (02 §2.14b); new system subtypes `session_title_changed` and `per_turn_effort_changed` (04 §4.29–4.30); production OAuth constants and the host-token contract anchors are unchanged. The model catalog adds Sonnet 5.5 and remaps `sonnet`, mirrored in `src/shared/` (13 §13.5 note). The banner stays at 2.1.268 for the reason given above.

**2.1.289 (2026-10-05, bounded):** additive only against 2.1.285 — `system/instruction_size_warning` (04 §4.31), outbound `get_task_output` (07 §7.3), `--client-data-url` removed (never passed), `project` → `purge`; 0 consumed-wire breaks. `voice-server`'s reply-helper locator was made chunk-scoped (its README), with a local anchor regression suite.

**2.1.290 bounded verification (2026-10-06):** bundled build and the compatibility floor (floor = tested = 2.1.290, owner ruling). Compared pristine darwin-arm64 concats and native `--help` against 2.1.289. Public-contract drift: 0 long flags added or removed (71 → 71; `attach`/`logs` also take a session name); zod `subtype` literals +1, `system/file_attachments_missing` (`@internal`, bridge-worker only, answers the `@internal` `file_attachments` ClaudeUI never sends); one optional `@internal` user-frame field `refused_message_id`; one print-mode control handler `set_proactivity_level {level, offer_bypass}` with no public schema; capability id `register_repo_root_v1` appears only in the cloud-hosted unavailable set, not in `system/init`. No removals; production OAuth constants and the model-id set are unchanged. 0 consumed-wire breaks. All three registry patches apply unchanged (2,252 chunks), `test:patch` passes 3/3 (subagent-streaming 9/9, voice-server-anchors 4/4, bash-output-streaming 9/9, Haiku 4.5), the voice start/connect/idempotent-start/native-fallback/stop probe passes, and the localhost SSE ordering fixtures pass. Hidden/provider/plugin surfaces were not manually re-verified, so the banner stays at 2.1.268.

**2.1.293 bounded verification (2026-10-08):** bundled build and the compatibility floor (floor = tested = 2.1.293, ADR-082 §3). Compared pristine darwin-arm64 concats and native `--help` against 2.1.290. Public-contract drift: 0 long flags added or removed (71 → 71, `--help` byte-identical; `plugin install` gained `--marketplace <source>`, unused). Zod `subtype` literals +2: `system/permission_check_status` (`@internal`, on the wire in print mode when an auto-mode permission check runs past ~4 s; 04 §4.32; not consumed) and host→CLI `ui_prompt_autocomplete` (`@internal`, never sent). Additive public fields: `run_id` on every `task_*` frame and `background_tasks_changed` entry, `parent_task_id` on `task_started` and those entries, `subagent_type` on the entries (04 §4.5 note); `agent_id` on forwarded subagent `assistant`/`user` frames, which still carry `parent_tool_use_id`, so ClaudeUI's placement and turn-start checks are unaffected (03 §3.3). Additive `@internal`: `stream_event.abandoned_blocks` on cli.js's synthesized `message_stop` (05 §5.8), `result.safety_stops`, `api_error` value `usage_limit_reached`, `request_marker_lists_v1` in `system/init.capabilities`; `@internal` `result.system_prompt_detail` removed. No print-mode handler removed; production OAuth constants and the host-token contract anchors are unchanged. 0 consumed-wire breaks. Model catalog: new `claude-haiku-5-5`, and the first-party `haiku` alias moved to it (13 header note). All three registry patches apply unchanged (2,290 chunks), `test:patch` passes 3/3 (subagent-streaming 9/9, voice-server-anchors 4/4, bash-output-streaming 9/9, Haiku 4.5), the voice start/connect/idempotent-start/native-fallback/stop probe passes, and the localhost SSE ordering fixtures pass (5 tests). Hidden/provider/plugin surfaces were not manually re-verified, so the banner stays at 2.1.268.

**2.1.308 bounded verification (2026-10-22):** bundled build and compatibility floor
are 2.1.308. Against pristine 2.1.306, the complete baked model catalog (19,901
characters), production OAuth URL/client constants, native long-flag set are unchanged. The schema-literal audit adds three internal
outbound cloud queries (`list_cloud_sessions`, `get_cloud_session`,
`get_cloud_session_transcript`) and the stored attachment `projects_thread_ask`.
ClaudeUI does not send these queries or consume that attachment; no literals were removed. Host-token gates, null-refresh-token
credentials and different-token 401 adoption remain present; no auth exchange was
performed. Auto-mode stage-2 prompt and default rules are unchanged. All three
patches apply unchanged to win32-x64, darwin-arm64 and linux-x64 (Linux ELF
rebundling remains unsupported); Windows boot passes. Offline SDK contracts pass
6/6. Isolated Haiku live patch suites pass: subagent 9/9, Bash 9/9, voice anchors
4/4. Voice start/TCP/stop succeeds on the patched binary; official 2.1.308 rejects
`voice_server_start`. Native macOS/Linux execution, voice transcription and the
full hidden/provider/plugin surface were not verified; the comprehensive banner
below remains historical.
**2.1.306 bounded verification (2026-10-21):** bundled build and the compatibility floor (floor = tested = 2.1.306, ADR-082 §3). Compared the pristine 2.1.293 win32-x64 concat and the native `--help` against 2.1.306: 0 long flags added or removed (71 → 71). Zod `subtype` literals +2: `system/checkpoint_done` (ephemeral transcript bookkeeping with `live_turn_id`/`stored_through_live_index`; not consumed) and `system/rewind_stand_in` (rewind stand-in marker carrying `source_uuid`; not consumed). No removals; unknown system subtypes stay tolerated. Production OAuth constants (`TOKEN_URL`, client ids) and every host-token anchor (the `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` gate, the same-token 401 path, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `refreshToken:null`, `oauth_token_refresh`) are byte-identical between the two bundles. 0 consumed-wire breaks. Patches: `voice-server` and `bash-output-streaming` applied unchanged; `subagent-streaming` needed only a wider Patch-F sanity window (the sub-agent generator declaration moved to ~21.9k before the RVY gate; anchors unchanged), 2,484 chunks. Boot probe ok; cross-platform apply ok on win32-x64, darwin-arm64 and linux-x64. `test:patch` passes 3/3 on the app account's token (subagent-streaming 9/9 — background subagents still stream 194 stamped `stream_event`s, so 2.1.302's background scheduling does not replace the patch — voice-server-anchors 4/4, bash-output-streaming 9/9), and the localhost SSE ordering fixtures pass (6 tests). Model catalog: Sonnet 5.5 moved to `tier_2_10_cache_read_0_10` (cache reads $0.10/MTok, 2.1.296's change), mirrored in `src/shared/pricing.ts`; `maximum_window:1e6` + `clamp_long_context_without_beta` appeared on the beta-1M models (native-1M set unchanged), `total_tokens_reminder` on every model's capabilities and image limits 2000→2576/maxImageTokens 4784 — none of the three is mirrored. Hidden/provider/plugin surfaces were not re-verified, so the banner stays at 2.1.268.

**2026-09-25 (ADR-079):** the patch counts above predate the patch-set reduction. At that point the registry held three patches — `subagent-streaming`, `voice-server`, `bash-output-streaming` (01 §1.12) — and `bun run test:patch` ran two live suites (`voice-server` had none; its local anchor regression suite was added at 2.1.289). `automode-verdict` joined from pre-release and was removed on 2026-09-28 by owner ruling: auto-mode allow verdicts were not worth a patch, and denials are native `permission_denied` (04 §4.25). Two were removed on 2026-09-27: `subprocess-proxy-strip` (the in-app proxy now reaches cli.js's children) and `skip-securestorage` (multi-account now hands cli.js the active account's token through `CLAUDE_CODE_OAUTH_TOKEN` and answers `oauth_token_refresh`, on Claude Desktop's contract: 02 §2.14, 06 §6.7, 08 §8.7). Of the nine the reduction retired, five were deleted as dead or upstream and four replaced by native surfaces, each documented here against the 2.1.280 bundle: `background_tasks`, `cancel_async_message` and `reload_plugins` (07), `command_lifecycle` (03 §3.21), `rate_limit_event.rate_limit_info.unifiedWindows` (03 §3.11). The app reads the patches a binary carries from `version.json` `patches` (01 §1.12) and runs on Anthropic's unpatched binary with subagent token streaming and live Bash output absent and voice off.

---

## Table of contents

| #   | Doc                                                | What                                                           |
| --- | -------------------------------------------------- | -------------------------------------------------------------- |
| 01  | [Transport](01-transport.md)                       | Spawn, stdio, ndjson, env, startup/teardown, signals, wire log |
| 02  | [CLI flags](02-cli-flags.md)                       | Every `--flag` cli.js accepts — effect, default, interactions  |
| 03  | [Inbound messages](03-inbound-messages.md)         | Every stream-json `type` cli.js emits to us                    |
| 04  | [System subtypes](04-system-subtypes.md)           | Every `system/<subtype>` variant and its fields                |
| 05  | [Stream events](05-stream-events.md)               | `stream_event` deltas — every event.type and delta.type        |
| 06  | [Outbound messages](06-outbound-messages.md)       | Every stream-json `type` cli.js accepts from us on stdin       |
| 07  | [Control outbound](07-control-outbound.md)         | Every control_request subtype we send cli.js                   |
| 08  | [Control inbound](08-control-inbound.md)           | Every control_request subtype cli.js sends us                  |
| 09  | [Initialize](09-initialize.md)                     | Deep dive on the initialize request/response                   |
| 10  | [MCP hosting](10-mcp-hosting.md)                   | `mcp_message` wire protocol + server lifecycle                 |
| 11  | [Cancellation](11-cancellation.md)                 | Three-tier cancellation + timeouts                             |
| 12  | [Maintenance](12-maintenance.md)                   | How to keep the manual and harness in sync                     |
| 13  | [Context window](13-context-window.md)             | How cli.js resolves model context windows + ClaudeUI's mirror  |
| 14  | [Auto mode classifier](14-auto-mode-classifier.md) | `permissionMode: "auto"` — two-stage LLM permission classifier |
| 15  | [Peer sessions](15-peer-sessions.md)               | Peer messages, cross-session socket, holds, context ceilings   |

---

## Architecture at a glance

```
┌─────────────────────────────────────────┐
│  ClaudeUI (Electron main)               │
│    src/core/sdk/query.ts                │
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
- **"How does auto mode decide to allow or block?"** → `14-auto-mode-classifier.md`.
- **"Session got into a bad state"** → `01-transport.md` wire-log section + `11-cancellation.md`.

---

## Who is this for

- **Future sessions** working on a new cli.js feature or integration.
- **Debugging** a wire-protocol issue that `DEBUG_SDK=1` doesn't immediately diagnose.
- **Maintenance** when cli.js bumps upstream and patches or message shapes drift.

It is NOT:

- A tutorial for MCP protocol (see the MCP spec)
- A tutorial for the Anthropic API (see docs.anthropic.com)
- A design document (see the ADRs — notably ADR-006 for the rebundled-Bun-binary pipeline)

---

## Conventions

- **Code anchors**: where a behavior was verified, we cite `cli.js@char<offset>` (the character offset in the extracted file) or `src/core/sdk/<file>.ts:<line>`.
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
