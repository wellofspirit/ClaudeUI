# SyncCore: replicated state, the wire and the volatile lane

Governs: `src/core/sync/`, `src/core/shared/sync/`, `src/core/services/sync-host.ts`, `src/core/services/blob-store.ts`, `src/core/services/remote-server.ts`, `src/core/ipc/command-registry.ts`, `src/main/services/sync-port.ts`, `src/renderer/src/sync/`, `src/renderer/src/stores/replica.ts`, `src/web/connection.ts`

How canonical session and app state is held and replicated to every client (the desktop renderer and the web
client), what rides the wire and in which lane, what the host keeps in memory, and how a client reconnects and loads
big payloads. As-built mechanics are in `docs/architecture/sync-core.md` and `docs/architecture/sync-channels.md`.
Queued-message identity is ADR-053 and the approval lifecycle ADR-038 (engine-model.md). Remote transport, E2E and
capabilities are ADR-052/054/056 (remote-access.md); the `blob:get` and invoke lanes stay inside that E2E channel.
Voice over the bidirectional lane is ADR-098 (voice.md). Where the code runs (core versus the two hosts) is ADR-058
(core-and-hosts.md).

## Canonical state lives in the host process, behind closed wire contracts (ADR-051)

The host process (`SyncCore`) holds the canonical state; a pure shared reducer (`applyEvent`) folds domain events into
it and every client replica runs the same reducer. The desktop renderer is client number one: same protocol, same
client library (a MessagePort transport; the web client uses WebSocket plus E2E). No client is privileged. Per-client
view state (selection, drafts, layout, scroll) is never replicated: it stays local by design.

### §1 Closed wire-contract set

Every interaction is exactly one of four things, and there is no fifth path:

- **Command**: validated, capability-checked, identity-attached, audited. It never mutates client state; the effect
  comes back as a domain event.
- **Domain event** `{seq, ...}`: append to the ring, apply to canonical, broadcast. The only way replicated state
  changes.
- **Volatile stream**: streaming deltas and PTY bytes. Subscription-scoped, never ringed, never logged. Their
  coalesced value lives in canonical state or is lossy by contract (ADR-055).
- **Query**: an RPC read.

An unclassified channel is refused at emit: every channel is classified in `src/core/shared/sync/channels.ts` (and
declared once in `src/core/ipc/*-commands.ts` factories that both transports spread), and a channel with no class
cannot be emitted. Model, effort, thinking and queue changes are ordinary domain events, so per-field sync gaps and
whole-blob clobbers are unrepresentable; granular commands replace read-modify-write round-trips.

Rules that follow:

- **Snapshots serialize canonical state in-process at a consistent seq**: a snapshot at N contains every event up to N,
  by construction (seq and state captured in one synchronous tick, no `await` between).
- **Cursor discipline**: a client's `lastSeq` advances only after it applied the event; events arriving before mount
  are buffered; a gap means resync.
- **The ring holds domain events only and is memory-only** (`event-ring.ts`, 5000 entries). A durable event log is
  rejected: the per-process epoch forces a `sync-full` after a host restart anyway, and transcripts and the DB already
  persist what matters. The audit log is the durable addition.
- **Parity is by construction**: the preload, the web adapter and the test helper build their pass-through `ClaudeAPI`
  members from one table (`src/shared/api-invoke-table.ts`); the typed web client (ADR-008) stays as a belt. The
  terminal, authcfg and webauthn families keep one thin registration per transport over shared functions.
- **Admin and host-only surfaces are `admin`/`host` capabilities**, not "desktop-only channels".
- Selection is per client: core serves `activeSessionId: null` in the snapshot and the client resolves its own.

**Decision 5. Headless-first.** `src/core` carries no Electron imports, enforced by lint; the desktop app is a host
shell around the core, and `claudeui-server` boots the core alone. The fence and the host seams are ADR-058
(`core-and-hosts.md`).

## Two lanes on the wire: reliable events and a lossy volatile lane (ADR-055)

The event lane (ring, seq, catchup, `sync-full`) carries only domain events. Volatile traffic rides a second frame
family on both transports, never ringed, never sequenced, never logged. The ring is small and boring, so a
backgrounded client reconnects into `sync-catchup`, never `sync-full`, however noisy the turns were (pinned by e2e).
Cached pre-lane client bundles are deliberately not supported: clients ship with the server and the epoch bump forces
one `sync-full`; no compatibility lane exists.

