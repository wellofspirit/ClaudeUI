# Event-channel classification — as of SyncCore phase 4c (complete)

Part of [architecture/](README.md). **Status:** landed with SyncCore phase 4a, updated
by 4b (snapshot cutover) and 4c (uniform delivery, then reducer adoption). The
classification table is `CHANNEL_SPECS` in `src/core/shared/sync/channels.ts`, one row per
channel with its rationale; this file explains the classes and the rules and does not repeat
the rows. `sync-funnel-guard.test.ts` fails if any emitted channel — or any channel either
client subscribes to, on either surface — is missing from the table.

**The `Canonical` column is now load-bearing on BOTH sides.** Since 4c's reducer
adoption it decides not just whether `applyEvent` changes canonical state but whether a
channel has a client handler at all: `canonical: yes` ⇒ the renderer's replica folds it
and the field is SEALED (`renderer/src/stores/sealed-fields.ts`); `canonical: no` ⇒ there
is no snapshot field to fold into, so the channel keeps an explicit `onSyncEvent`
listener and a transient store writer, and a resync legitimately drops it. That is why
the per-channel subscription surface shrank from ~40 to the size of the non-canonical
set.

Companions: [sync-core.md](sync-core.md) (target design + phases),
[remote.md](remote.md) (as-built record), [security.md](security.md) (capabilities),
ADR-051.

## Why a classification exists

Before phase 4a there was no answer to "does this event replicate?" other than
reading the emitter: a channel reached remote clients iff it happened to ride
`BaseSession.send` or a hand-rolled `getExtraWindows()` loop (remote.md defect 5).
That made _forgetting_ the default — a new state-changing event would quietly be
desktop-only, and nothing failed.

The table inverts it. Every emission goes through `SyncCore.emit`, which refuses an
unclassified channel outright (**fail-closed**), so adding an event now forces the
decision. Two things record the consequences of that decision:

| Field         | Meaning                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Class**     | where the emission goes (below), and whether it enters the 5000-entry event ring a reconnecting client replays from: `replicated` ⇒ yes, anything else ⇒ no |
| **Canonical** | does `applyEvent` change canonical state? `no` means the payload has no field in `FullStateSnapshot` — a recorded gap, not a claim                          |

Ring membership was a column of its own until it was found to equal `class === replicated` on
every row; it is derived now (`ringsEvents`), for the reason given for `Delivery` below.

**The `Delivery` column is gone (4c).** It recorded a per-CALL-SITE target — `all` /
`extras-only` / `main-only` — because that is what delivery was: the desktop window was a
distinguished fan-out target, other clients had to masquerade as fake `BrowserWindow`
"extra sinks", and three call sites deliberately skipped the renderer they assumed already
knew. Delivery is now a function of the channel's **class** and nothing else:

- `host-local` ⇒ the owning `BrowserWindow` only, by targeted `webContents.send`;
- `volatile` ⇒ the STREAM LANE: only connections whose `stream:watch` set names the
  session — or, for the automation tail, the automation (§The stream lane);
- `replicated` ⇒ **every subscriber, always**.

A column that can only ever restate the class is a column that can only ever drift, so it
was deleted rather than pinned.

## Classes

- **`replicated`** — rings, fans out to every client, and (where the snapshot has a
  field) folds into canonical state. The default for anything that is state.
- **`volatile`** — streaming output that has LEFT the event system (phase 5). No
  ring, no seq, no cursor: it rides the stream lane and reaches only the
  connections that subscribed. Two flavors, recorded per row as `volatileFlavor`:
  - **`item-stream`** (`session:item-delta`, 2026-09-17) — item-addressed appends
    and explicit atomic active-set replay. One frame family,
    `ItemStreamFrame`: `op: 'append'` carries `{routingId, atSeq, target,
generation, offset, chunk}` for ONE addressed block; `op: 'replace'` carries
    `{routingId, atSeq, streams}`, the session's whole active set at once. The
    `target` is `{messageId, blockIndex, kind, ownerToolUseId?}`; the
    `generation` is the sequence of the reliable `session:item-open` that created
    the stream, so a frame can never conjure one; `atSeq` is a watermark the
    receiver must already have reached, and reading it never advances the
    receiver's own cursor. Canonical `itemStreams` / `itemStreamRevision` are
    snapshot fields, and the two reliable channels
    `session:item-open` / `session:item-seal` establish and retire the entries.
    Core and replicas share `item-stream.ts`. [Design](../per-item-streaming-design.md).
    This flavor replaced `text-stream` (`session:stream`,
    `session:subagent-stream`, an accumulating `{streamId, turnId, offset, chunk}`
    frame folded by `applyStreamFrame`), which was retired with its channels on
    2026-09-17 when the last engine migrated.
  - **`pass-through`** (S2: `session:bash-output`, `session:background-output`,
    `automation:stream-event`) — the emission `(channel, args)` verbatim in a
    `{type:'stream-ev'}` frame, dispatched client-side into the ordinary
    per-channel listeners. Not canonical, not accumulating, and HONEST-LOSSY: no
    replay and no refetch, because the durable record of what a tail previews is
    the event lane's `session:tool-result` / `automation:run-message`.

  See §The stream lane.

- **`host-local`** — the owning desktop window only: window chrome, native pickers,
  voice capture, OAuth browser flows, PTY bytes, the log-viewer window.

## The rules, and which one 4c retired

1. ~~**Never reduce ring membership.**~~ **Retired by phase 5** — by the migration it
   always named. S1 moved `session:stream` and `session:subagent-stream` (both deleted
   on 2026-09-17, their place on the lane taken by `session:item-delta`); S2 moved the
   three tails and with them the last member of the interim `volatile-pending-phase-5`
   class, which is now DELETED rather than left as an empty option. All four channels on
   the lane today are class
   `volatile`: `ring: no`, and their payloads are not events at all. The rule's stated cost
   (breaking catchup for clients mid-reconnect across the upgrade) was **waived by the
   owner**: there is no dual-emission lane and no compatibility shim, because the desktop
   and web bundles ship with the server. A cached older bundle sees a session whose text
   updates only at message boundaries and no live bash tail — never a broken transcript.
