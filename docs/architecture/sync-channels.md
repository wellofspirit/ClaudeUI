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
  connections that subscribed. Two FLAVORS, recorded per row as `volatileFlavor`:
  - **`text-stream`** (S1: `session:stream`, `session:subagent-stream`) — an
    accumulating `{streamId, turnId, offset, chunk}` frame. Canonical accumulates
    it through `applyStreamFrame`, because `streamingText` / `streamingThinking`
    are snapshot fields, and an offset mismatch self-heals by re-watching.
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
   always named. S1 moved `session:stream` and `session:subagent-stream`; S2 moved the
   three tails and with them the last member of the interim `volatile-pending-phase-5`
   class, which is now DELETED rather than left as an empty option. All five are class
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
justifies them is the same one.

| Channel                | Addition                    | Why it could not stay client-side                                                                                                                                                                                                                     |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session:user-message` | `{id, timestamp}` (4b)      | Minted by `sendPrompt`. Each client used to invent its own `msg-<uuid>`/`Date.now()`, so one user turn had a different id in every replica and canonical could only mint a positional `user-<seq>`. With the snapshot authoritative, that renumbers a client's transcript on every resync. |
| `session:message`      | `thinkingDurationMs?` (4b)  | Timed by `BaseSession.send` (one implementation, all three engines) and moved onto the sealed thinking block by the reducer. `applyEvent` is clock-free by contract, so elapsed time can only come from the process that watched the clock.               |
| `session:created`      | `{permissionMode?, engineId?, model?, resumeSessionAt?}` (post-4) | **The BIRTH CONFIG, plus the fork anchor.** The payload was `{cwd, resumeSessionId}`, so the reducer built the entry from `emptySession()` — `permissionMode: 'default'`, `selectedEngineId: 'claude'`, `selectedModel: 'default'` — and only the ORIGINATOR was right, because its own `createNewSession` seeds the replica before the event arrives. Every other client, and canonical itself (hence every snapshot and every resync), showed the wrong mode/engine/model until some later event happened to carry the real value: a session created on the desktop read as `default`/claude on a phone, and vice versa. `resumeSessionAt` is the same problem one layer down: a branched session spawns with `--resume <parent> --fork-session --resume-session-at <lineUuid>` and cli.js resumes from `lines.slice(0, w+1)`, but every reader of that transcript (canonical's seed in `create-session.ts`, and each client's own cold seed in `useClaudeEvents`) loaded the parent's WHOLE file — so a fork opened showing the turns it exists to discard, above a model that had never seen them. Only `prepareAndCreateSession` knows any of these values at birth: the spawn opts (with the RESOLVED model, and the anchor) it just handed `manager.create`. Every field is optional and the reducer falls back to the existing session value, so an old-shape event (a committed golden fixture, catchup from an older host) folds exactly as before; an absent anchor means "load everything", which is also the non-fork case, and an anchor not present in the file truncates nothing. `effort` / `thinkingMode` are deliberately excluded: the spawn args carrying them are already resolved model defaults (`resolveSessionSdkOptions`), while the canonical fields mean "explicitly picked" (`null` = unset, which the effort precedence ladder depends on), so announcing them would freeze a default into a pick. |
| `session:watch-update` | `cwd?` (post-4) | The watched session's working directory. This event is the ONLY thing that introduces a watched session — nothing spawns, so there is no `session:created` — which is why its reducer branch is the one place `ensured()` still bootstraps an entry. Without the cwd that entry was born with `cwd: ''` and every cwd-keyed feature missed it (git status, sidebar/notification folder name, the per-cwd terminal group, `deleteProject`'s live-session sweep). It cannot be derived here: `projectKey` is `cwdToProjectKey`'s lossy, irreversible output. Every caller has it (`SessionInfo.cwd`); absent leaves the existing value alone. |
| `session:directories-changed` | the merged listing (post-4) | Was payload-less: a "refetch now" every client answered with its OWN three-query merge (claude + opencode + pi), while canonical held only `listDirectories()`. Two different lists, not two views of one — so every `sync-full` force-projected the claude-only subset over the merged one and a reconnecting client lost its opencode/pi rows until its next 30 s poll. Main owns both other list sources, so it does the merge and the event carries the result. Absent folds as the old no-op notify (committed fixtures, catchup across the upgrade). Rate-limited at the emitter — see the row in the main table. |

`FullStateSnapshot` itself is UNCHANGED by 4b: the cutover moved where the snapshot
comes from, not what it contains, so the web client works unmodified. The
`session:created` addition does not change it either — the fields it carries are
snapshot fields that already existed.

## The table

| Channel                          | Class                    | Ring | Canonical | Delta | Notes                                                                                                                                                                                                  |
| -------------------------------- | ------------------------ | ---- | --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automation:changed`             | replicated               | yes  | no        | —     | Automation list. Reaches every subscriber; no snapshot field, so a client sees live changes but resyncs empty until the automation surface gets snapshot coverage.                              |
| `automation:processing`          | replicated               | yes  | no        | —     | Per-automation busy flag; no snapshot field.                                                                                                                                                           |
| `automation:run-message`         | replicated               | yes  | no        | —     | Run transcript message; no snapshot field.                                                                                                                                                             |
| `automation:run-update`          | replicated               | yes  | no        | —     | Run lifecycle; no snapshot field.                                                                                                                                                                      |
| `config:sessions-changed`        | replicated               | yes  | yes       | —     | Session registry config (recent / pinned / titles / worktrees / hidden / sessionEngines). Per-key presence semantics (H15) are honored by the reducer.                                                 |
| `config:settings-changed`        | replicated               | yes  | yes       | —     | App settings. 4c made the desktop save path echo back to the saver too (uniform delivery); the reducer applies a replace, so the echo is a no-op there.                                                                                          |
| `git:status-update`              | replicated               | yes  | no        | —     | Per-cwd git summary. Fans out today; FullStateSnapshot carries no git summaries in 4a, so canonical does not hold them (recorded gap — sync-core.md lists them as replicated state for a later stage). **Ring-hygiene note (S2, deliberate):** `git:watch` re-emits the CACHED status for every cwd in the set, and clients re-state their set on every answered sync — so a flapping phone costs one redundant ring entry per watched cwd per reconnect. Accepted: that re-emit is the always-emit-first invariant the mobile git pill depends on (the poller is change-only after its first tick), and the bound is one small payload per cwd per reconnect, not per poll. |
| `mockup:file-changed`            | replicated               | yes  | no        | —     | Mockup live-reload notify. 4c made both watchers (desktop in session.ipc.ts, remote in remote-handlers.ts) reach every subscriber — the notify a reconnecting client already replayed from the ring.                                                   |
| `session:approval-dismiss`       | replicated               | yes  | yes       | —     | The other half of the event-driven approval lifecycle (externally resolved approvals).                                                                                                                 |
| `session:approval-request`       | replicated               | yes  | yes       | —     | Approval lifecycle is event-driven ONLY (ADR-038) — never inferred from turn state.                                                                                                                    |
| `session:auth-source`            | replicated               | yes  | no        | —     | App-level auth banner input; no snapshot field.                                                                                                                                                        |
| `session:config-changed`         | replicated               | yes  | yes       | yes   | Per-session config parity — the interim relief sync-core.md flagged, landed as part of phase 4.                                                                                                        |
| `session:conversation-cleared`   | replicated               | yes  | yes       | —     | "Start fresh": resets a session to its birth state (transcript, streams, todos, queue, tasks, subagents, per-session config) without removing it, keeping `cwd` and `sdkActive`. Was a local `patchLocalSession` on the clearing client ONLY, so canonical kept the whole transcript and the next resync handed it straight back to the client that had just cleared it. The fresh-run `permissionMode` rides the event because resolving it needs `availableModels` + the auto-mode gate — client state no reducer can see. |
| `session:created`                | replicated               | yes  | yes       | —     | Session registry. 4c deleted the notifyMainWindow asymmetry in create-session.ts, so the originating client receives its own session:created like every other subscriber. **Post-4 payload addition:** the birth config (`permissionMode` / `engineId` / resolved `model`) rides the event — without it every non-originating replica, and canonical, folded `emptySession()`'s default/claude/default over the session's real spawn config. Each field is optional and falls back to the existing session value, so old-shape events fold unchanged. |
| `session:directories-changed`    | replicated               | yes  | yes       | —     | The MERGED (claude + opencode + pi) sidebar listing, applied as a replace. Was a payload-less notify each client answered with its own three-query merge while canonical held the claude-only subset — see the payload-additions table. **Rate-limited at the emitter, and it has to be:** the trigger is the debounced recursive watcher on `~/.claude/projects`, and `SessionInfo.lastActivityAt` comes from mtime, so the listing "changes" for a whole turn's duration. The debounce is trailing-resetting, so that is one tick per quiet gap of ≥500 ms rather than two a second — but a long turn has many such gaps, and each would push a full payload into a 5000-entry ring. `services/sync-seed.ts` coalesces overlapping walks (out-of-order walks could emit stale-after-fresh, which an ordered ring does not self-correct), floors emissions at 5 s, and distinguishes MEMBERSHIP changes (a create/delete — never dropped, deferred to a trailing emit) from reorder-only mtime churn (dropped; the 30 s poll re-reads it). |
| `session:error`                  | replicated               | yes  | no        | —     | Rings and fans out today, but FullStateSnapshot carries no error list — per-client transient. Known 4b/5 gap, recorded not fixed.                                                                      |
| `session:mcp-servers`            | replicated               | yes  | no        | —     | MCP status list; no snapshot field (clients refetch via `session:mcp-status`).                                                                                                                         |
| `session:message`                | replicated               | yes  | yes       | —     | Assistant messages, upsert-by-id. Also the trigger for the derived todos / sentFiles fields (reducer-internal). **4b payload addition:** an optional `thinkingDurationMs` — the elapsed thinking span this message seals, timed by the emitter and moved onto the block by the reducer. |
| `session:messages-retracted`     | replicated               | yes  | yes       | —     | Removes messages by id and clears in-flight streaming buffers.                                                                                                                                         |
| `session:metering`               | replicated               | yes  | yes       | yes   | Engine-neutral metering snapshot, applied as a replace.                                                                                                                                                |
| `session:permission-mode`        | replicated               | yes  | yes       | —     | Per-session config, emitted by the live session itself (including the reverted mode when the engine rejects a change). The **pre-spawn echo is deleted** (post-4): a not-yet-spawned session exists only in its creating client's replica, so the echo reached nobody — it only ever LOOKED like it worked because the reducer's `ensured()` minted a placeholder for the unknown id, which is the ghost F7 removed. `session:config-changed` is gated the same way. |
| `session:plan`                   | replicated               | yes  | yes       | —     | Plan steps arrive as an explicit todo list (pi) — replaces the derived todos.                                                                                                                          |
| `session:queue-changed`          | replicated               | yes  | yes       | —     | Queue of record (ADR-053): the FULL item list, applied as a replace; consumed items synthesize a `steer-<itemId>` transcript message.                                                                  |
| `session:removed`                | replicated               | yes  | yes       | —     | An explicit DELETE (one session, or one of the sessions a project delete sweeps). Emitted by `SyncCore.removeSession` after the live session is cancelled and before its files are unlinked. The reducer drops the entry AND every id-keyed app-level row (titles / pins / recents / hidden / worktrees / engines) — including for a COLD session canonical never held, which can still own a title and a pin. Identity-stable when the id is unknown, so a double delete costs one no-op ring entry. |
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
| `automation:stream-event`        | volatile (pass-through)  | no   | no        | —     | Run streaming deltas. **Off the ring as of phase 5 S2.** Scoped by AUTOMATION, not by run: the payload carries `automationId` and no run id, and the renderer already narrows to the viewed run from its own store. |
| `session:background-output`      | volatile (pass-through)  | no   | no        | —     | Background-task tail. Same lane, same flavor, same durable record as bash-output.                                                                                                                       |
| `session:bash-output`            | volatile (pass-through)  | no   | no        | —     | Live bash tail. **Off the ring as of phase 5 S2** — a noisy command emitted thousands of chunks and every one took a seq. No snapshot field, so losing one is honest; the tool_result is the record.     |
| `session:stream`                 | volatile (text-stream)   | no   | yes       | —     | Text/thinking deltas. **Off the ring as of phase 5 S1** — they ride the stream lane to watching connections only, and canonical accumulates through `applyStreamFrame` because streamingText/streamingThinking are snapshot fields. |
| `session:subagent-stream`        | volatile (text-stream)   | no   | yes       | —     | Per-subagent deltas — same lane, same frame family; the subagentStreaming* maps are snapshot fields.                                                                                                    |
| `account:changed`                | host-local               | no   | no        | —     | Main-window-only today (remote.md defect 5). Promoting it is a deliberate later step, not a 4a side effect.                                                                                            |
| `account:respawn-sessions`       | host-local               | no   | no        | —     | A command to the hosting renderer, not state.                                                                                                                                                          |
| `app:before-quit`                | host-local               | no   | no        | —     | Host lifecycle handshake with the owning renderer.                                                                                                                                                     |
| `auth:state`                     | host-local               | no   | no        | —     | Native OAuth flow transitions (ADR-014): a local browser + loopback listener, meaningless to a remote client.                                                                                          |
| `log-viewer:batch`               | host-local               | no   | no        | —     | Full ring dump on log-viewer open.                                                                                                                                                                     |
| `log-viewer:entry`               | host-local               | no   | no        | —     | Feeds the separate log-viewer BrowserWindow. Host diagnostics; an `admin`-capability surface later, never ringed.                                                                                      |
| `log-viewer:entry-batch`         | host-local               | no   | no        | —     | Coalesced form of log-viewer:entry.                                                                                                                                                                    |
| `plugin:views-changed`           | host-local               | no   | no        | —     | Main-window-only today; plugin-declared capabilities decide later whether plugin surfaces replicate.                                                                                                   |
| `remote:status`                  | host-local               | no   | no        | —     | The remote server describing itself to its host. A remote client learns its own connectivity from the socket.                                                                                          |
| `terminal:data`                  | host-local               | no   | no        | —     | Desktop PTY bytes, plus the scrollback replay a desktop `terminal:attach` pulls (`replay: true` = clear the screen and take this as the whole history; the client applies the clear IN BAND by writing `ESC c` ahead of the bytes, never `Terminal.reset()` — see sync-core.md §Terminal). Remote terminals ride the dedicated volatile WS lane (`term-data`), which is never logged — security.md §Audit. |
| `terminal:exit`                  | host-local               | no   | no        | —     | Desktop PTY lifecycle; the remote lane has its own `term-exit` frame.                                                                                                                                  |
| `voice:state`                    | host-local               | no   | no        | —     | Host microphone capture (security.md §Host-local).                                                                                                                                                     |
| `voice:transcript`               | host-local               | no   | no        | —     | Host microphone capture.                                                                                                                                                                               |
| `window:maximized-change`        | host-local               | no   | no        | —     | Window chrome (`host` capability).                                                                                                                                                                     |

