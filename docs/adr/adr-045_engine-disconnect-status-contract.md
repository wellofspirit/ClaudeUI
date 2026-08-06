# ADR-045 — Engine adapters must emit `disconnected`; it is the renderer's only "activity off" signal

**Status:** Accepted (2026-08-03)
**Relates to:** ADR-030 (capability honesty), ADR-038 (event-driven approval lifecycle — the
same "never infer lifecycle in the renderer" principle applied to approvals)

## Context

The sidebar's per-session activity dot is green when `session.status.state === 'running'`
**or** `session.sdkActive`. `sdkActive` is set optimistically when a prompt is sent and is
cleared in exactly one place: the renderer's `session:status` handler on receiving
`state: 'disconnected'` (`useClaudeEvents` — which also rewrites the stored state to `idle`
and clears pending approvals). There is deliberately no renderer-side inference (timers,
turn-shape heuristics) — ADR-038 established why inferred lifecycle is a bug factory.

That contract was implicit, and `OpencodeSession` never learned it: its status getter only
produced `running`/`idle`, its SSE-loss handling was gated on `isProcessing`, and neither
server death, idle stream loss, `cancel()` (user teardown / idle timeout), nor a failed
first connect ever emitted `disconnected`. Result: every opencode session's dot stayed
green forever — the bug fixed in `5d0c118`.

## Decision

`state: 'disconnected'` is a **required part of the engine adapter contract**, not a
Claude-ism. Every `BaseSession` implementation MUST emit a `session:status` with
`state: 'disconnected'` on **every** path where the engine can no longer serve the session
without a fresh connect/spawn:

1. backing process/server death (including deaths while idle and deaths of
   eagerly-connected sessions that never received a prompt),
2. transport loss (stream end, RPC channel close) that is not a deliberate abort,
3. deliberate teardown — `cancel()` / `dispose()` / idle timeout,
4. a failed connect for a turn (the turn errored before a connection existed).

Renderer-side rules (unchanged, now written down):
- `disconnected` clears `sdkActive` and is stored as `idle`; adapters may keep reporting
  `disconnected` from their status getter until the next successful connect (PiSession /
  OpencodeSession use a persistent flag; ClaudeSession uses a one-shot broadcast — both
  satisfy the contract).
- The renderer must never infer disconnection from anything else.

Adapter-side corollaries learned in 5d0c118:
- **Release by spawn identity, never by key alone, on loss paths.** After a death, a
  key-only ref release can decrement a *replacement* server another session already
  acquired (`OpencodeServerManager.releaseIfCurrent`).
- **Shared-process managers need an unexpected-exit fan-out** (`subscribeExit`) so sessions
  with no active stream still learn about death; deliberate kills must not fan out
  (drop-handle-before-kill makes the exit handler's identity gate mean "unexpected").
- Loss teardown must null the adapter's connection refs so the next `run()` reacquires.

## Consequences

- Any future engine adapter (or transport rework) has a checklist: all four path classes
  above must end in a `disconnected` emission, with component tests per path (see
  `OpencodeSession.test.ts` "disconnect status" and `PiSession.test.ts` for templates).
- The green dot is now trustworthy across engines; "stays green forever" is a contract
  violation, not a cosmetic quirk.

## Alternatives considered

- **Renderer heuristics** (clear `sdkActive` on `session:error`, timers): rejected —
  ADR-038's lesson; background subagents and long turns make every heuristic wrong.
- **A separate `session:disconnected` event**: rejected — the status channel already
  carries the state; a second channel doubles the places adapters can forget.
