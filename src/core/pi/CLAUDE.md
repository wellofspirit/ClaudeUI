# src/core/pi

The pi engine (`pi --mode rpc`, LF-framed JSONL over stdio): the session, its RPC client, the loopback bridge host and extension, the permission ladder, host-run subagents. ADR-035, ADR-089, ADR-110.

## What lives here

- `src/core/pi/PiSession.ts`: the session (very large: grep the regions listed below); `src/core/pi/PiRpcClient.ts` the RPC client; `src/core/pi/pi-protocol.ts` hand-written wire types; `src/core/pi/pi-locate.ts` the binary.
- `src/core/pi/PiBridgeHost.ts`: per-session loopback HTTP host (`/tool-call`, `/hosted-tool`, `/skills`, `/mcp-servers`); `src/core/pi/pi-bridge-source.ts`: the extension source as one string.
- `src/core/pi/event-mapper.ts` (live events), `src/core/pi/pi-custom-message.ts`, `src/core/pi/message-cost.ts`, `src/core/pi/usage-row.ts`, `src/core/pi/history-status-line.ts`.
- `src/core/pi/permission-engine.ts`: name trap, the rule ladder every engine shares, not pi-only. Outside importers: `src/core/opencode/` (`OpencodeSession.ts`; `host-precheck.ts` takes the plan-mode shell oracle), the dispatcher and the pi and opencode dispatch targets in `src/core/services/`, `src/core/shared/tool-review.ts`.
- `src/core/pi/pi-path-scope.ts` (path containment), `src/core/pi/pi-scratchpad.ts`, `src/core/pi/hosted-grants.ts` (one-shot `/hosted-tool` grants).
- `src/core/pi/pi-child-runner.ts` (one headless child, shared with dispatch targets), `src/core/pi/pi-subagents.ts`, `src/core/pi/pi-agent-*.ts`, `src/core/pi/pi-subagent-store.ts`.
- `src/core/pi/pi-native-raw.ts`, `src/core/pi/pi-models-raw.ts`, `src/core/pi/pi-json-raw.ts`: raw readers of pi's own `settings.json` and `models.json`; `src/core/pi/model-discovery.ts` lists models.
- Cold history, fork anchor and session delete are `src/core/services/pi-session-list.ts`, not here. `src/core/pi/pi-spawn-prep.ts` is the pi twin of `src/core/providers/claude-spawn-prep.ts`.
- Wire reference: `docs/protocol-pi/README.md` from its "Transport" section; version-exact upstream docs in `vendor/pi-src/packages/coding-agent/docs/` (main checkout only).
- Regions of `PiSession.ts` (grep the method) with the `-t` block of `src/core/pi/__tests__/PiSession.test.ts`:
  - Spawn and init: `ensureStarted`, `doStart`, `replayStoredHistory`; `-t "PiSession resume"`, `-t "PiSession fork"`, `-t "doStart"`.
  - Turns: `run`, `deliverNonUser`, `dispatchOutput`, `interrupt`, `cancel`; `-t "PiSession.run"`, `-t "a user stop is not an error"`, `-t "queue of record"`, `-t "PiSession.cancel"`, `-t "crash path"`.
  - Gate and approvals: `decideToolCall`, `decideToolCallLadder`, `askHuman`, `takePendingGate`, `resolveApproval`; `-t "approval bridge wiring"`, `-t "path containment"`, `-t "plan mode"`.
  - Judge and block hold: `classifyAutoMode`, `holdBlock`, `keepBlocked`, `sendToolReview`; `-t "auto-mode classifier wiring"`.
  - Hosted tools and session tools: `handleHostedTool`, `handleSessionTool`, `handleDispatchAgent`; `-t "handleHostedTool"`, `-t "the session tools"`.
  - Subagents: `src/core/pi/pi-subagents.ts` through `this.subagents`; `-t "host-run subagents"`. Config and status: `setModel`, `setEffort`, `sendStatus`; `-t "PiSession.setModel"`, `-t "PiSession.setEffort"`.

## Recipes

**An approval-response fix** (the answer for a card flows one way, then per engine)

1. `src/core/ipc/approval-response.ts` `answerApproval`: an `xeng:` id goes to `crossEngineDispatcher.resolveApproval`, anything else to the session [test: approval-response.test.ts].
2. pi `PiSession.resolveApproval`; opencode `src/core/opencode/OpencodeSession.ts` `resolveApproval`; Claude `src/core/services/claude-session.ts` `resolveApproval` [test: PiSession.test.ts `-t resolveApproval`, OpencodeSession.test.ts `-t approvals`, claude-session-resolve-approval.test.ts].
3. Hand-kept mirrors of the pi ask and hold glue (the code says so): `holdBlock` and `keepBlocked` in `OpencodeSession.ts`; `forwardPiTargetAsk` in `src/core/services/dispatch-pi-targets.ts`; `onTargetApproval` in `src/core/services/dispatch-opencode-targets.ts`; `awaitClaudeTargetApproval` in `src/core/services/dispatch-claude-targets.ts`; `armForwardedHold` and `resolveApproval` in `src/core/services/cross-engine-dispatcher.ts` [nothing forces the siblings to agree].
4. Shared ladder `decideWithSource` in `src/core/pi/permission-engine.ts`: a change moves all engines [test: permission-engine.test.ts; dispatcher specs `-t "approval forwarding"`, `-t "pi direction"`, `-t "opencode target — approvals"`].

**A change to the bridge extension source**

1. `src/core/pi/pi-bridge-source.ts`: edit the string, then bump `PI_BRIDGE_VERSION` [nothing forces the bump; `pi-bridge-source.test.ts` pins the number, so update it with the bump].
2. `src/core/pi/PiBridgeHost.ts` is the only reader of the constant (`writeBridgeExtension` writes a version-keyed directory); a new exchange route needs `ROUTES`, `PiBridgeRoute` and a branch in `dispatchBody` [nothing: an unhandled route falls to the hosted-tool branch], with a case in `PiBridgeHost.test.ts`.

## Invariants

- The bridge extension source has no imports and fails closed (the rules are in the header of `src/core/pi/pi-bridge-source.ts`).
- `PiSession.run` reads `isProcessing` only after `await ensureStarted()`: two runs during spawn would otherwise both send a bare `prompt` that pi rejects while streaming.
- `piToolKind` in `src/core/pi/permission-engine.ts` mirrors `src/renderer/src/components/chat/tool-registry/PiEngineToolMap.ts`; `PiEngineToolMap.test.ts` and `session-tools-maps.test.ts` fail on drift.
- Path containment (`pi-path-scope.ts`), scratchpads (`pi-scratchpad.ts`) and the judge path are Critical areas (ADR-026): run their specs and ask for the exit review.

## Fast test

- `bunx vitest run src/core/pi` (`PiSession.test.ts` is very large: select a block with `-t "<block>"`); also `src/core/services/__tests__/pi-session-list.test.ts`.
- `PI_INTEGRATION_TESTS=1 bun run test:integration src/integration/pi` (real pi from the managed store; skips without the flag or the install, and a skipped run has not passed).