2. ~~**Never widen delivery.**~~ **Retired by 4c**, deliberately and in a bounded way. 4a
   bound itself to today's targets so the funnel could be reviewed as a pure refactor; 4c's
   whole purpose was to delete the privilege those targets encoded. The classes did not
   move — `auth:state`, `account:changed`, `plugin:views-changed` and friends are still
   `host-local`, and promoting one is still a deliberate step behind the `admin`/`host`
   capabilities. What changed is that a CALL SITE can no longer pick a narrower target than
   its channel's class. The two visible consequences are named below.

Consequence worth stating plainly: several rows read `replicated / canonical: no`.
Those channels reach every client live but are absent from the snapshot, so a
resync drops them. That is the as-built behavior, faithfully preserved. **4b did not
change it** — the cutover changed WHERE the snapshot comes from, not which fields
`FullStateSnapshot` has, so a channel with no snapshot field still vanishes on resync
(errors, warnings, git summaries, usage, automation). Each of those belongs to its own
surface's phase; `session:directories-changed` is the one 4b did close, by making core
maintain the listing the notify tells clients to refetch.

**The catchup leak is dead (4c).** 4a recorded this wrinkle: ring membership is per
CHANNEL but delivery was per CALL SITE, so two `main-only` sites rode channels that ring
(`auth-manager`'s `session:auth-source`, the desktop mockup watcher's
`mockup:file-changed`) — their events never reached a remote client LIVE but did reach one
replaying a catchup after reconnect. A client's state therefore depended on whether it had
disconnected. Uniform delivery closes it: both now reach every subscriber live, which is
what the ring was already going to replay. Both payloads are benign (an auth-banner state,
a mockup-reload notify), which is why widening them was the right fix rather than adding
per-site ring flags.