Rules:

- **Two flavors, split by what a stream honestly is.** Offset-carrying item streams fold over canonical state through
  one shared pure fold (`src/core/shared/sync/item-stream.ts`, in core and every replica). **Pass-through tails**
  (`session:bash-output`, `session:background-output`, `automation:stream-event`) carry the emission verbatim and are
  **honest-lossy**: no accumulation, no replay, no refetch. A dropped tail chunk is gone; the durable record
  (`tool_result`, final messages) rides the event lane and always arrives. Do not force tails into the offset model.
- **Replay-on-subscribe is the self-heal.** `stream:watch {sessionIds, automationRuns?}` is a capability-declared
  query with replace-set semantics, capped at 32 per set (`MAX_STREAM_WATCH`), per connection, dying with the socket.
  Subscribing replays every watched stream from offset 0, **empty accumulations included** (a replay is a claim about
  the session; omitting empties leaves a cleared buffer uncorrectable). Reconnect heals by re-watching; a mismatch
  heals by re-sending the same set. Automation tails scope by `automationId` (the wire field `automationRuns` is an
  honest misnomer).
- **Subscriptions are read-class and per connection** (ADR-054): watching costs nothing against step-up decay and ends
  with the socket.
- **Backpressure drops, never blocks, and never touches the event lane.** A connection whose socket buffers more than
  1 MiB (`STREAM_BACKPRESSURE_BYTES`) has its stream-lane frames skipped; a missing event would be a permanent hole,
  so the event lane is never dropped. (A PTY pauses its child; a stream lane cannot pause an LLM.)
- **Git watch is interest, not ownership.** Per-connection `git:watch {cwds}` replace-sets whose union drives polling;
  a lost cleanup costs nothing because re-stating a set is the correction. One `startPolling` callback per cwd; the
  cached status is always emitted first to joiners and re-staters.
- **Watched sessions: seeds are not events.** `session:watch-update` is a notify `{routingId, sessionId, projectKey,
cwd?}`; the file re-read goes to canonical as a seed (`seedWatchedSession`, the replace twin of `seedSession`)
  ordered before the notify, and clients answer with one debounced refetch. `projectKey` rides the notify because it
  is a lossy function of the cwd and cannot be derived client-side.
- **Remote voice: the lane is bidirectional.** Upstream audio rides per-connection `voice-audio` frames (bounded,
  silently dropped without an active capture, never logged: audio is keystrokes); `voice:start`/`voice:stop` are
  audited commands; transcripts return targeted at the capturing connection only (not watch-filtered, not
  broadcast, never to plugin observers). Frames are not step-up-gated per frame: authority is judged at the audited
  `voice:start`. `voice:*` declares `chat`, which widens the legacy token/tailnet surface; accepted because that
  surface already permits `session:send`. `getUserMedia` needs a secure context (the tailnet HTTPS origin).
- **Plugin parity is preserved**: an in-process observer list synthesizes the old emission shapes from lane frames
  (only while a plugin listens), outside the ring.

### amendment: per-item streams

`session:item-open` (reliable) establishes a transcript block and generation; `session:item-delta` (volatile) appends
only new text; `session:item-seal` (reliable) commits the resolved final content and retires the named field
atomically (a targetless seal retires every active field of that message). An unwatched client therefore still gets the
complete final item. The snapshot carries the active map; a watch replays an explicit atomic replacement, empty
included, gated by the reliable-event watermark and generation. Every engine produces items; the earlier accumulating
text-stream family (`session:stream`, `session:subagent-stream`, `StreamFrame`, the `streaming*` canonical fields) was
retired, and `legacy-producer-guard.unit.test.ts` pins that nothing emits it. Rules that bind:

1. **A watermark reads the event cursor; it never advances it.** `atSeq` names the reliable events required before a
   frame applies; only applied reliable events advance `lastSeq`. Early item frames are discarded while sync and
   rewatch restore a valid basis. A new transport must preserve that ordering or implement the same sync/replay
   recovery.
