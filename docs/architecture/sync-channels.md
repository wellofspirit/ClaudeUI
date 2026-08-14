# Event-channel classification — as of SyncCore phase 4c (complete)

Part of [architecture/](README.md). **Status:** landed with SyncCore phase 4a, updated
by 4b (snapshot cutover) and 4c (uniform delivery, then reducer adoption). The
machine-readable source of truth is `src/shared/sync/channels.ts`; this file is its prose
twin, and `sync-funnel-guard.test.ts` fails if any emitted channel — or any channel either
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
decision. Three columns record the consequences of that decision:

| Column        | Meaning                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Ring**      | does the emission enter the 5000-entry event ring a reconnecting client replays from?                                               |
| **Canonical** | does `applyEvent` change canonical state? `no` means the payload has no field in `FullStateSnapshot` — a recorded gap, not a claim |

**The `Delivery` column is gone (4c).** It recorded a per-CALL-SITE target — `all` /
`extras-only` / `main-only` — because that is what delivery was: the desktop window was a
distinguished fan-out target, other clients had to masquerade as fake `BrowserWindow`
"extra sinks", and three call sites deliberately skipped the renderer they assumed already
knew. Delivery is now a function of the channel's **class** and nothing else:

- `host-local` ⇒ the owning `BrowserWindow` only, by targeted `webContents.send`;
- `replicated` / `volatile-pending-phase-5` ⇒ **every subscriber, always**.

A column that can only ever restate the class is a column that can only ever drift, so it
was deleted rather than pinned.

## Classes

- **`replicated`** — rings, fans out to every client, and (where the snapshot has a
  field) folds into canonical state. The default for anything that is state.
- **`volatile-pending-phase-5`** — streaming deltas. These ring **today**, which is
  exactly the buffer-poisoning phase 5 removes; 4a records that behavior verbatim
  rather than fixing it early (see the rules below).
- **`host-local`** — the owning desktop window only: window chrome, native pickers,
  voice capture, OAuth browser flows, PTY bytes, the log-viewer window.

## The rules, and which one 4c retired

1. **Never reduce ring membership.** (Still binding.) A channel that rings today still
   rings, even where that is clearly wrong (`session:stream`). Removing entries is phase-5
   work with its own migration; doing it early would break catchup for clients that are
   mid-reconnect across the upgrade.
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
saves, and the pre-spawn `session:permission-mode` echo — now echo back to the client that
originated them. Every one of those payloads is a REPLACE, so the echo is idempotent for
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
holds exactly those two rows — which is why 4b's two payload additions below are
recorded in the Notes column instead of flipping it.

## Payload additions in 4b — the only wire changes in the cutover

