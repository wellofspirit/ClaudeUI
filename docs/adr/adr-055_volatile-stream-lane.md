# ADR-055 — The volatile stream lane: two-lane wire, lossy tails, per-connection subscriptions, remote voice

**Status:** **Implemented** (owner-ratified 2026-08-16, landed 2026-08-17). Four series on `v3`: S1 `bcdf752` (stream lane), S2 `bbb8a67` (tails, backpressure, git-watch retirement), S4 `3d85ca6` (watch-update notify+refetch), S3 `9e905c9` (remote browser voice). This completes ADR-051's phase 5 and closes its migration table. As-built mechanics live in [sync-core.md](../architecture/sync-core.md) (contract 3) and [sync-channels.md](../architecture/sync-channels.md) (§The stream lane, the `volatile` class rows); this ADR keeps the decisions and the reasoning, several of which are NOT derivable from the code.
**Relates to:** ADR-051 (this is its contract 3, refined and built), ADR-054 (the read/act split — subscriptions are read-class; the attached-stream rationale is reused for voice frames), ADR-005 (plugin events — parity deliberately preserved), ADR-041 (voice transcripts land in per-client draft state).
**Supersedes in part:** ADR-052's git-watch note — the collective-owner workaround it predicted per-client subscriptions would retire is now retired. Also retires sync-channels.md's rule 1 ("never reduce ring membership"): this is the migration that rule always named.

## Context

Phase 4 left the ring poisoned by design: streaming deltas, bash tails and full
watched-transcript re-reads all took ring seqs, so one busy turn flushed the
5000-entry ring and every reconnect degraded to `sync-full` — the exact failure
the ring exists to prevent. ADR-051's contract 3 named the cure (a
subscription-scoped volatile lane) but left the mechanics, the migration, and
three real design holes to this phase:

- contract 3's justification ("a delta stream is fully summarized by its
  accumulation in canonical state") was **false for the tails** —
  `session:bash-output`, `session:background-output` and
  `automation:stream-event` have no canonical accumulation to refetch;
- "per-client subscriptions" had no model (granularity, defaults, security);
- the ring-membership migration was flagged but undesigned.

## Decisions

### 1. Two lanes, no compatibility lane