`plugin:<id>:<event>` (ADR-005) is matched by PREFIX, since the names are generated
at runtime: `host-local`, no ring, owning-window only. Plugin-declared capabilities
are the follow-up that decides whether plugin surfaces may replicate. The plugin bridge
itself is a plain funnel SUBSCRIBER as of 4c (the fake `BrowserWindow` it used to be is
deleted); the event SET it receives is unchanged. **Phase 5 kept that true across the lane
split:** all five `volatile` channels stopped being events, so a sync subscriber no longer
sees them — the bridge registers an in-process stream OBSERVER instead
(`addStreamObserver`, unfiltered, since a plugin has no session selection to filter by) and
re-materializes each frame in the way its flavor calls for: a `text-stream` frame through
the shared `streamFrameToEmission`, a `pass-through` frame by reading `(channel, args)`
straight back off it (it never stopped being the emission). A plugin's payload is
byte-identical to what it received before the split.

The synthesis is GATED on a plugin actually listening, so it costs nothing on a machine
with no plugins — but by two different mechanisms, because the two flavors know different
amounts about themselves. A text frame carries a `streamId`, not a channel, so the gate
cannot be per-channel: `hasStreamListeners()` asks whether ANY plugin listens to either of
the two delta channels, and the shared inverse then decides which one the frame was. A
pass-through frame names its own channel, so it is gated exactly — `hasListeners(frame.channel)`
— and a plugin listening only to `session:bash-output` never pays for the automation tail.