2. **Recovery needs no further token and no seal.** An item can pause while the model waits for a tool. The server
   remembers only which watched sessions need a fresh replacement (never the missed chunks) and retries coalesced per
   connection with capped backoff, cleaned up on unwatch and disconnect, through the same high-water gate.
3. **Message commit semantics are shared.** Item seals and ordinary message events use the same content merge,
   duration stamping and derived-field updates; child commits stay in the child's transcript. A targeted seal commits
   its field and keeps other committed blocks; a targetless seal commits the whole message. Duplicating part of the
   commit logic is a defect, not a second contract.

## Transcript images are content-addressed blobs off the ring; an exited session's transcript leaves canonical (ADR-087)

The "ring is bounded, so sync is bounded" belief is false: the ring bounds only catchup (and by entries, not bytes);
a `sync-full` is all of canonical state; and canonical used to keep every transcript for the life of the process,
worst on a headless host that runs for days. Two rulings fix the size of a snapshot.

### §1 Image and document bytes leave the replication lanes

- The host interns bytes in a **content-addressed, in-memory, LRU-bounded `BlobStore`** (1 GiB of decoded bytes,
  `src/core/services/blob-store.ts`). `blobId` is the SHA-256 of the decoded bytes.
- Everything replicated carries a **`BlobRef {blobId, bytes}`** instead of `base64Data`: `ToolResultImage`, `image` and
  `document` content blocks, the attachments of `session:user-message` and of queue items. Interning happens at the
  producers (shared tool-result decoder, each engine's mapper, the history readers, `sendPrompt`), so the reducer never
  sees a byte. `base64Data` survives only on an upload (`AttachmentUpload`, an invoke argument, never ringed).
- Clients fetch through the query **`blob:get`** (`chat` capability), cache the result, and resolve an image only as it
  nears the viewport.
- **It is an invoke, not an HTTP route**, deliberately: `/sent-file` is plain HTTP behind a scoped URL token, outside
  the E2E channel; transcript images were inside the encrypted snapshot, and a screenshot of the operator's screen is
  conversation content. Moving them to HTTP would be a quiet downgrade. Cost: no browser HTTP cache; a client LRU
  instead. `chat` is correct because a `chat` grant already reads these bytes inside the snapshot; the 256-bit id is
  not enumerable.
- **Memory-only on purpose**: a host restart re-reads transcripts and re-interns. A blob the LRU dropped is
  unavailable until a transcript containing it is read again; the client shows a quiet placeholder.

### §2 Canonical drops the transcript of a session with no live engine

- On `session:status` `disconnected` (and when a watched session stops being watched), `SyncCore.evictTranscript`
  strips `messages`, `subagentMessages` and the item streams and clears `seeded`, keeping the row and every light
  field. It does nothing for a session with `sdkActive` or a running turn, and nothing for a transcript already empty
  (a spawned-but-never-prompted session has nothing to drop and must not be told to read from disk).
- It is a **host cache decision, not an event**, the mirror of the client's `evictLocalSessions`: connected replicas
  keep what they folded and nothing blanks. It is not routed through the reducer (a ringed eviction event would blank
  and refetch the session on screen).
- `PerSessionSnapshot.seeded: false` means "canonical does not hold this transcript", either dropped by the host or a
  resume's history read still in flight. A client tells them apart by `sdkActive`: a dead one is marked evicted (a
  sidebar click reloads from disk; if it is on screen it is reloaded and replaced in one step), a live one is filled
  from disk fill-only so an in-flight turn is never wiped.
- **An evicted entry always resumes on send**; the resume decision must not key on "has messages", or a prompt typed
  before the reload lands would start a new conversation under the old row. The chat shows its loading state, not the
  welcome screen, while the active entry is evicted.
- **`sendPrompt` awaits the async history seed.** `seedSession` only fills an empty transcript, so a prompt that beat
  the read would leave canonical with a one-turn transcript marked complete.
- Accepted costs: a resumed session re-reads its transcript on the host; a client resyncing onto an exited session
  shows its last-known transcript until the disk load lands, which re-mints message ids and loses the (never
  persisted) thinking-duration label. The snapshot invariant `restore(N) + fold === canonical@head` holds except for a
  transcript evicted after the snapshot was taken (the invariant test masks exactly those sessions).
