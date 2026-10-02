# ADR-089: A user stop is not an error

**Status:** Accepted (2026-10-02). Built on branch `pi-subagents-dispatch-judge` (S4a).
**Relates to:** [ADR-045](adr-045_engine-disconnect-status-contract.md) (the sibling adapter
contract: disconnect status), [ADR-088](adr-088_pi-subagents-host-run.md) (pi subagents, their Stop
and `task_stop`), [ADR-053](adr-053_queue-item-identity-cc-parity.md) (a steer is not a fresh turn).

## Context

Pressing Stop (Esc) on a running pi turn put a red error banner on the session: "The operation was
aborted." opencode has the same problem, and Codex can hit it in a race. Claude Code never shows one.
The causes differ per engine:

- **pi (0.87.1, upstream bug).** After an abort during a tool batch, pi's loop does not check the
  signal before the NEXT model request (`vendor/pi-src/packages/agent/src/agent-loop.ts:182-243,
262-296`). That request's setup (`ModelRuntime.streamSimple` → `lazyStream(setup)`,
  `coding-agent/src/core/sdk.ts:375-385`, `model-runtime.ts:638-643`) rejects at once on the aborted
  signal (`model-runtime.ts:575-588`), and `lazyStream` turns ANY setup failure into an assistant
  message with `stopReason: "error"` and no content, never consulting the signal
  (`vendor/pi-src/packages/ai/src/api/lazy.ts:4-23, 46-60`). The loop ends on it
  (`agent-loop.ts:244-254`), so pi emits `message_end { stopReason: 'error', errorMessage: 'The
operation was aborted.' }`. ClaudeUI's mapper turns that into a turn error
  (`src/core/pi/event-mapper.ts`), and PiSession sent `session:error`. There is no structural marker:
  the only tell is the text.
- **opencode (1.18.32).** An aborted turn is an Effect interrupt; the processor's `onInterrupt` calls
  `halt(new DOMException("Aborted", "AbortError"))` (`vendor/opencode-src/packages/opencode/src/session/processor.ts:661-668`),
  which publishes `session.error` named `MessageAbortedError` with `data.message: "Aborted"`
  (`session/message-v2.ts:610-620`, `packages/core/src/v1/session.ts:50`). ClaudeUI mapped every
  own-session `session.error` to a banner, and a task child's to `status: 'failed'`. opencode's own
  UIs hide it (`packages/app/src/pages/session/timeline/rows.ts:118-121`; ACP maps it to
  `stopReason: "cancelled"`).
- **Codex (0.156.0).** An interrupted turn completes `status: Interrupted, error: None`
  (`vendor/codex-src/codex-rs/app-server/src/bespoke_event_handling.rs:1531-1553`), so the ordinary
  path shows nothing. A turn that ends `failed` in a race with the interrupt still raised "Codex turn
  failed. Check native account status…", which misreads a Stop.
- **Claude (reference).** `ClaudeSession` sets `wasInterrupted` in `interrupt()`, the `stopTask`
  foreground fallback and `cancel()`, clears it in `run()`, and while it is set a non-`success`
  `result` raises no `session:error` ("These aren't real failures — suppress.").

## Decision

**A turn error that follows a user stop is not shown.** One rule for every engine, implemented once
in `BaseSession`:

- `beginUserStop()` opens a per-session **user-stop window**. Each adapter calls it as the FIRST step
  of `interrupt()` — before the abort request is sent, because the engine's error can arrive before
  the request's reply — and only when a turn is live (a window opened at idle would swallow the next
  turn's genuine error). A user stop is reached only through the `session:interrupt` IPC, so the
  window is user-initiated by construction.
- `suppressedAfterUserStop(tag, message)` is true while the window is open; the adapter then sends no
  turn-error `session:error`, and the helper logs `turn error after a user stop, not shown: <engine
error string>` at info. The turn-end bookkeeping (processing state, status, inactivity timer, queue
  boundary) runs unchanged.
- `endUserStop()` closes it: when the stopped turn ends, when a fresh turn starts, and when the
  session goes away. A steer while the stopped turn drains does not close it.

Per engine:

| Engine   | Opens (in `interrupt()`)                                              | Suppresses                                               | Closes                                                                      |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| pi       | `isProcessing`                                                        | the `error` output (`message_end` `stopReason: 'error'`) | `result` (`agent_settled`), `run()` when not busy, `cancel()`, process exit |
| opencode | `isProcessing`, before `abortSession`                                 | the `error` output (own `session.error`)                 | `result` (`session.idle`), `run()`'s fresh-turn path, `cancel()`            |
| Codex    | `turnId` or `sending`, before the dispose branch and `turn/interrupt` | the root turn's `turn.error` banner in `finishTurn`      | `finishTurn` (root turn), `run()` with a prompt, `disconnected()`           |
| Claude   | unchanged: `wasInterrupted`                                           | non-`success` `result`                                   | unchanged                                                                   |

The window is the rule, not the error's shape: an opencode `MessageAbortedError` or a pi "aborted"
error OUTSIDE a user stop is unexplained and still shows. Codex's `interruptRequested` (a deferred
interrupt across a start) is a different flag and is not reused.

**Never suppressed:** `auth-required` (an expired credential is still news after a stop), a failed
prompt ack (it is about the new prompt), the transport-loss and disconnect banners (ADR-045), the
Codex guardian-breaker banner (a turn the guardian aborted, not the user), the stale-judge banners,
pi's `send_message_error` / `delivery_error`.

**Children.** No child path raises `session:error` on the parent. The visible artefact was the pi
child's nested `[error: The operation was aborted.]` row (same root cause as pi above). Rule: while
`PiChildRunner` is `draining` — the host aborted the turn: a per-agent Stop, `task_stop`, the
interrupt cascade, a dispatch stop, or a dispatch timeout (which already reports its own failure) —
an `error` output still settles the turn but is not streamed as a row (logged at debug). `draining`
is cleared by the next `sendTurn`, so a resumed run is not affected. opencode: a task CHILD's
`session.error` is not terminal at all (pre-release 437189ec: opencode may compact and continue), so
the child's outcome comes from the parent's `task` part alone; no separate child status mapping is
needed.

## Consequences

- Stop reads the same on every engine: the turn ends, no banner. A genuine error in the next turn
  still shows.
- Every adapter's `interrupt()` must open the window before its abort request, and every turn-error
  emission must ask the helper. A new adapter inherits the helper from `BaseSession`.
- Tests per engine pin both halves (suppressed after a stop; shown on a later turn; nothing opened at
  idle): `PiSession.test.ts`, `pi-child-runner.test.ts`, `OpencodeSession.test.ts`,
  `opencode/__tests__/event-mapper.test.ts`, `codex-session.test.ts`.

## Alternatives considered

- **Structural only** (opencode's `MessageAbortedError`, a pi error that "reads like" an abort):
  pi has no structural marker, so this would mean text matching; and it would hide an abort the user
  did not cause.
- **Both the window and the error's shape:** stricter, but the window alone is Claude Code's rule and
  needs no per-engine text.
- **Threading the stop reason into `PiChildRunner`** so only user stops suppress the child row: more
  plumbing for no visible gain (a timed-out dispatch reports its own failure already).

## Residuals

- pi's `lazy.ts` should map an aborted signal to `stopReason: "aborted"` (every real provider already
  does); until upstream fixes it, the host suppresses the symptom.
- An opencode or pi abort outside a user stop (another client, an engine-side cancel) still shows a
  banner.
- `ClaudeSession` keeps its own `wasInterrupted` (it predates the helper and works).
