# Event-channel classification — as of SyncCore phase 4a

Part of [architecture/](README.md). **Status:** landed with SyncCore phase 4a. The
machine-readable source of truth is `src/shared/sync/channels.ts`; this file is its
prose twin, and `sync-funnel-guard.test.ts` fails if any emitted channel — or any
channel either client subscribes to — is missing from the table.

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
| **Ring**      | does the emission enter the 5000-entry event ring a reconnecting client replays from?                                              |
| **Canonical** | does `applyEvent` change canonical state? `no` means the payload has no field in `FullStateSnapshot` — a recorded gap, not a claim |
| **Delivery**  | `all` = primary window + every extra sink (⇒ every WS client); `extras-only` = extras only; `main-only` = the host window          |

## Classes

- **`replicated`** — rings, fans out to every client, and (where the snapshot has a
  field) folds into canonical state. The default for anything that is state.
- **`volatile-pending-phase-5`** — streaming deltas. These ring **today**, which is
  exactly the buffer-poisoning phase 5 removes; 4a records that behavior verbatim
  rather than fixing it early (see the rules below).
- **`host-local`** — the owning desktop window only: window chrome, native pickers,
  voice capture, OAuth browser flows, PTY bytes, the log-viewer window.

## The two rules 4a binds itself to

1. **Never reduce ring membership.** A channel that rings today still rings, even
   where that is clearly wrong (`session:stream`). Removing entries is phase-5 work
   with its own migration; doing it early would break catchup for clients that are
   mid-reconnect across the upgrade.
2. **Never widen delivery.** A channel whose fan-out is main-window-only today is
   `host-local` here even when its payload is conceptually app state
   (`auth:state`, `account:changed`, `plugin:views-changed`). Promoting one is a
   deliberate later step behind the `admin`/`host` capabilities, not a side effect
   of moving the emission.

Consequence worth stating plainly: several rows read `replicated / canonical: no`.
Those channels reach every client live but are absent from the snapshot, so a
resync drops them. That is the as-built behavior, faithfully preserved — the fix
belongs with 4b (snapshot cutover) or with the surface's own phase.

**Catchup caveat on mixed-target channels.** Ring membership is per CHANNEL;
delivery is per CALL SITE. Two `main-only` emission sites ride channels that ring
(`auth-manager`'s `session:auth-source`, the desktop mockup watcher's
`mockup:file-changed`), so their events never reach a remote client live but DO
reach one replaying a catchup after reconnect. Both payloads are benign
(an auth-banner state, a mockup-reload notify), so 4a records the wrinkle rather
than special-casing per-site ring flags for it; it dies in 4c when delivery
becomes uniform per channel.

## Delivery delta — the only visibility changes in 4a