**The other 4c visibility change.** The three `extras-only` sites — `create-session`'s
`notifyMainWindow=false`, the desktop `config:settings-changed` / `config:sessions-changed`
saves, and the pre-spawn `session:permission-mode` echo (since DELETED — see that
channel's row) — now echo back to the client that originated them. Every one of those payloads is a REPLACE, so the echo is idempotent for
the writer; what it buys is that the one client whose optimistic write might be wrong is no
longer the only one the broadcast cannot correct.

## Delivery delta — the sanctioned 4a visibility changes

| Channel                  | Change                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session:config-changed` | NEW channel (sanctioned 4a addition). model / effort / thinkingMode / reasoningVariant picks were previously invisible to other clients (remote.md defect 1); they now replicate as a partial, per-field replace. |
| `session:metering`       | Delivery UNCHANGED. The 4a change is a snapshot FIELD (PerSessionSnapshot.metering) — before it, every resync silently dropped metering.                                                                          |

4c's own visibility changes are the two structural ones described above (the catchup leak
and the `extras-only` echoes), not per-channel additions, so they are recorded in prose
rather than in this table — and `sync-funnel-guard.test.ts` still pins the table to exactly
these two rows.

Nothing else in the table changes what any client can see. `session:metering`'s
delta is a **snapshot field**, not a delivery change: `PerSessionSnapshot.metering`
did not exist, so every resync silently blanked the TopBar breakdown.

The `Delta` column tracks DELIVERY only, and `sync-funnel-guard.test.ts` asserts it
holds exactly those two rows — which is why the payload additions below are
recorded in the Notes column instead of flipping it.

## Payload additions — the only wire changes since the cutover

Five entries, one rule: a value only the emitter knows must ride the event, or every
non-originating replica invents it. The first two landed in 4b (the cutover's own wire
changes); the last three are post-4 fixes, kept in the same table because the rule that
justifies them is the same one. Phase 5 S4 extended the `session:watch-update` row by the
same rule and REMOVED its transcript in the same change — a payload can grow by what only
the emitter knows and shrink by what a client can fetch for itself.

| Channel                       | Addition                                                                                              | Why it could not stay client-side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session:user-message`        | `{id, timestamp}` (4b)                                                                                | Minted by `sendPrompt`. Each client used to invent its own `msg-<uuid>`/`Date.now()`, so one user turn had a different id in every replica and canonical could only mint a positional `user-<seq>`. With the snapshot authoritative, that renumbers a client's transcript on every resync.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `session:message`             | `thinkingDurationMs?` (4b)                                                                            | Timed by `BaseSession.send` (one implementation, all three engines) and moved onto the sealed thinking block by the reducer. `applyEvent` is clock-free by contract, so elapsed time can only come from the process that watched the clock. **No producer stamps it since 2026-09-17:** `BaseSession`'s thinking-span clock was deleted with the legacy lane and each adapter now puts `durationMs` on the thinking block itself. The field and the reducer's move are kept so an older payload still lands correctly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session:created`             | `{permissionMode?, engineId?, model?, resumeSessionAt?, effort?, thinkingMode?, createdBy?}` (post-4) | **The BIRTH CONFIG, plus the fork anchor.** The payload was `{cwd, resumeSessionId}`, so the reducer built the entry from `emptySession()` — `permissionMode: 'default'`, `selectedEngineId: 'claude'`, `selectedModel: 'default'` — and only the ORIGINATOR was right, because its own `createNewSession` seeds the replica before the event arrives. Every other client, and canonical itself (hence every snapshot and every resync), showed the wrong mode/engine/model until some later event happened to carry the real value: a session created on the desktop read as `default`/claude on a phone, and vice versa. `resumeSessionAt` is the same problem one layer down: a branched session spawns with `--resume <parent> --fork-session --resume-session-at <lineUuid>` and cli.js resumes from `lines.slice(0, w+1)`, but every reader of that transcript (canonical's seed in `create-session.ts`, and each client's own cold seed in `useClaudeEvents`) loaded the parent's WHOLE file — so a fork opened showing the turns it exists to discard, above a model that had never seen them. Only `prepareAndCreateSession` knows any of these values at birth: the spawn opts (with the RESOLVED model, and the anchor) it just handed `manager.create`. Every field is optional and the reducer falls back to the existing session value, so an old-shape event (a committed golden fixture, catchup from an older host) folds exactly as before; an absent anchor means "load everything", which is also the non-fork case, and an anchor not present in the file truncates nothing. `effort` / `thinkingMode` ride the event only when the spawning client sent an `announce` (an old client omits it, so its event carries neither), and then `thinkingMode` is always present (the client's raw pick, `null` clearing) and `effort` is present unless the client does not know the model (empty or failed catalog — omitted, so nothing is wiped): the POSITIONAL effort the host spawned the process with (so a replica shows what runs), or `null` for a model known to take none. Freezing the starting effort into the session is the intent: canonical `effort` is null only before a session's first spawn, while the per-model starting effort (Claude and pi; replicated `modelEffortDefaults` / `engineEffortDefaults`) still applies; a later change to that value must not re-label a session already running at the old one. The freeze lasts for the host run — canonical `effort` is not persisted, so a resumed session after a host restart re-resolves against the current per-model value. `createdBy: 'agent'` (session tools, slice 1c) is present only on a session another session's tool started: it is not folded into canonical, it tells every client NOT to follow the new session whatever its follow setting says (the user did not ask for it); absent, as for every session before it, clients react as they always did. |
| `session:watch-update`        | `cwd?` (post-4), then `{sessionId, projectKey}` (S4) — **the whole payload**                          | The watched session's working directory, and since phase 5 S4 the ADDRESS of its transcript — which is now everything the event carries. This event is the ONLY thing that introduces a watched session — nothing spawns, so there is no `session:created` — which is why its reducer branch is the one place `ensured()` still bootstraps an entry. Without the cwd that entry was born with `cwd: ''` and every cwd-keyed feature missed it (git status, sidebar/notification folder name, the per-cwd terminal group, `deleteProject`'s live-session sweep). None of the three is derivable by a client: `projectKey` is `cwdToProjectKey`'s lossy, irreversible output, and `sessionId` need not equal the routing id (`watchSession` takes them separately). The transcript went the other way — out of the payload entirely, into `SyncCore.seedWatchedSession`, because a full re-read per file change is what put hundreds of transcripts in the ring. The `messages` / `taskNotifications` / `statusLine` fields survive as OLD-shape only: the reducer still folds a payload that carries them (committed fixtures, a ring caught up across the upgrade), and nothing emits them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session:directories-changed` | the merged listing (post-4)                                                                           | Was payload-less: a "refetch now" every client answered with its OWN three-query merge (claude + opencode + pi), while canonical held only `listDirectories()`. Two different lists, not two views of one — so every `sync-full` force-projected the claude-only subset over the merged one and a reconnecting client lost its opencode/pi rows until its next 30 s poll. Main owns both other list sources, so it does the merge and the event carries the result. Absent folds as the old no-op notify (committed fixtures, catchup across the upgrade). Rate-limited at the emitter — see the row in the main table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`FullStateSnapshot` itself is UNCHANGED by 4b: the cutover moved where the snapshot
comes from, not what it contains, so the web client works unmodified. The
`session:created` addition does not change it either — the fields it carries are
snapshot fields that already existed.

### Image and document payloads are refs (ADR-087)

Not a row, because it is not one channel's payload: it is every place a transcript can
hold an image. `session:tool-result` and `session:subagent-tool-result` (`images[]`),
`session:user-message` and `session:queue-changed` (`attachments[]`), and the `image` /
`document` content blocks inside `session:message`, the subagent message channels and every
history load carry a `BlobRef` `{blobId, bytes}` where they used to carry `base64Data`. The
`blobId` is the SHA-256 of the decoded bytes, so one screenshot arriving from a live event, a
transcript re-read and a subagent file is one entry in the host's in-memory, LRU-bounded
`BlobStore`. This is the shrinking half of the rule above — a payload can lose what a client
can fetch for itself — and it is what makes the ring's entry-count bound a real one: before,
5000 entries could each carry a megabyte, and a snapshot (all of canonical state) carried every
image in every session.

The producers intern, not the reducer: the shared tool-result decoder, each engine's mapper,
the history readers and `sendPrompt` hand the store the bytes and put the ref on the event. The
reducer only moves ids, and no non-test file under `core/shared/sync/` may name `base64Data`
(`no-inline-bytes.unit.test.ts`). `base64Data` survives on an UPLOAD — `AttachmentUpload`, the
`session:send` argument an engine needs — which is an invoke argument and never ringed; a queued
prompt keeps its upload beside the item inside `SessionQueue`, and the broadcast item carries
refs only.

The fetch is **`blob:get`**, a `chat` query returning `{mediaType, base64Data} | null`. It is an
invoke on the WebSocket/IPC lane and deliberately NOT an HTTP route like `/sent-file`: on an E2E
origin the bytes stay inside the encrypted channel, as they were inside the snapshot, and a
screenshot of the operator's screen is conversation content rather than a deliberately delivered
artifact. `null` is a legal answer (an LRU-evicted or unknown id) that clients render as "image
unavailable"; the client-side cache remembers it for 60 s, not forever, because the host re-interns
a blob whenever a transcript containing it is read again. A fetch that FAILS (socket down, timeout)
is not "unavailable" — nothing was learned about the blob — so the image stays in its loading
state and is retried with backoff (2 s doubling to 30 s) for as long as it is on screen. See
[security.md](security.md) for the capability reasoning.

### An exited session's transcript is not in the snapshot (ADR-087 §2)

`PerSessionSnapshot.seeded?: boolean` is the one field the snapshot gained since 4b. `false`
means "this entry does not carry its transcript — `messages` and `subagentMessages` are empty
because the host dropped them, so read them from disk"; absent means complete, which is also
what a host that predates the field means. `toSnapshot` emits it for EVERY unseeded session —
one rule, "canonical does not hold this transcript" — which covers a dropped transcript and a
resume whose history read is still in flight. Omitting the second would hand a client that syncs
inside that window an empty transcript marked complete, with no `session:created` coming to fix
it. The client tells the two apart by `sdkActive`. The reasons and the client's half are in
§Eviction below.

## The table

The rows are in `src/core/shared/sync/channels.ts` and nowhere else: two object literals, the sync
table (replicated and volatile channels) and the host-local table, merged into `CHANNEL_SPECS`. Each
row gives the class, whether `applyEvent` folds it (`canonical`), the sanctioned visibility change if
any (`deliveryDelta`) and the reason (`why`). Whether a channel rings is not a column: it rings iff
its class is `replicated` (`ringsEvents`).

There is no copy of the rows on this page. A copy kept by hand drifts, and a generated one would
need a generator and a check to restate what the source already says in full. Three things hold the
source together that a copy cannot.

- The sync table's keys must equal the keys of the typed event map (`EmitEventMap` in
  `src/core/shared/sync/events.ts`), checked by the compiler in both directions.