| Channel                | Addition                    | Why it could not stay client-side                                                                                                                                                                                                                     |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session:user-message` | `{id, timestamp}`           | Minted by `sendPrompt`. Each client used to invent its own `msg-<uuid>`/`Date.now()`, so one user turn had a different id in every replica and canonical could only mint a positional `user-<seq>`. With the snapshot authoritative, that renumbers a client's transcript on every resync. |
| `session:message`      | `thinkingDurationMs?`       | Timed by `BaseSession.send` (one implementation, all three engines) and moved onto the sealed thinking block by the reducer. `applyEvent` is clock-free by contract, so elapsed time can only come from the process that watched the clock.               |

`FullStateSnapshot` itself is UNCHANGED by 4b: the cutover moved where the snapshot
comes from, not what it contains, so the web client works unmodified.

## The table

| Channel                          | Class                    | Ring | Canonical | Delta | Notes                                                                                                                                                                                                  |
| -------------------------------- | ------------------------ | ---- | --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automation:changed`             | replicated               | yes  | no        | —     | Automation list. Reaches every subscriber; no snapshot field, so a client sees live changes but resyncs empty until the automation surface gets snapshot coverage.                              |
| `automation:processing`          | replicated               | yes  | no        | —     | Per-automation busy flag; no snapshot field.                                                                                                                                                           |
| `automation:run-message`         | replicated               | yes  | no        | —     | Run transcript message; no snapshot field.                                                                                                                                                             |
| `automation:run-update`          | replicated               | yes  | no        | —     | Run lifecycle; no snapshot field.                                                                                                                                                                      |
| `config:sessions-changed`        | replicated               | yes  | yes       | —     | Session registry config (recent / pinned / titles / worktrees / hidden / sessionEngines). Per-key presence semantics (H15) are honored by the reducer.                                                 |
| `config:settings-changed`        | replicated               | yes  | yes       | —     | App settings. 4c made the desktop save path echo back to the saver too (uniform delivery); the reducer applies a replace, so the echo is a no-op there.                                                                                          |
| `git:status-update`              | replicated               | yes  | no        | —     | Per-cwd git summary. Fans out today; FullStateSnapshot carries no git summaries in 4a, so canonical does not hold them (recorded gap — sync-core.md lists them as replicated state for a later stage). |
| `mockup:file-changed`            | replicated               | yes  | no        | —     | Mockup live-reload notify. 4c made both watchers (desktop in session.ipc.ts, remote in remote-handlers.ts) reach every subscriber — the notify a reconnecting client already replayed from the ring.                                                   |
| `session:approval-dismiss`       | replicated               | yes  | yes       | —     | The other half of the event-driven approval lifecycle (externally resolved approvals).                                                                                                                 |
| `session:approval-request`       | replicated               | yes  | yes       | —     | Approval lifecycle is event-driven ONLY (ADR-038) — never inferred from turn state.                                                                                                                    |
| `session:auth-source`            | replicated               | yes  | no        | —     | App-level auth banner input; no snapshot field.                                                                                                                                                        |
| `session:config-changed`         | replicated               | yes  | yes       | yes   | Per-session config parity — the interim relief sync-core.md flagged, landed as part of phase 4.                                                                                                        |
| `session:created`                | replicated               | yes  | yes       | —     | Session registry. 4c deleted the notifyMainWindow asymmetry in create-session.ts, so the originating client receives its own session:created like every other subscriber.                                           |
| `session:directories-changed`    | replicated               | yes  | no        | —     | A payload-less notify — the sidebar refetches via a query, so there is nothing to apply. **4b:** the same trigger also refreshes canonical's `directories` field (`SyncCore.setDirectories`, core-internal, NOT an event), so a resyncing client gets the same listing a live one refetches. |
| `session:error`                  | replicated               | yes  | no        | —     | Rings and fans out today, but FullStateSnapshot carries no error list — per-client transient. Known 4b/5 gap, recorded not fixed.                                                                      |
| `session:mcp-servers`            | replicated               | yes  | no        | —     | MCP status list; no snapshot field (clients refetch via `session:mcp-status`).                                                                                                                         |
| `session:message`                | replicated               | yes  | yes       | —     | Assistant messages, upsert-by-id. Also the trigger for the derived todos / sentFiles fields (reducer-internal). **4b payload addition:** an optional `thinkingDurationMs` — the elapsed thinking span this message seals, timed by the emitter and moved onto the block by the reducer. |
| `session:messages-retracted`     | replicated               | yes  | yes       | —     | Removes messages by id and clears in-flight streaming buffers.                                                                                                                                         |
| `session:metering`               | replicated               | yes  | yes       | yes   | Engine-neutral metering snapshot, applied as a replace.                                                                                                                                                |
| `session:permission-mode`        | replicated               | yes  | yes       | —     | Per-session config. The pre-spawn echo (handlers-core.setPermissionMode) delivers `all` — the pattern session:config-changed mirrors.                                                                  |
| `session:plan`                   | replicated               | yes  | yes       | —     | Plan steps arrive as an explicit todo list (pi) — replaces the derived todos.                                                                                                                          |
| `session:queue-changed`          | replicated               | yes  | yes       | —     | Queue of record (ADR-053): the FULL item list, applied as a replace; consumed items synthesize a `steer-<itemId>` transcript message.                                                                  |
| `session:result`                 | replicated               | yes  | yes       | —     | Turn boundary. Canonical effect is the completed-todo-list dismissal only; nothing else is inferred from the running→idle edge.                                                                        |
| `session:sandbox-violation`      | replicated               | yes  | no        | —     | Same as session:error — no snapshot field.                                                                                                                                                             |
| `session:skills`                 | replicated               | yes  | yes       | —     | App-level sdkSkillNames, same shape as slash-commands.                                                                                                                                                 |
| `session:slash-commands`         | replicated               | yes  | yes       | —     | App-level slashCommands list (the snapshot carries it per session, sourced from one app-level list).                                                                                                   |
| `session:status`                 | replicated               | yes  | yes       | —     | Status + the status-driven rekey rule. Core owns the rekey as of 4a (item 7); clients rekey on this event in stream order.                                                                             |
| `session:status-line`            | replicated               | yes  | yes       | —     | statusLine replace. Cost fields inside it are cumulative-per-process snapshots — replace, never accumulate.                                                                                            |
| `session:subagent-message`       | replicated               | yes  | yes       | —     | subagentMessages map, upsert-by-id; clears that subagent                                                                                                                                               |
| `session:subagent-message-batch` | replicated               | yes  | yes       | —     | Batched form of the same upsert (subagent-watcher coalescing).                                                                                                                                         |
| `session:subagent-tool-result`   | replicated               | yes  | yes       | —     | Tool results inside a subagent transcript.                                                                                                                                                             |
| `session:task-notification`      | replicated               | yes  | yes       | —     | Terminal task state (ADR-040): appends the notification and drops the task from activeTasks.                                                                                                           |
| `session:task-progress`          | replicated               | yes  | yes       | —     | taskProgressMap, keyed by toolUseId.                                                                                                                                                                   |
| `session:task-started`           | replicated               | yes  | yes       | —     | activeTasks — without it a client that syncs mid-task reads an async Task as complete.                                                                                                                 |
| `session:tool-result`            | replicated               | yes  | yes       | —     | Attaches a tool_result block to its tool_use (first result wins) and re-derives todos / sentFiles.                                                                                                     |
| `session:user-message`           | replicated               | yes  | yes       | —     | The single source of truth for a non-queued user turn entering the transcript. **4b payload addition:** `{id, timestamp}` are minted by `sendPrompt`, so every replica agrees on the id (the reducer keeps a positional `user-<seq>` fallback for old-shape events). |
| `session:vendor-auth-required`   | replicated               | yes  | no        | —     | Rings and fans out; no snapshot field (the card is re-derived from the next turn).                                                                                                                     |
| `session:warning`                | replicated               | yes  | no        | —     | Same as session:error — no snapshot field.                                                                                                                                                             |
| `session:watch-update`           | replicated               | yes  | yes       | —     | Payload-heavy (a full re-read of the watched transcript). Funneled in 4a so canonical holds watched sessions — without that, 4b would drop them. Phase-5 target: replace with notify + refetch.        |
| `usage:block-data`               | replicated               | yes  | no        | —     | Block analytics. Fans out today; no snapshot field.                                                                                                                                                    |
| `usage:data`                     | replicated               | yes  | no        | —     | Account rate-limit usage. Fans out today; no snapshot field.                                                                                                                                           |
| `voice:error`                    | replicated               | yes  | no        | —     | Mixed emitters: VoiceClient and ClaudeSession (via BaseSession.send) both raise it. Rings, so it reaches every subscriber; no snapshot field. 4c had to route VoiceClient's through emitEvent — its targeted send would have landed nowhere. The lane split belongs to the phase-5 work on the voice surface.                               |
| `automation:stream-event`        | volatile-pending-phase-5 | yes  | no        | —     | Run streaming deltas — same volatile shape as session:stream, same phase-5 destination.                                                                                                                |
| `session:background-output`      | volatile-pending-phase-5 | yes  | no        | —     | Background-task tail. Same as bash-output.                                                                                                                                                             |
| `session:bash-output`            | volatile-pending-phase-5 | yes  | no        | —     | Live bash tail. Rings today; no snapshot field, so canonical stays out of it.                                                                                                                          |
| `session:stream`                 | volatile-pending-phase-5 | yes  | yes       | —     | Text/thinking deltas. Rings today (which is exactly the buffer-poisoning phase 5 fixes) — canonical accumulates because streamingText/streamingThinking are snapshot fields.                           |
| `session:subagent-stream`        | volatile-pending-phase-5 | yes  | yes       | —     | Per-subagent deltas; the subagentStreaming* maps are snapshot fields.                                                                                                                                  |
| `account:changed`                | host-local               | no   | no        | —     | Main-window-only today (remote.md defect 5). Promoting it is a deliberate later step, not a 4a side effect.                                                                                            |
| `account:respawn-sessions`       | host-local               | no   | no        | —     | A command to the hosting renderer, not state.                                                                                                                                                          |
| `app:before-quit`                | host-local               | no   | no        | —     | Host lifecycle handshake with the owning renderer.                                                                                                                                                     |
| `auth:state`                     | host-local               | no   | no        | —     | Native OAuth flow transitions (ADR-014): a local browser + loopback listener, meaningless to a remote client.                                                                                          |
| `log-viewer:batch`               | host-local               | no   | no        | —     | Full ring dump on log-viewer open.                                                                                                                                                                     |
| `log-viewer:entry`               | host-local               | no   | no        | —     | Feeds the separate log-viewer BrowserWindow. Host diagnostics; an `admin`-capability surface later, never ringed.                                                                                      |
| `log-viewer:entry-batch`         | host-local               | no   | no        | —     | Coalesced form of log-viewer:entry.                                                                                                                                                                    |
| `plugin:views-changed`           | host-local               | no   | no        | —     | Main-window-only today; plugin-declared capabilities decide later whether plugin surfaces replicate.                                                                                                   |
| `remote:status`                  | host-local               | no   | no        | —     | The remote server describing itself to its host. A remote client learns its own connectivity from the socket.                                                                                          |
| `terminal:data`                  | host-local               | no   | no        | —     | Desktop PTY bytes. Remote terminals ride the dedicated volatile WS lane (`term-data`), which is never logged — security.md §Audit.                                                                     |
| `terminal:exit`                  | host-local               | no   | no        | —     | Desktop PTY lifecycle; the remote lane has its own `term-exit` frame.                                                                                                                                  |
| `voice:state`                    | host-local               | no   | no        | —     | Host microphone capture (security.md §Host-local).                                                                                                                                                     |
| `voice:transcript`               | host-local               | no   | no        | —     | Host microphone capture.                                                                                                                                                                               |
| `window:maximized-change`        | host-local               | no   | no        | —     | Window chrome (`host` capability).                                                                                                                                                                     |