The event lane (ring, seq, catchup, `sync-full`) is untouched and carries only
domain events. Volatile traffic rides a second frame family on both transports,
never ringed, never sequenced, never logged. **Cached pre-phase-5 bundles are
deliberately not supported** (owner: "we don't need to worry about cached
bundles — just remove old one"): desktop and web clients ship with the server,
the epoch bump on deploy forces one `sync-full`, and a stale cached bundle gets
typed refusals for deleted verbs, not crashes. The legacy dual-lane design that
would have kept old bundles streaming was designed and then discarded on this
ruling — recorded so nobody re-derives it.

### 2. Two flavors, split by what a stream honestly is

- **`text-stream`** (`session:stream`, `session:subagent-stream`): offset-carrying
  frames over a canonical accumulation, folded by ONE shared interpretation
  (`applyStreamFrame`) on core and every replica.
- **`pass-through`** (the three tails): the emission verbatim, `{channel, args}`,
  dispatched client-side into the same per-channel listeners the event lane
  used — zero listener rewiring. **Tails are honest-lossy** (owner-ratified with
  the condition that the durable record always survives): no accumulation, no
  replay, no refetch. A dropped tail chunk is gone; the `tool_result` / final
  messages ride the event lane and always arrive. Forcing tails into the offset
  model would have meant inventing an accumulation nothing reads.

### 3. Replay-on-subscribe is the self-heal

`stream:watch {sessionIds, automationRuns?}` — a capability-declared registry
QUERY with replace-set semantics, capped (32 per set), per-connection, dying
with the socket. Subscribing replays every watched stream as `offset: 0`
frames, **empty accumulations included** — a replay is a claim about the
session, not about its non-empty streams; omitting empty ones leaves a buffer
canonical cleared while unwatched uncorrectable (the phantom-thinking-span bug,
found in review round 1). Reconnect heals by re-watching; a mid-connection
offset/turnId mismatch heals by re-sending the same set. This is the
terminal-attach replay pattern generalized.

### 4. Subscriptions are read-class and per-connection (ADR-054 alignment)

Watching costs nothing against the step-up decay and never slides it; the 4010
max-age cut ends every watch with the socket. Automation tails are scoped by
`automationId` — the finest granularity the payload supports (it carries no run
id; the wire field name `automationRuns` is an honest misnomer, documented).

### 5. Backpressure drops, never blocks, and never touches the event lane

A connection whose socket buffers > 1MB has its stream-lane frames skipped —
text streams self-heal via the mismatch cure, tails lose by contract. The
event lane is never dropped: a missing event is a permanent hole in a
seq-ordered stream. (A PTY pauses its child under backpressure; a stream lane
cannot pause an LLM, so it drops.)

### 6. Git-watch: interest, not ownership

The collective-owner refcount workaround is retired for per-connection
`git:watch {cwds}` replace-sets whose union drives polling — a lost cleanup
message costs nothing because re-stating a set IS the correction. The wire
event stays a ringed broadcast (it was never the ring poison); the invariants
that survived the mobile-git-pill incident survive here: one `startPolling`
callback per cwd, and always-emit-first (cached status re-emitted to joiners
and re-staters).

### 7. Watched sessions: seeds are not events

`session:watch-update` shrinks to a notify `{routingId, sessionId, projectKey,
cwd?}`; the watcher's file re-read goes to canonical as a SEED
(`seedWatchedSession`, the REPLACE twin of `seedSession`) ordered BEFORE the
notify, and clients answer with one debounced refetch (150ms trailing, 500ms
max-wait, one-shot retry) through the cold-history path they already had.
`projectKey` rides the notify because it is `cwdToProjectKey`'s lossy output —
underivable client-side (the payload-additions rule).

### 8. Remote voice: the lane is bidirectional

The browser cannot produce the voice server's `linear16/16000/mono`
(MediaRecorder = opus/webm only — why the previous attempt was aborted), but
AudioWorklet + a pure, drift-free downsampler can. Upstream audio rides
per-connection `voice-audio` frames (bounded, silent-drop without an active
capture, NEVER logged — audio is keystrokes); `voice:start`/`voice:stop` are
audited commands; transcripts return TARGETED at the capturing connection —
the lane's third delivery rule (not watch-filtered, not broadcast, never
reaching plugin observers). Audio frames are deliberately not step-up-gated
per frame: authority is judged at the audited `voice:start`, and re-judging a
150ms batch would truncate a sentence mid-word — ADR-054's attached-stream
rationale. **`voice:*` declares `chat`, which widens the legacy token/tailnet
surface** — accepted because that surface already permits `session:send`,
which spends strictly more. `getUserMedia` requires a secure context: remote
voice works on the tailnet HTTPS origin, the same rule passkeys imposed.

### 9. Plugin parity is preserved, deliberately

ADR-005 plugins received every volatile channel as events; an in-process
observer list synthesizes the exact old emission shapes from lane frames
(gated on a plugin actually listening), so a lane change plugins have no part
in does not silently delete their token deltas.

## Consequences

- The phase-5 exit criterion holds and is pinned by e2e: a 10-minute
  backgrounded client reconnects into `sync-catchup`, never `sync-full`, no
  matter how noisy the turns were.
- The ring is now small and boring: domain events only.
- A client watching nothing still converges at message boundaries via the
  event lane — deltas are presentation, messages are truth.
- Two inherited production bugs were surfaced and fixed by the work: the
  watcher's post-await delete race (ghost session re-mint) and readline's
  unhandled-error throw on a reset voice socket (a live desktop bug).
- Real-device voice verification (phone mic, permission flow) remains
  owner-verifiable only.