## The stream lane (phase 5 S1 + S2)

Two lanes now leave the funnel, a channel's CLASS picks which, and — on the stream lane —
its FLAVOR picks what a frame means.

The **event lane** is unchanged: ring → canonical → every subscriber,
`{seq, channel, args}`, cursor and catchup as before.

The **stream lane** carries the five `volatile` channels and nothing else. The
`text-stream` flavor (S1) carries:

```
{ type: 'stream', streamId, turnId, offset, chunk }
```

- **`streamId`** — `<routingId>/text`, `<routingId>/thinking`,
  `<routingId>/sub/<toolUseId>/text`, `<routingId>/sub/<toolUseId>/thinking`. One
  exported helper (`src/shared/sync/stream.ts`) builds and parses it; the server, both
  clients and the tests import the same one.
- **`offset`** — the accumulated length (JS string units) of that stream BEFORE this
  chunk. A frame whose offset does not match the receiver's local length is a NO-OP that
  signals `mismatch`: applying it anyway would silently corrupt the text.
- **In-process observers** (`addStreamObserver`) see every frame with no watch set, and
  are a SEPARATE list from the connection-keyed subscribers. An observer has no session
  selection, no socket to die with and no capability to check; giving one a synthetic
  connection id would make every `stream:watch` bound reason about entries no client owns.
  The one production consumer is the plugin bridge.