`plugin:<id>:<event>` (ADR-005) is matched by PREFIX, since the names are generated
at runtime: `host-local`, no ring, owning-window only. Plugin-declared capabilities
are the follow-up that decides whether plugin surfaces may replicate. The plugin bridge
itself is a plain funnel SUBSCRIBER as of 4c (the fake `BrowserWindow` it used to be is
deleted); the event SET it receives is unchanged, because extras always got every
replicated + volatile channel and never a host-local one — which is exactly what a
subscriber gets.

## Reducer purity deltas

`applyEvent` is pure — no clock, no randomness (`reducer.unit.test.ts` spies on
`Date.now`/`Math.random` to prove it). A reducer that read wall-clock time would
fold a different state on every replay, so replay-equals-live would be false and
catchup could not be trusted. Two as-built consequences followed from that; **4b
closed both by moving the impure part into the emitter**, the only place it can
honestly live, and **4c deleted the renderer's mirrors of both**:

| Divergence                      | Why it existed                                                                                                                                 | Closed in 4b by                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Thinking-block `durationMs`     | the renderer measured it with wall-clock deltas; core tracks only "is a span open"                                                              | `BaseSession.send` times the span and stamps `ChatMessage.thinkingDurationMs` on the sealing message; the reducer moves it onto the block   |
| User-message `id` / `timestamp` | `session:user-message` carried `{prompt, attachments}` only, so the renderer minted `msg-<uuid>`/`Date.now()` and core minted `user-<seq>`/`0`  | `sendPrompt` mints both into the payload; the reducer prefers them, keeping the positional fallback for old-shape events                    |

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
flows skipped them through one shared definition (`CLIENT_WRITTEN_FIELDS` in
`src/main/sync/shadow.ts`). That file, that set and the comparator are **deleted**:
the renderer folds the shared reducer now, so its store IS the projection of
canonical and there is no second interpretation to diff.

