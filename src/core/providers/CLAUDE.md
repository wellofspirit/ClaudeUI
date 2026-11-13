# src/core/providers

The engine-session seam: the interface and shared base every engine session implements, plus the factory and spawn-prep registries. ADR-030, ADR-045, ADR-053, ADR-090.

## What lives here

- Name trap: "provider" here means the engine session seam. Model providers are `src/core/shared-providers/`; per-engine sign-in is `EngineAuthProvider` in `src/core/auth/`.
- `src/core/providers/ISession.ts`: `ISession` (a live config change goes through `applyConfig`, never a per-field setter), the optional capability-gated members, and `EngineSpawnOptions` (the session's `SessionConfig` plus what only a spawn has).
- `src/core/providers/BaseSession.ts`: shared plumbing: `send` (typed from the event map in `src/core/shared/sync/events.ts`: a channel or payload that does not match it does not compile), the queue of record, the user-stop window, `baseStatusFields()`. It owns no turn or usage bookkeeping.
- `src/core/providers/EngineRegistry.ts`, `src/core/providers/SpawnPrepRegistry.ts`, `src/core/providers/register-engines.ts`: engine id to session factory and to spawn prep.
- `src/core/providers/claude-spawn-prep.ts` (spawn prep resolves the model only; siblings `src/core/pi/pi-spawn-prep.ts`, `src/core/opencode/opencode-spawn-prep.ts`), `src/core/providers/session-queue.ts`, `src/core/providers/turn-origin-ledger.ts`, `src/core/providers/client-prompt-observer.ts`.
- Each engine keeps its session code in a different shape. Claude: `src/core/services/claude-session.ts`, the other `src/core/services/claude-*.ts`, harness `src/core/sdk/`. opencode: `src/core/opencode/` (`OpencodeSession.ts`, `event-mapper.ts` live, `history.ts` cold).
- pi: `src/core/pi/` (`PiSession.ts`, `event-mapper.ts` live, `history.ts` cold; the session list and cold load are `src/core/services/pi-session-list.ts`); see `src/core/pi/CLAUDE.md`.

## Recipes

**A per-session option** (exemplar: `effort`; `thinkingMode` is Claude-only, `reasoningVariant` opencode-only). One type, `SessionConfig`, carries it at spawn and in a live change, so it cannot exist on one path only.

1. `src/shared/types/session-config.ts`: the `SessionConfig` field [compiler: steps 2 and 3 stop compiling until they name it].
2. Each engine's `liveConfig` table (`src/core/services/claude-session.ts`, `src/core/opencode/OpencodeSession.ts`, `src/core/pi/PiSession.ts`): the setter that takes a live change, or `null` when the engine has none; and its place in `CONFIG_ORDER` in `src/core/providers/BaseSession.ts`, the order `applyConfig` applies a patch in [compiler].
3. `CONFIG_WIRE_CHECKS` in `src/core/ipc/spawn-request.ts`: what the value must be when a client sends it; only checked fields reach the spawn options [compiler].
4. The constructors of the engines that take it at spawn read it from `opts` (`EngineSpawnOptions` extends `SessionConfig`) [nothing: an unread option is silently ignored]. The create path needs no edit: `prepareAndCreateSession` in `src/core/ipc/create-session.ts` spreads the config whole.
5. Renderer: `spawnSession` in `src/renderer/src/lib/session-spawn.ts` puts it in the request's `config`; it is the only caller of `window.api.createSession` [test: a guard spec fails on another caller; nothing forces the field itself]. The host-created path, `startSession` in `src/core/services/session-tools.ts`, when a tool-started session should carry it [nothing].
6. A live change from a client: a host function in `src/core/ipc/handlers-core.ts` that validates, calls `session.applyConfig({ field })` and emits through `emitConfigChanged` (extend its patch type), the `session-config` entry in `src/core/ipc/session-commands.ts`, the method in `src/shared/types/api/session.ts` and its entry in `src/shared/api-invoke-table.ts` [compiler for the table]. Claude applies effort and thinking mode by respawn (`spawnSession` with `resume: 'self'`); pi's `setEffort` applies live.
7. Replication to every client (`session:created` announce, `session:config-changed`): `src/core/shared/sync/CLAUDE.md`. A value the engine holds beyond the birth event is announced at spawn by `announceSpawnConfig` in `src/core/ipc/handlers-core.ts` (today the reasoning variant).

`session:create` is `(routingId, request)`; `src/core/ipc/spawn-request.ts` also maps the 11 positional arguments a client loaded before 2026-11 still sends, and is the only place that knows that order.

**A capability flag** (exemplar: `sideQuestion`)

1. `src/shared/model-capabilities.ts`: `EngineCapabilities` field, each engine's `*_ENGINE_CAPABILITIES` constant and the hand-copied list in `resolveCapabilities` [compiler]. Machine-dependent truth is ANDed in each session's `capabilities` getter (`claude-session.ts`, `OpencodeSession.ts`, `PiSession.ts`) [nothing: the static flag then overstates].
2. Guard in `src/core/ipc/handlers-core.ts`, renderer reads of `session.capabilities.<flag>` (`InputBox.tsx`, `ChatPanel.tsx`), and a per-engine assertion in `src/shared/__tests__/model-capabilities.test.ts` [nothing]. `baseStatusFields()` and `src/shared/engine-meta.ts` need no edit.

**A field on a content block** (exemplar: `tool_result.images`)

1. `src/shared/types/content.ts`: `ContentBlock` variant [compiler only if the field is required].
2. Claude: `src/core/services/claude-transcript.ts` (`claudeContentBlock`; a tool result is `claudeToolResults` plus `claudeToolResultBlock`). Live frames, the item stream, transcript replay and the subagent tail all build through it [test: claude-history-parity.test.ts]. `transformAssistantMessage` in `src/core/services/automation-manager.ts` is a separate mapper that drops unknown and empty blocks [nothing].
3. pi: `src/core/pi/pi-blocks.ts` (`piAssistantBlock`, `piToolResultBlock`), used by `src/core/pi/event-mapper.ts` (live) and `src/core/pi/history.ts` (cold) [test: `src/core/pi/__tests__/history-parity.test.ts`]. opencode: `src/core/opencode/event-mapper.ts` and `src/core/opencode/history.ts` [test: `src/core/opencode/__tests__/history-parity.test.ts`].
4. A live tool result is not a block until the reducer folds it: a field on `tool_result` also rides the `session:tool-result` payload (Claude: `extractToolResultsFromContent` in `src/core/services/claude-session.ts` and `src/core/services/dispatch-claude-targets.ts`; pi: the `tool_result` mapper output that `PiSession.ts` sends) and the reducer (`src/core/shared/sync/CLAUDE.md`) [nothing forces the senders; each parity spec folds the payload itself, so it fails until its fold carries the field].

## Invariants

- Every exit path ends in a `disconnected` status (ADR-045): `cancel()` in each session; opencode's `markDisconnected()`; `claude-session.ts` sends it unless `disposed`.
- A capability flag is true only when the whole path works (ADR-030): `src/shared/model-capabilities.ts` constants and the session `capabilities` getters.
- The user-stop window (ADR-090): `beginUserStop`, `endUserStop`, `suppressedAfterUserStop` in `BaseSession.ts`; open it before the abort request, only while a turn is live. Claude keeps its own `wasInterrupted` flag instead.
- `dispose()` must fence a replaced session so its late run cannot emit on the shared routing id: `SessionManager.create` calls it; `ClaudeSession.dispose` sets the `disposed` fence; pi's and opencode's `dispose()` call `cancel()`, which in pi sets `_cancelled`.
- `OpencodeSession.cancel()` and `markDisconnected()` keep overlapping reset lists (feed, leases, queue recall, shell poller); change both together.
- `onPromptQueued` (`BaseSession.ts`) holds by default and `PiSession` forwards at a sub-turn boundary via `flushQueuedItems`; `ClaudeSession` and `OpencodeSession` override it and forward at once.
- `session:auth-required` is emitted before the `session:status` that leaves `running`: the reducer reads `running` to offer a retry (`src/core/shared/sync/reducer.ts`; `src/core/shared/sync/CLAUDE.md`).

## Fast test

- `bunx vitest run src/core/providers src/shared/__tests__/model-capabilities.test.ts src/core/services/__tests__/pi-session-list.test.ts`
- Blocks: `bunx vitest run src/core/services/__tests__/claude-history-parity.test.ts src/core/services/__tests__/claude-transcript.test.ts src/core/pi/__tests__/history-parity.test.ts src/core/opencode/__tests__/history-parity.test.ts`