- The reducer's handler set must equal the `canonical` rows of the event lane
  (`src/core/shared/sync/__tests__/reducer-coverage.unit.test.ts`).
- `SyncCore.emit` refuses a channel with no row, and `sync-funnel-guard.test.ts` scans the tree for
  an emitted or subscribed channel that has none.

`plugin:<id>:<event>` (ADR-005) is matched by PREFIX, since the names are generated
at runtime: `host-local`, no ring, owning-window only. Plugin-declared capabilities
are the follow-up that decides whether plugin surfaces may replicate. The plugin bridge
itself is a plain funnel SUBSCRIBER as of 4c (the fake `BrowserWindow` it used to be is
deleted); the event SET it receives is unchanged. **Phase 5 kept that true across the lane
split:** the `volatile` channels stopped being events, so a sync subscriber no longer
sees them — the bridge registers an in-process stream OBSERVER instead
(`addStreamObserver`, unfiltered, since a plugin has no session selection to filter by) and
re-materializes each frame in the way its flavor calls for: a `pass-through` frame by
reading `(channel, args)` straight back off it (it never stopped being the emission), and
an `item-stream` append by SYNTHESIS.

**The synthesis, as of 2026-09-17.** `session:stream` and `session:subagent-stream` no
longer have a producer, but plugins written against them keep working: an append frame
for a ROOT text/thinking block fires `session:stream` and one for a child's fires
`session:subagent-stream`, each carrying only the new chunk exactly as before. A `plan`
block synthesizes neither, because the old channels never carried plans. At every `session:item-seal` the bridge
fires `session:message` / `session:subagent-message` with the message read back from
canonical state and overlaid with any still-active sibling block. Plugins can also
subscribe to the three item channels directly and get per-block identity.

Nothing reaches a plugin that has not subscribed, and the syntheses that would have to
READ canonical state are skipped BEFORE that read when nobody is listening
(`hasListeners(channel)`) — so a machine with no plugins pays nothing for the token
firehose, which is every machine by default. A pass-through frame
names its own channel and is gated the same way, so a plugin listening only to
`session:bash-output` never pays for the automation tail.

## The stream lane (phase 5 S1 + S2)

Two lanes now leave the funnel, a channel's CLASS picks which, and — on the stream lane —
its FLAVOR picks what a frame means.

The **event lane** is unchanged: ring → canonical → every subscriber,
`{seq, channel, args}`, cursor and catchup as before.