- Rejected: compressing the snapshot (base64 PNG and ciphertext do not compress); per-client scoped snapshots (live
  sessions the client did not ask for would fold events with no prefix); persisting `lastSeq`; a byte budget on the
  ring or a disk tier for blobs.

## Per-call invoke progress, chunked full sync, and opening a session before its transcript loads (ADR-102)

Long invokes report progress to the one client that made them; a session opens at once and loads behind a bar.

- **`invoke-progress` frame is additive**: `{type:'invoke-progress', id, done, total|null, phase}`, addressed by the
  invoke's id, sent only on the requesting socket, no version bump (an old bundle ignores an unknown server frame). On
  the desktop one extra host-local channel `invoke:with-progress (callId, channel, ...args)` dispatches through the
  same `commandRegistry.dispatch` and answers `invoke:progress` to `event.sender` only; the preload keeps it internal.
- **`withProgress` registry option** is channel-global and asserted equal across transports. A `withProgress` handler
  gets its reporter in a fixed LEADING slot (`handler(connection?, progress, ...wireArgs)`), for the same
  attacker-padding reason as `withConnection`; a transport without one passes a no-op. Capability and audit paths are
  unchanged: every progress call still goes through `dispatch`.
- **Transport-owned throttle and lifecycle** (`src/shared/progress-throttle.ts`): four reports a second (first
  immediate, latest flushed, completion immediate); after the handler resolves, flush, then (remote only) one
  `phase:'sending'` frame, then the response, then close, so no frame trails the response. The web client slides its
  30 s invoke timeout on every progress frame; a socket close rejects every pending invoke (`Connection lost:`).
- **Content first (amendment).** `session:load-history` takes an options object (4th wire arg); `{deferStatusLine: true}` skips
  the status pass and returns `statusLine: null`, plus a `subagentIndex` and `transcriptMtimeMs`; its byte plan is the
  transcript pass alone. Other callers (host seed, watcher, automation) keep the full read. The cost/token status line
  (`session:load-status-line`, withProgress) and the subagent transcripts load afterwards for the ACTIVE session only
  (started by activation, cancelled on deactivation, generation-guarded against eviction and reload), shown by a thin
  bar under the TopBar. Subagent fetches run at most two at a time, parents of nested agents first, then newest first;
  an expanded card or task-panel entry jumps the queue. Fills are fill-only and need the entry to hold its transcript.
  `session:load-subagent-history` is withProgress. A send waits only for the content load. Tail-first partial loading
  is rejected: the Claude reader is order-dependent and has no prepend primitive.
- **The first prompt after reopening (amendment)**: a non-fork Claude seed reads content-first; the resumed `ClaudeSession` re-folds
  its own totals at spawn and `sendPrompt` waits for that fold (`ISession.resumeSeedReady`), so a turn never starts on
  zeros or double-counts. The fold is memoized in the main process (small LRU keyed by path and fork anchor, valid
  while the main file and the subagent file set are unchanged). Forks keep the full anchored read.
- **Navigate first.** Clicking a non-resident session creates (or re-marks) an evicted placeholder carrying its
  persisted identity (engine, permission mode, model), switches to it at once and shows the loading view with bar,
  phase, size and ETA. The load is registered in the same in-flight map a send waits on, so a prompt typed during the
  load waits for it and a second click only navigates. Failure shows "Couldn't load / Retry".
- **An empty evicted or historical entry is never dropped as an abandoned scratch session** (`cleanupEmptySession`),
  or `forgetDroppedSession` would scrub its recents, pin, hidden flag and custom title.
- Engines whose readers are RPC or whole-file reads (opencode, pi) show an indeterminate bar. An invoke response still
  rides one frame with no byte progress while "Receiving...".
- Rejected: broadcasting progress as a replicated event (wrong scope, rings); a `parts` hint on the generic frame
  (handler-specific keys on a generic frame).

### amendment: a chunked sync-full is reassembled

The web client's "Syncing state..." overlay shows a real progress bar; a browser WebSocket delivers whole messages
only, so the `sync-full` frame is chunked. Snapshot shrinking (lazy subagent buckets, partial first paint) was
declined for now.

