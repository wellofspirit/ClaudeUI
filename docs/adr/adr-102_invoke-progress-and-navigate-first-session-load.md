# ADR-102: Per-call invoke progress, and opening a session before its transcript loads

**Status:** Accepted (2026-10-19). Implementation on branch `feat/session-load-progress`; resume notes
in `docs/session-load-progress-handoff.md`.
**Relates to:** [ADR-051](adr-051_sync-core-replication-architecture.md) (the frame families both
transports speak), [ADR-052](adr-052_remote-auth-passkeys-capabilities.md) (the command registry's
capability check, which this keeps as the one choke point), [ADR-056](adr-056_headless-admission-model.md)
(additive frames need no handshake change), [ADR-087](adr-087_transcript-blobs-off-the-ring-and-host-eviction.md)
(why an exited session's transcript is read from disk by each client),
[ADR-073](adr-073_agent-roster-and-task-run-identity.md) (subagent transcripts, which this keeps
loading eagerly for now).

## Context

Opening a Claude session from the sidebar read its main transcript and then every subagent
transcript, and only switched the view once all of it had arrived. Measured on the owner's real
sessions (2026-10-19, Electron 41, warm page cache):

| stage                                                           | 73 subagents | 42 subagents |
| --------------------------------------------------------------- | ------------ | ------------ |
| main process: main transcript (read + metrics pass + cost fold) | ~760 ms      | ~1210 ms     |
| main process: every subagent transcript                         | ~940 ms      | ~1940 ms     |
| structured clone to the renderer                                | 10–50 ms     | 10–50 ms     |
| store commit + paint                                            | ~100 ms      | ~100 ms      |
| click → painted                                                 | 1.95 s       | 3.7 s        |

The main transcript's result is about 1.4 MB; the subagent buckets are 29–40 MB, 95% of it. With a
cold page cache, or over the remote link (one JSON frame per call, AES-GCM + base64 under E2E, a fixed
30 s client timeout), the same load took long enough that a click looked dead — and a second click
restarted it. Time is dominated by parsing in the main process, which is linear in bytes read, so
bytes are an accurate progress measure. A progress bar therefore needs a way for one in-flight
invoke to report to the one client that made it; nothing did that: harness and voice-pack progress
ride replicated broadcast events, and the volatile lane is session-scoped.

## Decision

1. **`invoke-progress` frame (additive).** `{type:'invoke-progress', id, done, total|null, phase}`,
   addressed by the invoke's own id, sent only on the requesting socket. No version bump: an old web
   bundle ignores an unknown server frame (its `handleMessage` has no default branch) and an old
   server never sends one. On the desktop, where invokes ride `ipcRenderer.invoke` (which resolves
   once), one extra host-local channel `invoke:with-progress (callId, channel, ...args)` dispatches
   through the same `commandRegistry.dispatch` and answers `invoke:progress (callId, p)` to
   `event.sender` only. The preload keeps that channel internal; only named API wrappers use it.
2. **`withProgress` registry option**, channel-global like `capability`/`kind` and asserted equal
   across transports. A `withProgress` handler receives a reporter in a fixed LEADING slot
   (`handler(connection?, progress, ...wireArgs)`), for the same attacker-padding reason as
   `withConnection`. A transport without a reporter passes a no-op, so a handler reports
   unconditionally. No capability or audit path changes: every progress call still goes through
   `dispatch`.
3. **Transport-owned throttle and lifecycle.** Reports are throttled to four a second (first one
   immediate, latest flushed, completion immediate). After the handler resolves: flush, then (remote
   only) one `phase:'sending'` frame, then the response, then close, so no frame trails the response.
   The web client slides its 30 s invoke timeout on every progress frame, and a socket close now
   rejects every pending invoke (`Connection lost:`, matched by `isInvokeTimeout`).
4. **The Claude history read plans the whole load.** Its first report carries the final total
   `2M + 2S` (M = main transcript bytes, read twice: the transcript pass and the metrics pass; S =
   subagent bytes, read once by the cost fold and once more by the client's per-agent fetches). Its
   own last report is `2M + S`; the client continues from there, weighting each fetch by
   `subagentFileBytes`, and lands on 100% at commit. One plan, one monotonic bar, no hint fields on
   the generic frame. The second S disappears when subagent loading goes lazy.
5. **Navigate first.** A click on a session that is not resident creates (or re-marks) an evicted
   placeholder carrying the session's persisted identity (engine, permission mode, model), switches
   to it at once, and shows the loading view with the bar, phase, MB and ETA. The load is registered
   in the same in-flight map a send waits on, so a prompt typed during the load waits for it, and a
   second click on a loading session only navigates. A failure shows the existing "Couldn't load /
   Retry" state. Subagent fetches run at most four at a time, largest first, so the bar moves
   evenly and the remote link is not flooded.
6. **An empty evicted or historical entry is never dropped as an abandoned scratch session.**
   `cleanupEmptySession` used to drop it on navigate-away and `forgetDroppedSession` then scrubbed its
   recents, pin, hidden flag and custom title.

## Consequences

- Any long query can opt in with `withProgress: true` on both registrations and a reporter call.
- A new web bundle against an older desktop gets no frames: indeterminate bar, fixed 30 s timeout,
  exactly as before.
- Engines whose readers are RPC or whole-file reads (Codex, opencode, pi) show an indeterminate bar.
- The transfer of a single large response frame still shows no byte progress ("Receiving…"); that
  would need chunked responses, deferred until lazy subagents shrink the payload.
- A full (non-resync) hydrate may drop the placeholder; the in-flight load then commits without
  navigating. Accepted as rare.

## Alternatives considered

- **Broadcast progress as a replicated event** (the harness-installer precedent): reaches every
  client and rings for replay — wrong scope for one client's read, and noisy.
- **A `parts` hint on the frame** (send S separately so the client can plan its fetches): rejected in
  design review for C1 above; it puts handler-specific keys on a generic frame.
- **Lazy subagent loading first:** cuts the remote payload from 30–40 MB to ~1.4 MB, and is the
  next step, but needs a per-agent index for nested agents (audit in the handoff doc). Progress and
  navigate-first are independent of it and help every engine.