The **stream lane** carries the four `volatile` channels and nothing else. The
`item-stream` flavor (2026-09-17, replacing S1's `text-stream`) carries one frame type
in two operations:

```
{ type: 'item-stream', op: 'append',  routingId, atSeq, target, generation, offset, chunk }
{ type: 'item-stream', op: 'replace', routingId, atSeq, streams }
```

- **`target`** — `{messageId, blockIndex, kind, ownerToolUseId?}`, where `kind` is
  `text`, `thinking` or `plan` and `blockIndex` is the slot inside that message. Its map
  key is a JSON tuple (`itemStreamKey`), so two opaque native ids cannot collide through
  a separator the way the old `<routingId>/sub/<toolUseId>/text` scheme could. One module
  (`src/core/shared/sync/item-stream.ts`) owns the types, the validators and both folds;
  the server, both clients and the tests import the same one.
- **`generation`** — the `seq` of the reliable `session:item-open` that created the
  stream. A frame whose generation does not match the receiver's active entry is
  discarded, and a frame for a stream that was never opened cannot create one. That is
  the property that keeps a late delta from resurrecting a sealed item; the old
  `turnId` was a bumped counter with no reliable event behind it.
- **`offset`** — the accumulated length (JS string units, so UTF-16 throughout) of that
  item BEFORE this chunk. A frame whose offset does not match the receiver's local length
  is a NO-OP that signals `mismatch`: applying it anyway would silently corrupt the text.
- **`atSeq`** — the reliable-event watermark the frame was captured at. A receiver folds
  it only once it has applied events through that seq, and reading the watermark never
  ADVANCES the receiver's own cursor. Volatile traffic therefore cannot acknowledge an
  event the client has not seen.
- **`op: 'replace'`** — the watch replay: the session's entire active set, empty included,
  in one frame (`SyncCore.itemStreamReplay`). It replaces values, never lifecycle — every
  stream it names must already be open at the same generation, or the whole frame is a
  mismatch.
- **In-process observers** (`addStreamObserver`) see every frame with no watch set, and
  are a SEPARATE list from the connection-keyed subscribers. An observer has no session
  selection, no socket to die with and no capability to check; giving one a synthetic
  connection id would make every `stream:watch` bound reason about entries no client owns.
  The one production consumer is the plugin bridge.
- **Never logged.** Same rule as `term-data` ([security.md](security.md) §Audit). On a
  tunnel these are ordinary server→client frames and ride the existing encrypt path.

### The pass-through flavor — the tails (S2)

The three tails flooded the ring exactly as the deltas did (a `bun run build` inside a Bash
tool call emits a chunk per poll), but they are not text-offset streams: they carry
counters and objects, replace rather than accumulate, and have no canonical field to
accumulate into. Forcing them into the frame above would mean inventing an accumulation
nothing reads. So they ride the lane verbatim:

```
{ type: 'stream-ev', channel, args }
```

- Same delivery path: per-connection watch filter, never ringed, never logged, encrypted
  on tunnels like every frame.
- The client dispatches it into the **same per-channel listener registry the event lane
  uses**, so every existing `onSyncEvent('session:bash-output', …)` listener keeps working
  unchanged. That is the point of the flavor: the transport moved, the meaning did not, and
  there is no second interpretation of the payload to drift.
- **Honest-lossy.** No offset ⇒ no replay, no refetch. A chunk missed (pre-ready, dropped
  under backpressure, or emitted while nobody was watching) is simply gone. That is safe
  because a tail is a PREVIEW: the durable record is the event lane's
  `session:tool-result` / `automation:run-message`, which rings, replicates and replays.
- **Scope.** The two session tails are session-scoped by position (`args[0] = routingId`)
  and ride the `sessionIds` set. `automation:stream-event` rides a second set,
  `automationRuns`, whose entries are **automation ids, not run ids** — the emission
  carries `{automationId, type, text}` and no run identity, so run-level scoping would have
  to be invented at the boundary. The renderer already narrows to the run it is viewing
  from its own store (`useAutomationEvents`'s `viewingLiveStream`), which still works
  because every frame is delivered verbatim. Recorded here as the coarser granularity it
  is.

### Backpressure (S2)

At the WebSocket sink, a connection whose `ws.bufferedAmount` exceeds
`STREAM_BACKPRESSURE_BYTES` (1 MB — the same high-water mark the remote PTY uses) has its
stream frames **SKIPPED** until it drains, with one log line per congestion episode rather
than per frame. The PTY answers the same measurement by pausing the child; a stream lane
cannot pause an LLM, so it drops. Both flavors recover by design — a tail is lossy by
contract, and a dropped item frame puts its session id in a per-connection pending set
that a single coalesced timer drains with a fresh `replace` replay (100 ms doubling to a
2 s ceiling, reset on success, cancelled on unwatch or disconnect). That retry exists
because an item can idle for minutes waiting on a tool, so waiting for the next token to
expose the gap is not a recovery path — and **the event lane is never
dropped**, because a missing event is a permanent hole in a seq-ordered stream. The desktop
`MessagePort` sink is exempt: there is no socket, no `bufferedAmount` and no network, so
the condition cannot arise.

**`stream:watch` is the subscription.** A registry QUERY (`chat`, unaudited — a
subscription toggle has no domain effect), payload
`{ sessionIds: string[], automationRuns?: string[] }`, **REPLACE**
semantics per set, each capped at 32 (`MAX_STREAM_WATCH`; an over-long set is refused, not
clipped — a clipped set would leave the client believing it watches sessions it does not).
`automationRuns` is replaced independently and its ABSENCE is silence, not a clear, so one
surface can state its scope without erasing the other's; `[]` is how a client stops
watching. The set
is per CONNECTION and dies with the socket, which keeps a subscription inside the same
lifetime as every other authority that connection holds — ADR-054's 4010 max-age cut ends
it because the cut closes the socket. It classifies `read`, so it is free on every tier
and **refreshes nothing**: the watch effect re-fires on every reconnect and every session
switch, so a refreshing read would let an idle tab renew its own step-up window forever
(the `terminal:pool` rule, generalised).

**Replay-on-subscribe is the self-heal** — the same shape `terminal:attach`'s
`replay: true` uses for a PTY. On watch, the server immediately pushes ONE `op: 'replace'`
frame per watched session carrying that session's whole active item set — **including the
EMPTY set** — stamped with the ring watermark it was read at. A set replacement is not an
append at a special offset: it removes active entries the client should no longer hold and
restores the current ones and their values in the same application, which is the only
honest answer for a set whose membership changes.

**Why the empty set is not noise.** A replay is a claim about the SESSION, not about the
items that happen to be active in it. Omitting the empty case leaves a client holding a
preview canonical had already retired, uncorrectable by re-watching, and that is reachable
by ordinary use: watch a session mid-thinking-span, switch away, the span seals on
canonical, switch back — the replica keeps a phantom thinking block with a ticker that
never stops. S1 answered this with a per-buffer `offset: 0` frame ordered text-before-
thinking; a dynamic item set cannot be reconciled that way, which is why the replay became
atomic. Replay never resurrects: every stream it names must already be open at the same
generation, or the whole frame is a mismatch.

A client cures a mid-connection mismatch by re-sending the same watch set; a client that
reconnects re-watches, because subscriptions are per-connection. There is no third
recovery path, and no cursor to repair.

**Sessions nobody watches still converge**, at message boundaries, over the event lane —
the reliable seal carries the resolved final content, so the answer always arrives. Only the
token-by-token animation is subscription-scoped. That is the design, not a gap. A TAIL
nobody watches does not converge at all — there is nothing to converge to — and that too is
the design: the tool_result completes the transcript either way.

**One interpretation, both sides.** `applyItemStreamFrame` is to the item-stream flavor
what `applyEvent` is to the event lane: core folds it against canonical,
`renderer/src/stores/replica.ts` folds it against the replica, and `itemStreams` /
`itemStreamRevision` stay SEALED. `applyEvent` refuses a `volatile` channel outright rather
than keeping a reducer fossil that could race the lane. A
pass-through frame has nothing to fold: it is dispatched, not applied, which is why the
three tails KEEP their `SyncEventMap` entries while `session:item-delta` has none — its two
reliable siblings, `session:item-open` and `session:item-seal`, are ordinary events and do.

**In-process consumers keep their pre-split contract.** The ADR-005 plugin bridge and the
engine tests' stub window subscribed to every volatile channel before the split. They
receive them from the observer list instead: a pass-through frame by reading
`(channel, args)` straight back off it, an item append by the synthesis described above.

### Remote voice — the lane's TARGETED delivery (S3)

> **ADR-101:** opencode and pi sessions use the same relay and the same protocol: their
> `voiceStartServer()` returns the host's on-device voice worker (`core/voice/local-voice-server.ts`)
> instead of cli.js's server, plus a per-spawn token in `startFields`. `voice:error` gained an
> optional 4th argument, the notice ACTION (`install-voice-pack` when the speech pack is missing),
> carried as data on both owners' deliveries like the tone.

Voice input is not host-only any more: headless mode has no microphone, and the owner's
answer to "I want to do voice input remotely" is a browser capture. The audio path is
`AudioWorklet → shared/audio/pcm16.ts → the voice-audio frame → core/services/voice-relay.ts
→ the cli.js voice server`. (The desktop window has since moved onto the same capture code;
its audio rides a `voice:audio` IPC message into the same relay, and its state and
transcripts are the host-local channels above.) What matters HERE is the return path, which
is a third delivery rule on the same lane:

- `streamDelivery` asks **who is looking at this session** (the `stream:watch` sets);
- `sendToStreamConnection` asks **who is holding this microphone**, and delivers to that ONE
  connection.

They are different questions, and the watch sets answer the wrong one for a capture: a phone
and a laptop watching the same session would BOTH receive the phone's interim transcripts and
both type them into their own drafts, and the recording indicator would light up on a client
whose microphone is off. Transcripts belong to the socket that produced them, exactly as PTY
bytes belong to the socket that attached.

So a remote capture's `voice:state` / `voice:transcript` / `voice:error` are **targeted
pass-through frames**, not emissions: they never reach `emitEvent`, never take a seq, never
ring, and are never logged (audio and its transcript are keystrokes — security.md §Audit).
The client cannot tell the difference, because a `stream-ev` frame is dispatched into the
same per-channel listeners a host-local `webContents.send` feeds — which is why the renderer
needed no rewiring at all and the mic button drives both paths.

The CONTROL verbs are ordinary registry commands and ARE audited: `voice:start
{sessionId, language?}` and `voice:stop`, both `chat`/`command`/`withConnection`. Who opened a
microphone on which session, and when, is a security fact; what was said is not. **One capture
per connection** (starting a second stops the first — a browser has one microphone), and the
capture dies with whatever it depends on: an explicit stop, the socket closing (which is how
ADR-054's 4010 max-age cut ends it), or the engine dying, which closes the TCP socket to the
voice server living inside it.

## Reducer purity deltas

`applyEvent` is pure — no clock, no randomness (`reducer.unit.test.ts` spies on
`Date.now`/`Math.random` to prove it). A reducer that read wall-clock time would
fold a different state on every replay, so replay-equals-live would be false and
catchup could not be trusted. Two as-built consequences followed from that; **4b
closed both by moving the impure part into the emitter**, the only place it can
honestly live, and **4c deleted the renderer's mirrors of both**:

| Divergence                      | Why it existed                                                                                                                                 | Closed in 4b by                                                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking-block `durationMs`     | the renderer measured it with wall-clock deltas; core tracks only "is a span open"                                                             | `BaseSession.send` times the span and stamps `ChatMessage.thinkingDurationMs` on the sealing message; the reducer moves it onto the block. **Since 2026-09-17** each adapter times its own span and stamps `durationMs` directly on the thinking block it seals |
| User-message `id` / `timestamp` | `session:user-message` carried `{prompt, attachments}` only, so the renderer minted `msg-<uuid>`/`Date.now()` and core minted `user-<seq>`/`0` | `sendPrompt` mints both into the payload; the reducer prefers them, keeping the positional fallback for old-shape events                                                                                                                                        |

**Both masks are gone (4c).** They were not leftovers: the desktop renderer kept
measuring its own duration and minting its own user id, so the two sides genuinely
differed — by scheduling jitter, and by construction. With the renderer folding the
shared reducer there is one value from one event, so
`e2e/flows/sync-hydration-parity.e2e.test.ts` compares transcripts unnormalized and
the shadow comparator that needed the masks is deleted.

4c also fixed the emitter bug the mirror had been hiding: `trackThinkingSpan`
cleared only the OPEN clock at a turn boundary, never an already-parked
`sealedThinkingMs`, so a span sealed by a text delta whose message never arrived
(interrupt, retraction, engine death) leaked its elapsed time onto the NEXT turn's
first thinking block. The renderer's `pendingThinkingDurationMs` leaked the same
value the same way, which is exactly why the comparator stayed quiet about it.

## Client-written state — what is left of it (4c)

This section used to name three rows of snapshot fields that **client actions**
wrote, so canonical could not match them at an arbitrary instant, and both shadow
flows skipped them through one shared definition (`CLIENT_WRITTEN_FIELDS`, in a
shadow-comparison module). That module, that set and the comparator are **deleted**:
the renderer folds the shared reducer now, so its store IS the projection of
canonical and there is no second interpretation to diff.

What each row became:

| Field                                                                                                        | Then                                                             | Now                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeSessionId`                                                                                            | client-written, never reached core                               | unchanged and correct: selection is per-client VIEW state (ADR-041). Core serves `null`; each client resolves its own — see below.                                                                                                                                                                                                                                                                                    |
| `recentSessionIds`, `pinnedSessionIds`, `customTitles`, `hiddenSessions`, `hiddenProjects`, `sessionEngines` | store actions wrote them, then saved `sessions.json`             | SEALED. The action applies the change **through the replica** and persists through `config:save-sessions`, whose `config:sessions-changed` echo reaches every client including the saver. The local apply stays deliberately (`saveSessionConfig` merges from current state, so two rapid mutations would otherwise both merge from a stale base) — recorded as the one 4c deviation in [sync-core.md](sync-core.md). |
| `worktreeInfoMap`                                                                                            | `useClaudeEvents` **parsed a tool_result** and stored the result | moved to the MAIN process (`services/worktree-detect.ts`, observed at the funnel's delivery point) and persisted through that same save path. The sharp one is closed: no client derives state from a tool result any more.                                                                                                                                                                                           |

The registry-config row is fresher than it reads: the apply happens inside
`SyncCore.emit` on every save, so a desktop-originated save is already in the next
`getSnapshot()` (pinned by `handlers-core.test.ts`). The file watcher is now just the
cross-INSTANCE path.

**`directories` LEFT this table in 4b — and only became TRUE later.** 4b made core
maintain a listing, but it maintained the WRONG one: `listDirectories()` is Claude's
JSONL walk, while every client ran its own three-query merge (claude + opencode + pi)
in `Sidebar.tsx` and wrote the result locally. Canonical's copy was therefore a strict
SUBSET, and `hydrateReplica` force-projects, so every `sync-full` overwrote a client's
merged sidebar with the claude-only one and the opencode/pi rows vanished until that
client's next 30 s poll. That was structural and permanent, not drift.

It is core-written now in the sense the sentence always claimed: the merge itself moved
to main (`services/sync-seed.ts` → `listAllDirectories`, over the shared pure helpers in
`shared/directory-merge.ts`), the poll moved with it (`startProjectsWatcher`), the
`session:list-directories` query returns the same merged value, and
`session:directories-changed` CARRIES the listing so live clients fold it instead of
each refetching. The client-side merge, the 30 s interval and the `setDirectories`
store action are deleted. A mismatch here is now real drift.

### `activeSessionId` is served as `null` — deliberate, with a UX consequence

Core has no opinion about which session is "active": a host-wide selection is not
something a shared state can have (ADR-041). `toSnapshot` therefore always emits `null`,
and `applyRemoteSnapshot` resolves the selection locally — this client's own selection on
a re-sync, else the server's if an older host still sends one, else the most recent
session the snapshot knows about.

The delta a phone user feels: **a fresh connection no longer lands on whatever session
the desktop happens to be looking at.** It lands on the most recent session instead (and
on the welcome screen when there are none). That is the honest behavior for one operator
with many devices — the previous one silently overwrote a phone's navigation with the
desktop's on every resync — and the `recentSessionIds` fallback is what keeps it from
being a blank screen.

## Eviction, and the removal that is not eviction

Canonical evicts, but not on a timer and not through the reducer (ADR-087 §2). When a
session has no live engine, `SyncCore.evictTranscript` drops its `messages`,
`subagentMessages` and item streams and clears `seeded`, KEEPING the row and every light
field (status, config, metering, todos, sentFiles, queue, tasks) — the host-side mirror of
the client's `evictLocalSessions` (stores/replica.ts), which strips the same heavy arrays
and marks the entry `seeded: false` so reselection re-hydrates from disk. Without it
canonical held every transcript for the life of the process, so a snapshot grew with host
uptime, worst on a headless server.

**The rule.** Evict iff `sdkActive === false` and `status.state !== 'running'` — a live
engine is still folding events into the transcript. Two triggers, both host-side:

- **Engine exit.** Inside `SyncCore.process`, after a `session:status` whose state is
  `disconnected`, under the POST-rekey id. Claude and opencode report exit that way,
  and the funnel is the one place that sees every one. pi reports an unexpected process
  death as `disconnected` too, but its own stop (`cancel()` / dispose) reports `idle` and
  leaves canonical's `sdkActive` true — so a pi session the user stopped is not evicted by
  this trigger. That is pi's existing status contract, not something eviction changes.
- **A watch stops.** `session-watcher.ts` evicts when a watch entry is actually dropped
  (`unwatchSession`, and the dead-watcher drop on an `fs.watch` error). A watched session
  spawns nothing, so once nobody watches it nothing holds it on the host.

A session whose transcript is already empty (spawned, never prompted, then exited) is left
alone: it has nothing to drop, and marking it unseeded would tell a fresh client to read a
conversation from disk that does not exist.

**It is a cache decision, not an event.** A ringed `transcript-evicted` would strip every
replica, including one showing the session, which would then refetch what it was already
displaying. Eviction is a direct canonical write: nothing rings, nothing is delivered, and
a connected replica keeps the transcript it already folded. Only a client that syncs from
scratch is told, by `seeded: false` in its snapshot.

**What the client does with `seeded: false`** (`hydrateReplica`):

- A session with `seeded: false` and `sdkActive: false` that is NOT the one on screen
  arrives empty and the store marks it `evicted` and `isHistorical` — the same view flag a
  locally cold-evicted session carries, which is what makes the sidebar click
  (`handleClickSession` takes its resident fast path unless `evicted`) reload from disk. A
  click on an evicted entry that is idle loads in replace mode (strip and fill), so a
  stale tail cannot survive it. A click on a LIVE evicted entry reads nothing: it opens the
  entry, which the live fold and the client fill own (a load there would stamp it
  historical, emptying the agent roster and hiding running state).
- A session with `seeded: false` and `sdkActive: true` is a resume whose history read had
  not landed when the snapshot was taken. It is NOT marked evicted; instead the client fills
  it the way a follower of a resume does (`loadResumedTranscript`, shared with the
  `session:created` observer: `loadSessionHistory` + the fill-only `seedColdSession`, no view
  patch). If live events already folded into the entry the fill refuses, and because a
  hydrate-filled entry was never marked evicted it stays a tail until the next resync
  heals it (the observer path differs: its entry keeps `evicted`, and the next idle click
  replaces it — see below). A forked resume's anchor is not in the snapshot, and
  a fork's temporary id is not in the directory listing, so such a session is not filled.
- Conversely, a session the snapshot says is live and carried has `evicted` cleared, so a
  `session:created` missed in a gap cannot leave the flag on a running session.
- The session on screen after a RESYNC keeps its local transcript under the snapshot's
  light fields, so the chat does not blank. After every hydrate (fresh or resync), if the
  active session's transcript was not carried, `reloadActiveTranscript`
  (`lib/session-history-load.ts`) reads it from disk and REPLACES — strip and fill in one
  synchronous step, so no empty frame is painted. The per-engine load is the one the sidebar
  click uses (`loadSessionIntoStore`). A session absent from the replicated `directories`,
  a read that fails, an empty read over a held transcript, and a session that went live or
  stopped being the active one while the read was in flight all leave the view as it is —
  and, unless the session went live, mark it evicted, so the transcript the resync kept on
  screen is reloaded by the next click instead of being shown as complete forever.
- While the active entry is `evicted` and empty, `ChatPanel` shows a loading state, never
  `WelcomeState`, and the chat header is named from the same listing the sidebar row is.
  When the reload bails because the session is not listed or the read failed, the entry is
  flagged (`transcriptLoadFailed`, per-client view state beside `evicted`, cleared by any
  load that lands) and the spinner becomes "Couldn't load this conversation — Retry", which
  re-runs the reload.
- Every lazy spawn treats an `evicted` (or `isHistorical`) entry as having a transcript to
  resume (`hasResumableTranscript`), so a prompt typed before the read lands, or after it
  failed, continues the conversation rather than starting a new one. A spawn from an
  evicted, empty entry first waits for the reload still in flight
  (`awaitReloadBeforeSpawn`): the host seeds its own transcript as soon as the engine
  spawns, and a client read that is still open would then lose the race and show only the
  new turn.
- When the client's fill of a LIVE entry that WAS evicted (the `session:created` observer
  path) is refused (live events already folded in, so the entry holds a tail), the entry
  keeps its evicted flag and reads as unseeded rather than
  complete: it still shows the tail, and the next click once it is idle replaces it from
  disk. The same holds for a prompt sent on an evicted entry whose reload has already
  FAILED — nothing is in flight to wait for, so it can still race the host's read; the
  entry then stays evicted and the next idle click replaces it.
- A session that is live again (`session:created` for a resident id) folds as always. When
  the resident entry was an evicted, empty one, the client also loads the resumed history
  the way a follower that had never seen the session does — the host's own seed is not an
  event, so nothing else would bring it.

**The seed race.** `SyncCore.seedSession` only FILLS an empty transcript, and
`session:created` and the history read are separate steps, so a prompt that lands in
between would be the whole transcript and the history a no-op. Every respawn of an evicted
session starts empty, so the race is the common path, not a rarity. The read is
registered with core (`SyncCore.trackSeed`, from `create-session.ts`) and
`handlers-core.sendPrompt` — the one entry both transports use — waits on it before it emits
`session:user-message`, enqueues or runs. The wait is conditional (a session with no read in
flight still sends synchronously), every send waiting on the same read resumes in arrival
order, and the entry clears when the read settles, success or failure.
A Claude, opencode or pi session that exits (the inactivity timer, any `cancel()`) and then
respawns IN PLACE has no `createSession` to seed canonical: the next prompt reaches the same
session object, which resumes its engine session itself. `sendPrompt` therefore seeds in that case too — canonical
holds nothing for the session, did not drop an empty one, and the engine has a session id to
resume — through the same `seedCanonicalTranscript` (`ipc/seed-canonical-transcript.ts`) and
`trackSeed`, and waits on it. A prompt that would only queue behind a running turn does not.
For a resumed Claude session `sendPrompt` waits on a second thing alongside the read: the
session's own re-fold of its totals from the transcript (`ISession.resumeSeedReady`,
undefined once settled so a later send stays synchronous). The canonical read itself is
content-first for a non-fork Claude resume (no status line — the fold's
`session:status-line` supplies it), so the first prompt waits only for the transcript pass
plus a usually memoized fold, not for a second cost pass (ADR-102 amendment).

**Bounds.** A resumed session re-reads its transcript from disk on the host, once per
respawn. A client resyncing onto an exited session shows its
last-known transcript until the disk read lands. A history read that resolves AFTER a
disconnect refills a session canonical had already evicted (`seedSession` fills any empty
transcript); it is dropped again at the next exit. (Until 4c this section also said the
shadow comparator treated "renderer transcript empty, canonical transcript non-empty" as
eviction rather than drift — that comparator is **deleted**; the replica folds the shared
reducer, so there is no second interpretation to mask.)

`SyncCore.removeSession` is the explicit-removal path (delete session / delete
project) — and it is **wired**, which it was not when this sentence was first written:
`handlers-core.deleteSession` / `deleteProject` serve both surfaces and run
cancel → `removeSession` → unlink, in that order. `removeSession` EMITS
`session:removed` rather than editing canonical in place, so the delete is an ordered,
ringed fact every replica folds and a reconnecting client replays. A later resume
re-seeds through `seedSession` from the same `loadSessionHistory` every client uses.

Two paired halves make the removal stick rather than being re-minted:

- **F7's rule** — every reducer branch except `session:watch-update` no-ops on an
  unknown id, so engine traffic that arrives after a delete cannot re-mint the entry
  as a `cwd: ''` ghost.
- **The unwatch** — `session:watch-update` is the one branch that still bootstraps,
  and unlinking a watched `.jsonl` is exactly what makes the watcher fire one more
  time. `handlers-core.deleteSession` / `deleteProject` therefore `unwatchSession`
  every id they are about to remove, BEFORE the cancel.

Phase 5 S4 added two async reads to this picture, and each side has its own guard —
they are NOT the same guard, because the two seeds are not the same method:

- **Host.** The watcher's debounce callback awaits `loadSessionHistory`, and the unwatch
  above only stops reads that have not STARTED. After the await it re-checks that this
  watch entry is still the live one (`watchers.get(routingId) === entry`) and returns
  without seeding or emitting if it is not. That check is load-bearing rather than
  belt-and-braces: `SyncCore.seedWatchedSession` BOOTSTRAPS by design (a watched session
  has no birth event) and so does the notify's reducer branch, so an unguarded late read
  re-minted the deleted session in canonical and in every replica.
- **Clients.** The refetch is debounced, so `session:removed` cancels a pending one
  before it starts; a read already in flight is caught on the way back, because the
  replica's `seedWatchedSession` NO-OPS on an unknown id (it is a refetch of something
  the client already has, never an introduction) and the observer re-checks residency
  before calling it.

### The limit: a client offline across the delete keeps the entry

`session:removed` reaches a client two ways, and neither covers every case:

- **Live, or by catchup** — only while the removal is still inside the 5000-entry
  ring. A client that reconnects after the ring has rolled past it gets a `sync-full`
  instead, and that is where the gap is.
- **By snapshot** — it is NOT covered. `hydrateReplica` merges on a resync
  (`{...canonical.sessions, ...restored.sessions}`, `stores/replica.ts`), deliberately:
  a client may have navigated to a historical session the host's snapshot knows nothing
  about, and replacing the map would drop it. A snapshot says which sessions exist, not
  which ones stopped existing, so a locally-known-but-omitted session SURVIVES the
  resync. Its id-keyed registry rows (title, pin, recents) are force-projected clean, so
  what is left is an orphan row rather than a working session.

That is the honest bound: **a client that was offline across a delete, and reconnects
after the ring has rolled past it, keeps a dead entry until it navigates away.** Closing
it needs a tombstone set the snapshot carries and the merge intersects against — a wire
change with its own eviction policy, deliberately not taken with this fix.

## Phase-1 residuals closed here

`automation:*` and `log-viewer:*` events are classified above. Their **invoke** halves
were the last raw `ipcMain.handle` families; S1b (2026-08-17) settled both, in opposite
directions:

- **`automation:*` is ported.** All ten invoke channels declare `config` on the command
  registry and are registered on BOTH transports from one shared declaration
  (`ipc/automation-commands.ts`) — capability-checked, mutations audited. The seven
  mutating channels therefore LEFT `PINNED_CAPABILITIES`: `config` is grantable, and a
  grantable pin would break that table's one guarantee (which is also why the reads were
  never pinned). See security.md §The registration sweep.
- **`log-viewer:*` stays desktop-forever.** It drives a `BrowserWindow`, so it is host
  chrome like `window:*`; it keeps its raw `ipcMain.handle` wiring in
  `services/log-viewer.ts` and its `admin` pin as the belt behind having no remote
  registration at all.
