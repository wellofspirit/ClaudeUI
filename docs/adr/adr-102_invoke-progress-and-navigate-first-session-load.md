# ADR-102: Per-call invoke progress, and opening a session before its transcript loads

**Status:** Accepted (2026-10-19); amended the same day (content first) and on 2026-10-22 (chunked full sync with a progress bar — both below). Implemented on branch `feat/session-load-progress` (PR #80).
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

## Amendment: content first, the rest in the background (2026-10-19, same branch)

Measured after Decision 1–6 shipped: the main transcript pass that builds every message takes
46–82 ms; the cost/token status line (a second pass over the main file plus EVERY subagent file —
387–834 MB on disk for the owner's sessions) takes 0.6–1.2 s; fetching all subagent transcripts
takes 0.9–2 s. So the wait was never the conversation itself.

- **Tail-first partial loading was rejected.** The Claude reader is order-dependent (a tool result
  whose call precedes the cut is dropped, notifications lose their agent, run numbering and
  "unfinished" detection need the whole file, assistant ids span lines); no prepend primitive exists
  and the no-clobber rule refuses a second fill; a prompt sent after a tail commit spawns at once and
  the older part could then never land; todos, sent files, galleries, roster and fork positions are
  whole-transcript derivations.
- **Content first.** `session:load-history` takes an optional options object (4th wire arg);
  `{deferStatusLine: true}` skips the status pass and returns `statusLine: null`, plus a
  `subagentIndex` (per origin tool_use id: agentId, parent, bytes, mtime order, sidecar name /
  description / type) and `transcriptMtimeMs`. Its byte plan is the transcript pass alone
  (total = M). The full-screen loader therefore covers ~60 ms plus transfer. Other callers (host
  seed, watcher, automation) keep the full read.
- **Background phase.** A new `session:load-status-line` (withProgress, total = M + S) and the
  subagent transcripts load after the content, for the ACTIVE session only (started by activation,
  cancelled on deactivation, generation-guarded against evictions and reloads), shown by a 2 px bar
  under the chat TopBar. Subagent fetches: ≤ 2 in flight, parents of nested agents first, then
  newest first; an expanded card or task-panel entry jumps the queue. Bucket fills are fill-only and
  require the entry to hold its transcript; the status line replaces the previous one unless the
  session is live (the live session seeds its own totals). `session:load-subagent-history` is
  declared withProgress so the remote `sending` frame slides the 30 s timeout during a large transfer.
- Decision 4's `2M + 2S` plan and `subagentFileBytes` are superseded by the two plans above; a send
  waits only for the content load.
- **The first prompt after reopening (2026-10-20, PR #111).** The engine spawns on the first send,
  and its canonical seed was still a full read with the cost pass (~0.6–1.2 s on large sessions),
  which `sendPrompt` waited on. A non-fork Claude seed now reads content-first too; the resumed
  `ClaudeSession` already re-folds its own totals at spawn, and `sendPrompt` waits for that fold
  (`ISession.resumeSeedReady`) instead, so a turn never starts on zeros or double-counts. The fold
  is memoized in the main process (8-entry LRU keyed by path and fork anchor, valid while the main
  file's inode/size/mtime and the subagent file set are unchanged), so the background status pass
  warms it: first prompt ~0.93 s → ~48 ms on a 21 MB transcript with 817 MB of subagent files.
  Forks keep the full anchored read.

## Amendment: chunked full sync with a progress bar (2026-10-22)

The web/phone client's "Syncing state..." overlay was a bare spinner for the whole transfer, and the
transfer is ≥95% of the wait: measured full syncs grow 5 → 41 MB over ~1.5 days (~75% subagent
buckets of live sessions), 0.2–3.9 s typical and 7–10 s worst on a slow link. A browser WebSocket
delivers whole messages only, so a 40 MB `sync-full` frame is one opaque wait — nothing to draw a bar
from. Shrinking the snapshot (lazy subagent buckets, a partial first paint) was designed and
**declined** for now; the owner asked for exactly one thing: a real progress bar. This is the
"chunked responses, deferred" line from Consequences below — applied to the sync snapshot, which is
a server-pushed frame, not an invoke response.

- **Opt-in, additive.** `WsSyncRequest` gains `chunked?: true` and the web client always sends it.
  The only skew direction is an OLD tab on a NEW host (the host serves the bundle, ADR-060/099): it
  omits the field and gets today's single `sync-full` byte for byte. No version bump.
- **Wire.** A `full` decision is serialized ONCE to the exact `JSON.stringify` of the `WsSyncFull`
  message and sliced into `sync-full-chunk {index, count, totalChars, data}` frames of
  `SYNC_FULL_CHUNK_CHARS` (512 K UTF-16 code units, `src/core/shared/sync/sync-full-chunks.ts`).
  `count`/`totalChars` repeat on every chunk instead of a begin/end frame: the client is
  determinate from the first frame and finishes at `index === count - 1`. A snapshot under one chunk
  still goes as ONE chunk. Catchup is untouched, and the desktop's MessagePort never opts in.
- **Contiguity rests on `handleSync` staying SYNCHRONOUS.** Every chunk is `ws.send`-ed (plaintext)
  or enqueued on the one per-socket queue (E2E) inside that one call, so no broadcast, stream frame
  or ping can land between two chunks of a transfer. An `await` in there (say, a snapshot built off
  the main thread) would silently break that on both transports; the client's index check is the
  defensive layer, not the guarantee.
- **Surrogate rule.** A chunk boundary never splits a UTF-16 surrogate pair. Belt-and-braces only:
  `JSON.stringify` is well-formed (lone surrogates become `\udXXX` escapes), so a split pair would
  round-trip through the chunk's own JSON wrapper and rejoin intact anyway.
- **Client.** Reassembles, reports `{receivedChars, totalChars}` — JSON characters (≈ MB), never
  called "byte-accurate"; E2E base64 is ~1.37× the characters — to the overlay through
  `setSyncProgressHandler`, then runs the existing `sync-full` apply with the timing summed over the
  chunk frames. `syncToFrameMs` is measured from the `sync` that started the transfer, captured at
  chunk 0, so a resync sent mid-transfer cannot shorten it.
- **A broken sequence reconnects, then gives up — never a loop.** An index gap, a changed
  `count`/`totalChars`, invalid fields, or joined text that is unparsable or not a `sync-full` →
  discard and `ws.close()`, which lands in the ordinary `onclose` → `scheduleReconnect` path (backoff
  1→30 s, "Reconnecting...") and syncs afresh. The backoff alone cannot bound this: each reconnect
  opens a socket, and a successful open resets the attempt counter, so a host fault that breaks
  EVERY transfer would re-download the snapshot about once a second forever. Three broken transfers
  in a row (since the last successful apply) latch `failed` with "The host sent an incomplete state
  snapshot several times in a row"; `scheduleReconnect` then declines, and the overlay's Retry
  reloads the page. Silence, by contrast, would leave the owner staring at a frozen bar with nothing
  to re-arm a sync.
- **Cost.** Re-escaping the JSON text inside a JSON string adds a few % on the wire (~3% on the
  measured 20.4 MB snapshot: 20,960,606 wire bytes vs 20,359,213 JSON characters, plaintext) and
  ~40 MB transient for a plaintext 40 MB snapshot; under E2E the phone's peak
  roughly halves (per-chunk decode instead of one base64 + binary-string + typed + decoded chain).
  Accepted: the owner does not mind load time. `SyncStats` keeps one line per transfer — `chunks=N`,
  `frameBytes` = the SUM of the chunk frames (sync-core.md § Measuring a full sync).
- **Alternatives rejected.** A new authenticated HTTP route streaming `Response.body` gives native
  byte progress but needs a scoped token and E2E body encryption — a bigger security surface for the
  same bar. A size pre-announcement before one big frame gives no progress at all (whole messages
  only). Chunking is the floor.

## Consequences

- Any long query can opt in with `withProgress: true` on both registrations and a reporter call.
- Version skew is one-directional (ADR-060/099: the web bundle is served by the host it talks to):
  an old bundle in a tab left open across an update ignores the frames and keeps its fixed 30 s
  timeout until reloaded; a new bundle never meets an old host.
- Engines whose readers are RPC or whole-file reads (Codex, opencode, pi) show an indeterminate bar.
- The transfer of a single large response frame still shows no byte progress ("Receiving…"); that
  would need chunked responses, deferred until lazy subagents shrink the payload. (The 2026-10-22
  amendment chunks the `sync-full` FRAME, which is a server push; an invoke response still rides
  one frame.)
- A full (non-resync) hydrate may drop the placeholder; the in-flight load then commits without
  navigating. Accepted as rare.

## Alternatives considered

- **Broadcast progress as a replicated event** (the harness-installer precedent): reaches every
  client and rings for replay — wrong scope for one client's read, and noisy.
- **A `parts` hint on the frame** (send S separately so the client can plan its fetches): rejected in
  design review for C1 above; it puts handler-specific keys on a generic frame.
- **Lazy subagent loading first:** cuts the remote payload from 30–40 MB to ~1.4 MB, but needs a
  per-agent index for nested agents (an audit of every `subagentMessages` consumer found the roster's
  nested rows, the TaskCard body and the task panel depend on buckets; approvals, todos, sent files,
  find-in-chat, rename and fork do not). Progress and navigate-first came first because they help every
  engine; lazy loading followed in the Amendment, with the index built from the subagent sidecars.