| Channel                  | Change                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session:config-changed` | NEW channel (sanctioned 4a addition). model / effort / thinkingMode / reasoningVariant picks were previously invisible to other clients (remote.md defect 1); they now replicate as a partial, per-field replace. |
| `session:metering`       | Delivery UNCHANGED. The 4a change is a snapshot FIELD (PerSessionSnapshot.metering) — before it, every resync silently dropped metering.                                                                          |

Nothing else in the table changes what any client can see. `session:metering`'s
delta is a **snapshot field**, not a delivery change: `PerSessionSnapshot.metering`
did not exist, so every resync silently blanked the TopBar breakdown.

## The table

| Channel                          | Class                    | Ring | Canonical | Delivery    | Delta | Notes                                                                                                                                                                                                  |
| -------------------------------- | ------------------------ | ---- | --------- | ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automation:changed`             | replicated               | yes  | no        | `all`       | —     | Automation list. Fans out to extras today; no snapshot field, so a remote client sees live changes but resyncs empty until the automation surface gets snapshot coverage.                              |
| `automation:processing`          | replicated               | yes  | no        | `all`       | —     | Per-automation busy flag; no snapshot field.                                                                                                                                                           |
| `automation:run-message`         | replicated               | yes  | no        | `all`       | —     | Run transcript message; no snapshot field.                                                                                                                                                             |
| `automation:run-update`          | replicated               | yes  | no        | `all`       | —     | Run lifecycle; no snapshot field.                                                                                                                                                                      |
| `config:sessions-changed`        | replicated               | yes  | yes       | `all`       | —     | Session registry config (recent / pinned / titles / worktrees / hidden / sessionEngines). Per-key presence semantics (H15) are honored by the reducer.                                                 |
| `config:settings-changed`        | replicated               | yes  | yes       | `all`       | —     | App settings. The desktop save path delivers extras-only (handlers-core.saveUiSettings) — preserved verbatim.                                                                                          |
| `git:status-update`              | replicated               | yes  | no        | `all`       | —     | Per-cwd git summary. Fans out today; FullStateSnapshot carries no git summaries in 4a, so canonical does not hold them (recorded gap — sync-core.md lists them as replicated state for a later stage). |
| `mockup:file-changed`            | replicated               | yes  | no        | `all`       | —     | Mockup live-reload notify. The desktop-registered watcher is main-only (session.ipc.ts); the remote-registered one is all — both preserved verbatim.                                                   |
| `session:approval-dismiss`       | replicated               | yes  | yes       | `all`       | —     | The other half of the event-driven approval lifecycle (externally resolved approvals).                                                                                                                 |
| `session:approval-request`       | replicated               | yes  | yes       | `all`       | —     | Approval lifecycle is event-driven ONLY (ADR-038) — never inferred from turn state.                                                                                                                    |
| `session:auth-source`            | replicated               | yes  | no        | `all`       | —     | App-level auth banner input; no snapshot field.                                                                                                                                                        |
| `session:config-changed`         | replicated               | yes  | yes       | `all`       | yes   | Per-session config parity — the interim relief sync-core.md flagged, landed as part of phase 4.                                                                                                        |
| `session:created`                | replicated               | yes  | yes       | `all`       | —     | Session registry. The desktop-originated call site delivers extras-only (create-session.ts notifyMainWindow=false) — preserved verbatim, 4c deletion target.                                           |
| `session:directories-changed`    | replicated               | yes  | no        | `all`       | —     | A payload-less notify — the sidebar refetches via a query. Nothing to apply.                                                                                                                           |
| `session:error`                  | replicated               | yes  | no        | `all`       | —     | Rings and fans out today, but FullStateSnapshot carries no error list — per-client transient. Known 4b/5 gap, recorded not fixed.                                                                      |
| `session:mcp-servers`            | replicated               | yes  | no        | `all`       | —     | MCP status list; no snapshot field (clients refetch via `session:mcp-status`).                                                                                                                         |
| `session:message`                | replicated               | yes  | yes       | `all`       | —     | Assistant messages, upsert-by-id. Also the trigger for the derived todos / sentFiles fields (reducer-internal).                                                                                        |
| `session:messages-retracted`     | replicated               | yes  | yes       | `all`       | —     | Removes messages by id and clears in-flight streaming buffers.                                                                                                                                         |
| `session:metering`               | replicated               | yes  | yes       | `all`       | yes   | Engine-neutral metering snapshot, applied as a replace.                                                                                                                                                |
| `session:permission-mode`        | replicated               | yes  | yes       | `all`       | —     | Per-session config. The pre-spawn echo (handlers-core.setPermissionMode) delivers `all` — the pattern session:config-changed mirrors.                                                                  |
| `session:plan`                   | replicated               | yes  | yes       | `all`       | —     | Plan steps arrive as an explicit todo list (pi) — replaces the derived todos.                                                                                                                          |
| `session:queue-changed`          | replicated               | yes  | yes       | `all`       | —     | Queue of record (ADR-053): the FULL item list, applied as a replace; consumed items synthesize a `steer-<itemId>` transcript message.                                                                  |
| `session:result`                 | replicated               | yes  | yes       | `all`       | —     | Turn boundary. Canonical effect is the completed-todo-list dismissal only; nothing else is inferred from the running→idle edge.                                                                        |
| `session:sandbox-violation`      | replicated               | yes  | no        | `all`       | —     | Same as session:error — no snapshot field.                                                                                                                                                             |
| `session:skills`                 | replicated               | yes  | yes       | `all`       | —     | App-level sdkSkillNames, same shape as slash-commands.                                                                                                                                                 |
| `session:slash-commands`         | replicated               | yes  | yes       | `all`       | —     | App-level slashCommands list (the snapshot carries it per session, sourced from one app-level list).                                                                                                   |
| `session:status`                 | replicated               | yes  | yes       | `all`       | —     | Status + the status-driven rekey rule. Core owns the rekey as of 4a (item 7); clients rekey on this event in stream order.                                                                             |
| `session:status-line`            | replicated               | yes  | yes       | `all`       | —     | statusLine replace. Cost fields inside it are cumulative-per-process snapshots — replace, never accumulate.                                                                                            |
| `session:subagent-message`       | replicated               | yes  | yes       | `all`       | —     | subagentMessages map, upsert-by-id; clears that subagent                                                                                                                                               |
| `session:subagent-message-batch` | replicated               | yes  | yes       | `all`       | —     | Batched form of the same upsert (subagent-watcher coalescing).                                                                                                                                         |
| `session:subagent-tool-result`   | replicated               | yes  | yes       | `all`       | —     | Tool results inside a subagent transcript.                                                                                                                                                             |
| `session:task-notification`      | replicated               | yes  | yes       | `all`       | —     | Terminal task state (ADR-040): appends the notification and drops the task from activeTasks.                                                                                                           |
| `session:task-progress`          | replicated               | yes  | yes       | `all`       | —     | taskProgressMap, keyed by toolUseId.                                                                                                                                                                   |
| `session:task-started`           | replicated               | yes  | yes       | `all`       | —     | activeTasks — without it a client that syncs mid-task reads an async Task as complete.                                                                                                                 |
| `session:tool-result`            | replicated               | yes  | yes       | `all`       | —     | Attaches a tool_result block to its tool_use (first result wins) and re-derives todos / sentFiles.                                                                                                     |
| `session:user-message`           | replicated               | yes  | yes       | `all`       | —     | The single source of truth for a non-queued user turn entering the transcript.                                                                                                                         |
| `session:vendor-auth-required`   | replicated               | yes  | no        | `all`       | —     | Rings and fans out; no snapshot field (the card is re-derived from the next turn).                                                                                                                     |
| `session:warning`                | replicated               | yes  | no        | `all`       | —     | Same as session:error — no snapshot field.                                                                                                                                                             |
| `session:watch-update`           | replicated               | yes  | yes       | `all`       | —     | Payload-heavy (a full re-read of the watched transcript). Funneled in 4a so canonical holds watched sessions — without that, 4b would drop them. Phase-5 target: replace with notify + refetch.        |
| `usage:block-data`               | replicated               | yes  | no        | `all`       | —     | Block analytics. Fans out today; no snapshot field.                                                                                                                                                    |
| `usage:data`                     | replicated               | yes  | no        | `all`       | —     | Account rate-limit usage. Fans out today; no snapshot field.                                                                                                                                           |
| `voice:error`                    | replicated               | yes  | no        | `all`       | —     | Mixed emitters: VoiceClient sends it main-only, but ClaudeSession sends it through BaseSession.send (rings + all). Widest behavior recorded verbatim; no snapshot field.                               |
| `automation:stream-event`        | volatile-pending-phase-5 | yes  | no        | `all`       | —     | Run streaming deltas — same volatile shape as session:stream, same phase-5 destination.                                                                                                                |
| `session:background-output`      | volatile-pending-phase-5 | yes  | no        | `all`       | —     | Background-task tail. Same as bash-output.                                                                                                                                                             |
| `session:bash-output`            | volatile-pending-phase-5 | yes  | no        | `all`       | —     | Live bash tail. Rings today; no snapshot field, so canonical stays out of it.                                                                                                                          |
| `session:stream`                 | volatile-pending-phase-5 | yes  | yes       | `all`       | —     | Text/thinking deltas. Rings today (which is exactly the buffer-poisoning phase 5 fixes) — canonical accumulates because streamingText/streamingThinking are snapshot fields.                           |
| `session:subagent-stream`        | volatile-pending-phase-5 | yes  | yes       | `all`       | —     | Per-subagent deltas; the subagentStreaming* maps are snapshot fields.                                                                                                                                  |
| `account:changed`                | host-local               | no   | no        | `main-only` | —     | Main-window-only today (remote.md defect 5). Promoting it is a deliberate later step, not a 4a side effect.                                                                                            |
| `account:respawn-sessions`       | host-local               | no   | no        | `main-only` | —     | A command to the hosting renderer, not state.                                                                                                                                                          |
| `app:before-quit`                | host-local               | no   | no        | `main-only` | —     | Host lifecycle handshake with the owning renderer.                                                                                                                                                     |
| `auth:state`                     | host-local               | no   | no        | `main-only` | —     | Native OAuth flow transitions (ADR-014): a local browser + loopback listener, meaningless to a remote client.                                                                                          |
| `log-viewer:batch`               | host-local               | no   | no        | `main-only` | —     | Full ring dump on log-viewer open.                                                                                                                                                                     |
| `log-viewer:entry`               | host-local               | no   | no        | `main-only` | —     | Feeds the separate log-viewer BrowserWindow. Host diagnostics; an `admin`-capability surface later, never ringed.                                                                                      |
| `log-viewer:entry-batch`         | host-local               | no   | no        | `main-only` | —     | Coalesced form of log-viewer:entry.                                                                                                                                                                    |
| `plugin:views-changed`           | host-local               | no   | no        | `main-only` | —     | Main-window-only today; plugin-declared capabilities decide later whether plugin surfaces replicate.                                                                                                   |
| `remote:status`                  | host-local               | no   | no        | `main-only` | —     | The remote server describing itself to its host. A remote client learns its own connectivity from the socket.                                                                                          |
| `terminal:data`                  | host-local               | no   | no        | `main-only` | —     | Desktop PTY bytes. Remote terminals ride the dedicated volatile WS lane (`term-data`), which is never logged — security.md §Audit.                                                                     |
| `terminal:exit`                  | host-local               | no   | no        | `main-only` | —     | Desktop PTY lifecycle; the remote lane has its own `term-exit` frame.                                                                                                                                  |
| `voice:state`                    | host-local               | no   | no        | `main-only` | —     | Host microphone capture (security.md §Host-local).                                                                                                                                                     |
| `voice:transcript`               | host-local               | no   | no        | `main-only` | —     | Host microphone capture.                                                                                                                                                                               |
| `window:maximized-change`        | host-local               | no   | no        | `main-only` | —     | Window chrome (`host` capability).                                                                                                                                                                     |