- **Opt-in and additive**: `WsSyncRequest` gains `chunked?: true`, which the web client always sends. An old tab on a
  new host omits it and gets the single `sync-full` byte for byte. No version bump. The desktop MessagePort never opts
  in; catchup is untouched.
- **Wire**: a `full` decision is serialized once to the exact `JSON.stringify` of the `WsSyncFull` message and sliced
  into `sync-full-chunk {index, count, totalChars, data}` frames of `SYNC_FULL_CHUNK_CHARS` (512 K UTF-16 units,
  `src/core/shared/sync/sync-full-chunks.ts`). `count`/`totalChars` repeat on every chunk; the client finishes at
  `index === count - 1`. A small snapshot still goes as one chunk. A chunk boundary never splits a surrogate pair.
- **The host answers an opted-in `sync` as `sync-full-chunk`; contiguity rests on `handleSync` staying synchronous.**
  Every chunk is sent (plaintext) or enqueued on the one per-socket queue (E2E) inside that one call, so no
  broadcast, stream frame or ping lands between chunks. An `await` in there would silently break contiguity on both
  transports; the client's index check is the defensive layer, not the guarantee.
- **Client**: reassembles, reports `{receivedChars, totalChars}` (JSON characters, never called byte-accurate; E2E
  base64 is about 1.37x) to the overlay through `setSyncProgressHandler`, then runs the ordinary `sync-full` apply.
  `syncToFrameMs` is measured from the `sync` that started the transfer, captured at chunk 0.
- **A broken sequence reconnects, then gives up, never loops.** An index gap, changed `count`/`totalChars`, invalid
  fields, or joined text that is unparsable or not a `sync-full` discards the transfer and closes the socket
  (ordinary reconnect with backoff). A successful open resets the backoff, so a host fault that breaks every transfer
  would re-download forever; therefore three broken transfers in a row (`MAX_BROKEN_SYNC_TRANSFERS`, reset by a
  successful full apply or catchup) latch `failed` ("The host sent an incomplete state snapshot several times in a
  row"), `scheduleReconnect` declines and the overlay's Retry reloads the page.
- Accepted cost: re-escaping JSON inside a JSON string adds a few percent on the wire. `SyncStats` logs one line per
  transfer (`chunks=N`, `frameBytes` the sum of the chunk frames).
- Rejected: an authenticated HTTP route streaming the body (a scoped token plus E2E body encryption is a bigger
  security surface); a size pre-announcement (no progress from whole messages). Version skew is one-directional (the
  web bundle is served by the host it talks to, ADR-060/099): an old tab left open ignores new frames until reloaded.

## A remote re-sync merges into local view state instead of replacing it (ADR-041)

Superseded by ADR-051 for where the snapshot comes from (core canonical state, not the desktop renderer's store).
What still binds is what the web client does on every sync-full after the first (`applyRemoteSnapshot`/
`hydrateReplica(snapshot, isResync)` in `src/renderer/src/stores/replica.ts`; `RemoteApp` in `src/web/main.tsx`
passes `isResync = true` from the second sync-full on, flipped before the async store import so racing sync-fulls stay
ordered):

- **First hydration**: the snapshot wins wholesale.
- **Re-sync**: the `sessions` map is merged, `{...local, ...snapshot}`: snapshot entries win where both know the
  session; local-only entries (sessions the client hydrated from disk) survive so the kept selection resolves.
  `activeSessionId` keeps the local non-null value when it resolves in the merged map; otherwise it falls back to the
  snapshot's, then the most recent known session. A stale pointer rendering the empty state is worse than following
  the host.
- Server-authoritative collections (directories, recents, pins, custom titles, settings) are adopted wholesale on
  every sync; the merge protects view and navigation state only.
- **Why it matters**: mobile browsers discard backgrounded pages, so a full re-hydration is the common path on a
  phone. Wholesale replacement teleported the client to the host's selection, and the next prompt went to the wrong
  session or created a fresh wrong-engine session (a routing bug, not cosmetic). Mobile selection is deliberately not
  mirrored to the desktop.
- **Accepted staleness**: a session the host deleted while the client was away lingers as a local-only entry until the
  next reload (a little memory, not a ghost sidebar row). Fields added to `PerSessionSnapshot` ride whichever side
  wins the entry; snapshot-absent optional fields must default sanely on rebuild.
