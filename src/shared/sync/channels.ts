/**
 * Channel classification — SyncCore phase 4a (ADR-051).
 *
 * Every event channel the main process emits is classified here. The table is
 * the machine-readable twin of `docs/architecture/sync-channels.md` and it is
 * **fail-closed**: `SyncCore.emit` refuses a channel that has no entry, so
 * adding an event without deciding whether it replicates is a hard error rather
 * than an accidental privacy/parity change.
 *
 * Deliberately Electron-free and dependency-free (lint-fenced) — core, the
 * renderer, and the web client all read the same table.
 *
 * ## Classes (sync-core.md §"State classification")
 *
 * | Class | Ring | Canonical | Delivery |
 * | --- | --- | --- | --- |
 * | `replicated` | yes | where the snapshot carries the field | every subscriber |
 * | `volatile` | **no** | yes (through `applyStreamFrame`) | WATCHING connections only |
 * | `volatile-pending-phase-5` | today's behavior, verbatim | only where snapshot parity requires | every subscriber |
 * | `host-local` | no | no | owning desktop window only |
 *
 * ## Delivery is a function of CLASS as of 4c
 *
 * 4a recorded a per-channel `delivery` target (`all` / `extras-only` /
 * `main-only`) because delivery was a property of the CALL SITE: the desktop
 * window was a distinguished fan-out target and some emitters deliberately
 * skipped it. 4c deleted that privilege — every client, desktop included, is a
 * uniform subscriber — so the column became derivable and was removed:
 *
 *  - `host-local` ⇒ the owning `BrowserWindow` only, by targeted send;
 *  - `volatile` ⇒ the stream lane: only connections whose `stream:watch` set
 *    names the session (phase 5 S1);
 *  - anything else ⇒ every registered subscriber, always.
 *
 * Two consequences 4c accepts deliberately (both recorded in
 * docs/architecture/sync-channels.md):
 *
 *  - the `extras-only` sites (`create-session`'s `notifyMainWindow=false`, the
 *    desktop `config:*` saves, the pre-spawn permission-mode echo) now echo back
 *    to the originating client too. Every one of those payloads is a replace, so
 *    the echo is idempotent;
 *  - the two `main-only` sites on RINGED channels (`session:auth-source` from
 *    auth-manager, `mockup:file-changed` from the desktop watcher) now reach
 *    remote clients live, which is what a reconnecting client already replayed
 *    from the ring. That was 4a's "catchup leak" wrinkle; it dies here.
 *
 * ## Rule 1 is RETIRED (phase 5 S1)
 *
 * 4a's surviving rule was **never reduce ring membership** — "a channel that
 * rings today still rings, even where that is clearly wrong (`session:stream`);
 * removing entries is phase-5 work with its own migration". This IS that
 * migration, for the two canonical-backed stream channels. They are class
 * `volatile` now: `ring: false`, no seq, no reducer branch, and delivery through
 * the subscription-scoped stream lane (`shared/sync/stream.ts`) instead of the
 * event fan-out. The owner waived backward compatibility for cached client
 * bundles, so there is no dual-emission lane — desktop and web ship with the
 * server.
 *
 * The tails (`session:bash-output`, `session:background-output`,
 * `automation:stream-event`) are S2 and keep `volatile-pending-phase-5` until
 * then, which is why both classes exist side by side.
 *
 * {@link ChannelSpec.deliveryDelta} still records the 4a-sanctioned visibility
 * additions, and the funnel guard still pins that set exactly.
 */

/** How an event is treated by the ring, canonical state, and the fan-out. */
export type ChannelClass =
  | 'replicated'
  | 'volatile'
  | 'volatile-pending-phase-5'
  | 'host-local'

export interface ChannelSpec {
  cls: ChannelClass
  /** Does the emission append to the event ring? Must equal today's behavior. */
  ring: boolean
  /**
   * Does `applyEvent` change canonical state? `false` for channels whose payload
   * has no field in `FullStateSnapshot` — recording that honestly is the point:
   * a `replicated` channel with `canonical: false` is a known 4b/5 gap, not a
   * claim that the state is replicated.
   */
  canonical: boolean
  /** Present iff 4a changes what any client sees. Sanctioned set only. */
  deliveryDelta?: string
  /** One-liner rationale, mirrored into docs/architecture/sync-channels.md. */
  why: string
}