`plugin:<id>:<event>` (ADR-005) is matched by PREFIX, since the names are generated
at runtime: `host-local`, no ring, main-window-only. Plugin-declared capabilities
are the follow-up that decides whether plugin surfaces may replicate.

## Reducer purity deltas

`applyEvent` is pure — no clock, no randomness (`reducer.unit.test.ts` spies on
`Date.now`/`Math.random` to prove it). A reducer that read wall-clock time would
fold a different state on every replay, so replay-equals-live would be false and
catchup could not be trusted. Two as-built consequences follow, and the shadow
comparator masks both:

| Divergence                      | Why it exists                                                                                                                                | What 4b needs                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Thinking-block `durationMs`     | the renderer measures it with wall-clock deltas; core tracks only "is a span open"                                                           | the EMITTER must put elapsed time in the event |
| User-message `id` / `timestamp` | `session:user-message` carries `{prompt, attachments}` only, so the renderer mints `msg-<uuid>`/`Date.now()` and core mints `user-<seq>`/`0` | the id must move into the event payload        |

## Client-written state (not classified, and that is the finding)

These fields are in the snapshot but are written by **client actions**, so canonical
cannot match them at an arbitrary instant. Both 4a shadow flows — the dev watch and
the parity e2e — skip them via the single shared definition
(`CLIENT_WRITTEN_FIELDS` in `src/main/sync/shadow.ts`):

| Field                                                                                                        | Written by                                                       | Reaches core via                                                 |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `activeSessionId`                                                                                            | `switchSession` / `createNewSession`                             | nothing — selection is per-client view state (ADR-041)           |
| `recentSessionIds`, `pinnedSessionIds`, `customTitles`, `hiddenSessions`, `hiddenProjects`, `sessionEngines` | store actions that then save `sessions.json`                     | the `config:sessions-changed` file-watcher loop (slow, indirect) |
| `worktreeInfoMap`                                                                                            | `useClaudeEvents` **parses a tool_result** and stores the result | same file-watcher loop                                           |
| `directories`                                                                                                | `session:list-directories` query                                 | nothing — query-sourced                                          |

`worktreeInfoMap` is the sharp one: deriving state from a tool result inside a
client and storing it is precisely the pattern sync-core.md's client-computation
rule bans. It survives 4a only because moving it means moving an emitter, which is
4b/4c work.

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