- **`turnId`** — a per-stream generation, bumped by the EVENT lane whenever it clears
  that stream's accumulation (message seal, retraction, conversation clear, disconnect,
  subagent upsert). Within one socket frames are FIFO, and a cleared stream restarts at
  length 0, so the field is redundant today; it rides because contract 3 names it, and a
  mismatch on it is treated exactly like an offset mismatch.
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
cannot pause an LLM, so it drops. Both flavors recover by design — a text stream heals on
the next offset mismatch, a tail is lossy by contract — and **the event lane is never
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
`replay: true` uses for a PTY. On watch, the server immediately pushes one frame per
stream of the session at `offset: 0` — **including the EMPTY ones**. Offset 0 onto a
NON-EMPTY buffer is a REPLACE by construction; offset 0 onto an EMPTY one is just a turn's
first chunk and keeps the ordinary append semantics (which is what seals an open thinking
span). The replay is ordered **text before thinking**, because a text frame landing on an
empty buffer seals — replaying thinking first would hand that seal the value it had just
restored.

**Why the empty frames are not noise.** A replay is a claim about the SESSION, not about
the streams that happen to be non-empty in it. Omitting an empty one leaves a buffer
canonical CLEARED uncorrectable by re-watching, and that is reachable by ordinary use:
watch a session mid-thinking-span, switch away, its first text delta seals the span on
canonical, switch back — the replica keeps a phantom thinking block above the assistant
text, with an open span whose ticker keeps running, until the next message seal. The
subagent form is one switch away, since subagent text supersedes its thinking on every
chunk. The count stays bounded (two per session plus two per toolUseId that has actually
streamed), and a frame that changes nothing is identity-stable, so the projection does not
re-render for it.