/**
 * Channels whose names are generated at runtime and therefore cannot be listed.
 * Matched by prefix, after the exact table misses.
 */
const PREFIX_SPECS: ReadonlyArray<readonly [string, ChannelSpec]> = [
  [
    'plugin:',
    {
      cls: 'host-local',
      ring: false,
      canonical: false,
      why: 'Plugin-declared events (`plugin:<id>:<event>`, ADR-005) reach the hosting window only today; plugin-declared capabilities are the follow-up that decides whether they may replicate.'
    }
  ]
]

/**
 * The classification table. Sorted by domain, then alphabetically.
 *
 * `session:*` entries that carry `(routingId, data)` are session-scoped by
 * position (`args[0]`) — the wire encoding of contract 2's `sessionId` field
 * (see sync-core.md §"Wire encoding").
 */
export const CHANNEL_SPECS: Readonly<Record<string, ChannelSpec>> = {
  // -------------------------------------------------------------------------
  // Session domain — replicated
  // -------------------------------------------------------------------------
  'session:created': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Session registry. 4c deleted the notifyMainWindow asymmetry in create-session.ts, so the originating client receives its own `session:created` like every other subscriber.'
  },
  'session:removed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'The other half of the registry: an explicit delete (session or whole project). Deleting the FILES was never replicated, so canonical and every non-deleting client kept the entry forever and a late engine event re-minted a ghost.'
  },
  'session:conversation-cleared': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Resets a session to its birth state (transcript, streams, todos, queue, tasks, subagents, per-session config) without removing it. Was a local `patchLocalSession` on the clearing client only, so canonical kept the whole transcript and the next resync handed it straight back. `sdkActive` is deliberately preserved — clearing is a UI reset, not a process action.'
  },
  'session:user-message': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'The single source of truth for a non-queued user turn entering the transcript.'
  },
  'session:message': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Assistant messages, upsert-by-id. Also the trigger for the derived todos / sentFiles fields (reducer-internal).'
  },
  'session:messages-retracted': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Removes messages by id and clears in-flight streaming buffers.'
  },
  'session:tool-result': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Attaches a tool_result block to its tool_use (first result wins) and re-derives todos / sentFiles.'
  },
  'session:queue-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Queue of record (ADR-053): the FULL item list, applied as a replace; consumed items synthesize a `steer-<itemId>` transcript message.'
  },
  'session:approval-request': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Approval lifecycle is event-driven ONLY (ADR-038) — never inferred from turn state.'
  },
  'session:approval-dismiss': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'The other half of the event-driven approval lifecycle (externally resolved approvals).'
  },
  'session:status': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Status + the status-driven rekey rule. Core owns the rekey as of 4a (item 7); clients rekey on this event in stream order.'
  },
  'session:result': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Turn boundary. Canonical effect is the completed-todo-list dismissal only; nothing else is inferred from the running→idle edge.'
  },
  'session:task-started': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'activeTasks — without it a client that syncs mid-task reads an async Task as complete.'
  },
  'session:task-progress': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'taskProgressMap, keyed by toolUseId.'
  },
  'session:task-notification': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Terminal task state (ADR-040): appends the notification and drops the task from activeTasks.'
  },
  'session:subagent-message': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'subagentMessages map, upsert-by-id; clears the streaming buffers for that subagent.'
  },
  'session:subagent-message-batch': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Batched form of the same upsert (subagent-watcher coalescing).'
  },
  'session:subagent-tool-result': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Tool results inside a subagent transcript.'
  },
  'session:permission-mode': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Per-session config. The pre-spawn echo (handlers-core.setPermissionMode) delivers all — the pattern session:config-changed mirrors.'
  },
  'session:config-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    deliveryDelta:
      'NEW channel (sanctioned 4a addition). model / effort / thinkingMode / reasoningVariant picks were previously invisible to other clients (remote.md defect 1); they now replicate as a partial, per-field replace.',
    why: 'Per-session config parity — the interim relief sync-core.md flagged, landed as part of phase 4.'
  },
  'session:status-line': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'statusLine replace. Cost fields inside it are cumulative-per-process snapshots — replace, never accumulate.'
  },
  'session:metering': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    deliveryDelta:
      'Delivery UNCHANGED. The 4a change is a snapshot FIELD (PerSessionSnapshot.metering) — before it, every resync silently dropped metering.',
    why: 'Engine-neutral metering snapshot, applied as a replace.'
  },
  'session:plan': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Plan steps arrive as an explicit todo list (pi) — replaces the derived todos.'
  },
  'session:slash-commands': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'App-level slashCommands list (the snapshot carries it per session, sourced from one app-level list).'
  },
  'session:skills': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'App-level sdkSkillNames, same shape as slash-commands.'
  },
  'session:watch-update': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    deliveryDelta: undefined,
    why: 'Payload-heavy (a full re-read of the watched transcript). Funneled in 4a so canonical holds watched sessions — without that, 4b would drop them. Phase-5 target: replace with notify + refetch.'
  },
  'session:error': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Rings and fans out today, but FullStateSnapshot carries no error list — per-client transient. Known 4b/5 gap, recorded not fixed.'
  },
  'session:warning': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Same as session:error — no snapshot field.'
  },
  'session:sandbox-violation': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Same as session:error — no snapshot field.'
  },
  'session:vendor-auth-required': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Rings and fans out; no snapshot field (the card is re-derived from the next turn).'
  },
  'session:auth-source': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'App-level auth banner input; no snapshot field.'
  },
  'session:mcp-servers': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'MCP status list; no snapshot field (clients refetch via `session:mcp-status`).'
  },
  'session:directories-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'The merged (claude + opencode + pi) sidebar listing, applied as a replace. Was a payload-less notify each client answered with its OWN three-query merge, while canonical held the claude-only subset every sync-full then force-projected back over it.'
  },

  // -------------------------------------------------------------------------
  // Session domain — the volatile lane.
  //
  // The first two are SEPARATED (phase 5 S1): off the ring, onto the stream
  // frames. The two tails below still ring, pending S2.
  // -------------------------------------------------------------------------
  'session:stream': {
    cls: 'volatile',
    ring: false,
    canonical: true,
    why: 'Text/thinking deltas. Phase 5 S1 took them off the ring entirely: they ride the stream lane (`{streamId, turnId, offset, chunk}`) to watching connections only, and canonical accumulates through `applyStreamFrame` because streamingText/streamingThinking are snapshot fields.'
  },
  'session:subagent-stream': {
    cls: 'volatile',
    ring: false,
    canonical: true,
    why: 'Per-subagent deltas — same lane, same frame family; the subagentStreaming* maps are snapshot fields.'
  },
  'session:bash-output': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: false,
    why: 'Live bash tail. Rings today; no snapshot field, so canonical stays out of it.'
  },
  'session:background-output': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: false,
    why: 'Background-task tail. Same as bash-output.'
  },

  // -------------------------------------------------------------------------
  // App / config domain
  // -------------------------------------------------------------------------
  'config:settings-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'App settings. 4c made the desktop save path echo back to the saver too (uniform delivery); the reducer applies a replace, so the echo is a no-op there.'
  },
  'config:sessions-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    why: 'Session registry config (recent / pinned / titles / worktrees / hidden / sessionEngines). Per-key presence semantics (H15) are honored by the reducer.'
  },
  'git:status-update': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Per-cwd git summary. Fans out today; FullStateSnapshot carries no git summaries in 4a, so canonical does not hold them (recorded gap — sync-core.md lists them as replicated state for a later stage).'
  },
  'mockup:file-changed': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Mockup live-reload notify. 4c made both watchers (desktop in session.ipc.ts, remote in remote-handlers.ts) reach every subscriber — the notify a reconnecting client already replayed from the ring.'
  },
  'usage:data': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Account rate-limit usage. Fans out today; no snapshot field.'
  },
  'usage:block-data': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Block analytics. Fans out today; no snapshot field.'
  },

  // -------------------------------------------------------------------------
  // Automation domain (phase-1 residual, classified here)
  // -------------------------------------------------------------------------
  'automation:changed': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Automation list. Fans out to extras today; no snapshot field, so a remote client sees live changes but resyncs empty until the automation surface gets snapshot coverage.'
  },
  'automation:run-update': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Run lifecycle; no snapshot field.'
  },
  'automation:run-message': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Run transcript message; no snapshot field.'
  },
  'automation:stream-event': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: false,
    why: 'Run streaming deltas — same volatile shape as session:stream, same phase-5 destination.'
  },
  'automation:processing': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Per-automation busy flag; no snapshot field.'
  },

  // -------------------------------------------------------------------------
  // Host-local — desktop window only, never ringed (rule 2)
  // -------------------------------------------------------------------------
  'auth:state': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Native OAuth flow transitions (ADR-014): a local browser + loopback listener, meaningless to a remote client.'
  },
  'account:changed': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Main-window-only today (remote.md defect 5). Promoting it is a deliberate later step, not a 4a side effect.'
  },
  'account:respawn-sessions': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'A command to the hosting renderer, not state.'
  },
  'remote:status': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'The remote server describing itself to its host. A remote client learns its own connectivity from the socket.'
  },
  'log-viewer:entry': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Feeds the separate log-viewer BrowserWindow. Host diagnostics; an `admin`-capability surface later, never ringed.'
  },
  'log-viewer:entry-batch': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Coalesced form of log-viewer:entry.'
  },
  'log-viewer:batch': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Full ring dump on log-viewer open.'
  },
  'voice:state': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Host microphone capture (security.md §Host-local).'
  },
  'voice:transcript': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Host microphone capture.'
  },
  // NOTE the anomaly: `voice:error` is host-local in nature but ONE of its two
  // emitters is `BaseSession.send` (claude-session.ts's early-capture failure),
  // so today it rings and reaches every client. 4a rule 1 forbids reducing ring
  // membership, so it is recorded as it behaves, not as it ought to behave. The
  // fix belongs with the voice surface's phase-5 lane split.
  'voice:error': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    why: 'Mixed emitters: VoiceClient and ClaudeSession (via BaseSession.send) both raise it. Rings, so it reaches every subscriber; no snapshot field. The lane split belongs to the phase-5 work on the voice surface.'
  },
  'terminal:data': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Desktop PTY bytes, plus the scrollback replay a desktop `terminal:attach` pulls (`replay: true` = reset and take this as the whole history). Remote terminals ride the dedicated volatile WS lane (`term-data`), which is never logged — security.md §Audit.'
  },
  'terminal:exit': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Desktop PTY lifecycle; the remote lane has its own `term-exit` frame.'
  },
  'plugin:views-changed': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Main-window-only today; plugin-declared capabilities decide later whether plugin surfaces replicate.'
  },
  'window:maximized-change': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Window chrome (`host` capability).'
  },
  'app:before-quit': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    why: 'Host lifecycle handshake with the owning renderer.'
  }
}

