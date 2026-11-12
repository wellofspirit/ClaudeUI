# src/core/providers

The engine-session seam: the interface and shared base every engine session implements, plus the factory and spawn-prep registries. ADR-030, ADR-045, ADR-053, ADR-090.

## What lives here

- Name trap: "provider" here means the engine session seam. Model providers are `src/core/shared-providers/`; per-engine sign-in is `EngineAuthProvider` in `src/core/auth/`.
- `src/core/providers/ISession.ts`: `ISession`, the optional capability-gated members, and `EngineSpawnOptions` (the named spawn options every factory receives).
- `src/core/providers/BaseSession.ts`: shared plumbing: `send` (typed from the event map in `src/core/shared/sync/events.ts`: a channel or payload that does not match it does not compile), the queue of record, the user-stop window, `baseStatusFields()`. It owns no turn or usage bookkeeping.
- `src/core/providers/EngineRegistry.ts`, `src/core/providers/SpawnPrepRegistry.ts`, `src/core/providers/register-engines.ts`: engine id to session factory and to spawn prep.
- `src/core/providers/claude-spawn-prep.ts` (spawn prep resolves the model only; siblings `src/core/pi/pi-spawn-prep.ts`, `src/core/opencode/opencode-spawn-prep.ts`), `src/core/providers/session-queue.ts`, `src/core/providers/turn-origin-ledger.ts`, `src/core/providers/client-prompt-observer.ts`.
- Each engine keeps its session code in a different shape. Claude: `src/core/services/claude-session.ts`, the other `src/core/services/claude-*.ts`, harness `src/core/sdk/`. opencode: `src/core/opencode/` (`OpencodeSession.ts`, `event-mapper.ts` live, `history.ts` cold).
- pi: `src/core/pi/` (`PiSession.ts`, `event-mapper.ts` live, `history.ts` cold; the session list and cold load are `src/core/services/pi-session-list.ts`); see `src/core/pi/CLAUDE.md`.

## Recipes

**A per-session option every engine honours** (exemplar: `effort`, spawn field plus `setEffort`; `thinkingMode` is Claude-only). It has a spawn path and a live-setter path.

1. `src/core/providers/ISession.ts`: `EngineSpawnOptions` field, and an optional `ISession` setter if it changes live [nothing: an unread option is silently ignored].
2. Constructors read `opts`: `src/core/services/claude-session.ts`, `src/core/opencode/OpencodeSession.ts`, `src/core/pi/PiSession.ts` [nothing].
3. `src/core/ipc/create-session.ts` (`CreateSessionArgs`, `spawnOpts` in `prepareAndCreateSession`) and the `session:create` handler's positional args in `src/core/ipc/session-commands.ts`, each through `opt()` [nothing: a field not copied is dropped].
4. `src/shared/types/api/session.ts` (`createSession`) and `src/shared/api-invoke-table.ts` (`createSession` arity): append at the end [compiler: arity against the method].
5. Every `window.api.createSession` call passes positionally: `src/renderer/src/stores/session-store.ts`, `InputBox.tsx` (including `restartSdkSession`), `ExitPlanModeCard.tsx`, `ReviewBar.tsx`; and the host-created path, `startSession` in `src/core/services/session-tools.ts` [nothing: a skipped site spawns without it].
6. Live setter: `src/core/ipc/handlers-core.ts` (setter plus the `emitConfigChanged` patch type), the `session-config` entry in `src/core/ipc/session-commands.ts`, the entry in `src/shared/api-invoke-table.ts` [compiler]. opencode `reasoningVariant` has this path only, so a respawn drops it; Claude applies effort and thinking mode by respawn (`restartSdkSession` in `InputBox.tsx`); pi's `setEffort` applies live.
7. Replication to every client (`session:created` announce, `session:config-changed`): `src/core/shared/sync/CLAUDE.md`.

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