What each row became:

| Field | Then | Now |
| ----- | ---- | --- |
| `activeSessionId` | client-written, never reached core | unchanged and correct: selection is per-client VIEW state (ADR-041). Core serves `null`; each client resolves its own — see below. |
| `recentSessionIds`, `pinnedSessionIds`, `customTitles`, `hiddenSessions`, `hiddenProjects`, `sessionEngines` | store actions wrote them, then saved `sessions.json` | SEALED. The action applies the change **through the replica** and persists through `config:save-sessions`, whose `config:sessions-changed` echo reaches every client including the saver. The local apply stays deliberately (`saveSessionConfig` merges from current state, so two rapid mutations would otherwise both merge from a stale base) — recorded as the one 4c deviation in [sync-core.md](sync-core.md). |
| `worktreeInfoMap` | `useClaudeEvents` **parsed a tool_result** and stored the result | moved to the MAIN process (`services/worktree-detect.ts`, observed at the funnel's delivery point) and persisted through that same save path. The sharp one is closed: no client derives state from a tool result any more. |

The registry-config row is fresher than it reads: the apply happens inside
`SyncCore.emit` on every save, so a desktop-originated save is already in the next
`getSnapshot()` (pinned by `handlers-core.test.ts`). The file watcher is now just the
cross-INSTANCE path.

**`directories` LEFT this table in 4b.** Core maintains it (seeded at boot, refreshed
on the `session:directories-changed` trigger — `SyncCore.setDirectories`), so it is
core-written, and a mismatch would be real drift between the sidebar a live client
sees and the one a reconnecting client gets.

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

## Eviction

Canonical does **not** evict on a timer, because the renderer does not either:
`evictColdSessions` (session-store.ts) keeps the lightweight entry and strips the
heavy arrays, marking it `evicted` so reselection re-hydrates from disk. Canonical
therefore keeps its transcript, and the comparator treats "renderer transcript
empty, canonical transcript non-empty" as eviction rather than drift.
`SyncCore.removeSession` exists for explicit removal (delete/close), and a later
resume re-seeds through `seedSession` from the same `loadSessionHistory` the
renderer uses.

## Phase-1 residuals closed here

`automation:*` and `log-viewer:*` events are classified above. Their **invoke**
channels still live on raw `ipcMain.handle` (ipc/automation.ipc.ts,
services/log-viewer.ts) rather than the command registry; every mutating one is now
pinned in `PINNED_CAPABILITIES` (`admin`), so the eventual port cannot silently
widen the remote surface. The automation READ channels are deliberately unpinned —
they would declare `config`, which is grantable, and a grantable pin would break
that table's one guarantee.