/** Look up a channel, honoring the runtime-generated prefixes. */
export function channelSpec(channel: string): ChannelSpec | undefined {
  const exact = CHANNEL_SPECS[channel]
  if (exact) return exact
  for (const [prefix, spec] of PREFIX_SPECS) {
    if (channel.startsWith(prefix)) return spec
  }
  return undefined
}

/** True when the channel is classified (the fail-closed gate `emit` applies). */
export function isClassified(channel: string): boolean {
  return channelSpec(channel) !== undefined
}

/** Every channel whose class means "append to the ring". */
export function ringedChannels(): string[] {
  return Object.entries(CHANNEL_SPECS)
    .filter(([, spec]) => spec.ring)
    .map(([channel]) => channel)
    .sort()
}

/**
 * Does this channel ride the STREAM lane rather than the event lane (phase 5 S1)?
 *
 * The single source every dispatch point reads: `SyncCore.process` routes on it,
 * `applyEvent` refuses on it, the replica's fold skips on it, and the
 * classification-invariant test asserts the consequences from it. A second
 * `channel === 'session:stream' || …` anywhere would be the drift this replaces.
 */
export function isVolatileStream(channel: string): boolean {
  return channelSpec(channel)?.cls === 'volatile'
}

/** Every channel on the stream lane, sorted. */
export function volatileStreamChannels(): string[] {
  return Object.entries(CHANNEL_SPECS)
    .filter(([, spec]) => spec.cls === 'volatile')
    .map(([channel]) => channel)
    .sort()
}

/** Every channel `applyEvent` is expected to act on. */
export function canonicalChannels(): string[] {
  return Object.entries(CHANNEL_SPECS)
    .filter(([, spec]) => spec.canonical)
    .map(([channel]) => channel)
    .sort()
}

/** Rows with a sanctioned visibility change — the "delivery delta" column. */
export function deliveryDeltas(): Array<{ channel: string; delta: string }> {
  return Object.entries(CHANNEL_SPECS)
    .filter(([, spec]) => typeof spec.deliveryDelta === 'string')
    .map(([channel, spec]) => ({ channel, delta: spec.deliveryDelta as string }))
    .sort((a, b) => a.channel.localeCompare(b.channel))
}