A client cures a mid-connection mismatch by re-sending the same watch set; a client that
reconnects re-watches, because subscriptions are per-connection. There is no third
recovery path, and no cursor to repair.

**Sessions nobody watches still converge**, at message boundaries, over the event lane —
the accumulation is a snapshot field, so the coalesced answer always arrives. Only the
token-by-token animation is subscription-scoped. That is the design, not a gap. A TAIL
nobody watches does not converge at all — there is nothing to converge to — and that too is
the design: the tool_result completes the transcript either way.

**One interpretation, both sides.** `applyStreamFrame` is to the text-stream flavor what
`applyEvent` is to the event lane: core folds it against canonical,
`renderer/src/stores/replica.ts` folds it against the replica, and the streaming fields stay
SEALED. The reducer branches for those two channels are DELETED — `applyEvent` refuses a
`volatile` channel outright rather than keeping a fossil that could race the lane. A
pass-through frame has nothing to fold: it is dispatched, not applied, which is why the
three tails KEEP their `SyncEventMap` entries while the two delta channels lost theirs.

**In-process consumers keep their pre-split contract.** The ADR-005 plugin bridge and the
engine tests' stub window subscribed to all five channels before the split. They receive
them from the observer list instead: a text frame through the shared
`streamFrameToEmission` inverse, a pass-through frame by reading `(channel, args)` straight
back off it.

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

Canonical does **not** evict on a timer, because no client does either:
`evictLocalSessions` (stores/replica.ts) keeps the lightweight entry and strips the
heavy arrays, marking it `seeded: false` so reselection re-hydrates from disk.
Canonical therefore keeps its transcript. (Until 4c this section also said the shadow
comparator treated "renderer transcript empty, canonical transcript non-empty" as
eviction rather than drift — that comparator is **deleted**; the replica folds the
shared reducer, so there is no second interpretation to mask.)

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

`automation:*` and `log-viewer:*` events are classified above. Their **invoke**
channels still live on raw `ipcMain.handle` (ipc/automation.ipc.ts,
services/log-viewer.ts) rather than the command registry; every mutating one is now
pinned in `PINNED_CAPABILITIES` (`admin`), so the eventual port cannot silently
widen the remote surface. The automation READ channels are deliberately unpinned —
they would declare `config`, which is grantable, and a grantable pin would break
that table's one guarantee.
