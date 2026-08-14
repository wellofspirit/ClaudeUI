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
 * | `replicated` | yes | where the snapshot carries the field | all clients |
 * | `volatile-pending-phase-5` | today's behavior, verbatim | only where snapshot parity requires | today's targets |
 * | `host-local` | no | no | owning desktop window only |
 *
 * ## 4a rules (binding)
 *
 * 1. 4a must not *reduce* today's ring membership — ring reductions are phase-5
 *    work, and a reduction that lands early silently breaks catchup.
 * 2. 4a must not *add* remote delivery for a channel that is main-window-only
 *    today. `delivery` records what happens now, so a channel whose current
 *    fan-out is the main window is `host-local` in 4a even when its payload is
 *    conceptually app state (`auth:state`, `account:changed`, `usage:*`'s
 *    siblings, …). Promoting those is a later, deliberate step.
 * 3. Every visibility change carries a {@link ChannelSpec.deliveryDelta} string.
 *    The sanctioned 4a set is exactly `session:config-changed` (a new channel)
 *    plus the metering snapshot FIELD (not a delivery change).
 */

/** How an event is treated by the ring, canonical state, and the fan-out. */
export type ChannelClass = 'replicated' | 'volatile-pending-phase-5' | 'host-local'

/**
 * Which sockets/windows an emission reaches. Derived from the call sites the
 * emission funnel absorbed, so the names describe today's targets literally:
 *
 * - `all` — the host's primary window + every extra window (which includes the
 *   remote bridge, hence every connected WS client).
 * - `extras-only` — extra windows only. The desktop-originated `session:created`
 *   / `config:*-changed` / pre-spawn `session:permission-mode` paths, whose
 *   originating renderer already applied the change locally. A named 4c deletion
 *   target (`create-session.ts`'s `notifyMainWindow` asymmetry), NOT a 4a fix.
 * - `main-only` — the host's primary window. Host-local surfaces.
 */
export type DeliveryTarget = 'all' | 'extras-only' | 'main-only'

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
  /** The widest target set any call site of this channel uses today. */
  delivery: DeliveryTarget
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
      delivery: 'main-only',
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
    delivery: 'all',
    why: 'Session registry. The desktop-originated call site delivers extras-only (create-session.ts notifyMainWindow=false) — preserved verbatim, 4c deletion target.'
  },
  'session:user-message': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'The single source of truth for a non-queued user turn entering the transcript.'
  },
  'session:message': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Assistant messages, upsert-by-id. Also the trigger for the derived todos / sentFiles fields (reducer-internal).'
  },
  'session:messages-retracted': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Removes messages by id and clears in-flight streaming buffers.'
  },
  'session:tool-result': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Attaches a tool_result block to its tool_use (first result wins) and re-derives todos / sentFiles.'
  },
  'session:queue-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Queue of record (ADR-053): the FULL item list, applied as a replace; consumed items synthesize a `steer-<itemId>` transcript message.'
  },
  'session:approval-request': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Approval lifecycle is event-driven ONLY (ADR-038) — never inferred from turn state.'
  },
  'session:approval-dismiss': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'The other half of the event-driven approval lifecycle (externally resolved approvals).'
  },
  'session:status': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Status + the status-driven rekey rule. Core owns the rekey as of 4a (item 7); clients rekey on this event in stream order.'
  },
  'session:result': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Turn boundary. Canonical effect is the completed-todo-list dismissal only; nothing else is inferred from the running→idle edge.'
  },
  'session:task-started': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'activeTasks — without it a client that syncs mid-task reads an async Task as complete.'
  },
  'session:task-progress': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'taskProgressMap, keyed by toolUseId.'
  },
  'session:task-notification': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Terminal task state (ADR-040): appends the notification and drops the task from activeTasks.'
  },
  'session:subagent-message': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'subagentMessages map, upsert-by-id; clears the streaming buffers for that subagent.'
  },
  'session:subagent-message-batch': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Batched form of the same upsert (subagent-watcher coalescing).'
  },
  'session:subagent-tool-result': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Tool results inside a subagent transcript.'
  },
  'session:permission-mode': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Per-session config. The pre-spawn echo (handlers-core.setPermissionMode) delivers all — the pattern session:config-changed mirrors.'
  },
  'session:config-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    deliveryDelta:
      'NEW channel (sanctioned 4a addition). model / effort / thinkingMode / reasoningVariant picks were previously invisible to other clients (remote.md defect 1); they now replicate as a partial, per-field replace.',
    why: 'Per-session config parity — the interim relief sync-core.md flagged, landed as part of phase 4.'
  },
  'session:status-line': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'statusLine replace. Cost fields inside it are cumulative-per-process snapshots — replace, never accumulate.'
  },
  'session:metering': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    deliveryDelta:
      'Delivery UNCHANGED. The 4a change is a snapshot FIELD (PerSessionSnapshot.metering) — before it, every resync silently dropped metering.',
    why: 'Engine-neutral metering snapshot, applied as a replace.'
  },
  'session:plan': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Plan steps arrive as an explicit todo list (pi) — replaces the derived todos.'
  },
  'session:slash-commands': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'App-level slashCommands list (the snapshot carries it per session, sourced from one app-level list).'
  },
  'session:skills': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'App-level sdkSkillNames, same shape as slash-commands.'
  },
  'session:watch-update': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    deliveryDelta: undefined,
    why: 'Payload-heavy (a full re-read of the watched transcript). Funneled in 4a so canonical holds watched sessions — without that, 4b would drop them. Phase-5 target: replace with notify + refetch.'
  },
  'session:error': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Rings and fans out today, but FullStateSnapshot carries no error list — per-client transient. Known 4b/5 gap, recorded not fixed.'
  },
  'session:warning': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Same as session:error — no snapshot field.'
  },
  'session:sandbox-violation': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Same as session:error — no snapshot field.'
  },
  'session:vendor-auth-required': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Rings and fans out; no snapshot field (the card is re-derived from the next turn).'
  },
  'session:auth-source': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'App-level auth banner input; no snapshot field.'
  },
  'session:mcp-servers': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'MCP status list; no snapshot field (clients refetch via `session:mcp-status`).'
  },
  'session:directories-changed': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'A payload-less notify — the sidebar refetches via a query. Nothing to apply.'
  },

  // -------------------------------------------------------------------------
  // Session domain — volatile lane (phase 5 separates these out)
  // -------------------------------------------------------------------------
  'session:stream': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Text/thinking deltas. Rings today (which is exactly the buffer-poisoning phase 5 fixes) — canonical accumulates because streamingText/streamingThinking are snapshot fields.'
  },
  'session:subagent-stream': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Per-subagent deltas; the subagentStreaming* maps are snapshot fields.'
  },
  'session:bash-output': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Live bash tail. Rings today; no snapshot field, so canonical stays out of it.'
  },
  'session:background-output': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Background-task tail. Same as bash-output.'
  },

  // -------------------------------------------------------------------------
  // App / config domain
  // -------------------------------------------------------------------------
  'config:settings-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'App settings. The desktop save path delivers extras-only (handlers-core.saveUiSettings) — preserved verbatim.'
  },
  'config:sessions-changed': {
    cls: 'replicated',
    ring: true,
    canonical: true,
    delivery: 'all',
    why: 'Session registry config (recent / pinned / titles / worktrees / hidden / sessionEngines). Per-key presence semantics (H15) are honored by the reducer.'
  },
  'git:status-update': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Per-cwd git summary. Fans out today; FullStateSnapshot carries no git summaries in 4a, so canonical does not hold them (recorded gap — sync-core.md lists them as replicated state for a later stage).'
  },
  'mockup:file-changed': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Mockup live-reload notify. The desktop-registered watcher is main-only (session.ipc.ts); the remote-registered one is all — both preserved verbatim.'
  },
  'usage:data': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Account rate-limit usage. Fans out today; no snapshot field.'
  },
  'usage:block-data': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Block analytics. Fans out today; no snapshot field.'
  },

  // -------------------------------------------------------------------------
  // Automation domain (phase-1 residual, classified here)
  // -------------------------------------------------------------------------
  'automation:changed': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Automation list. Fans out to extras today; no snapshot field, so a remote client sees live changes but resyncs empty until the automation surface gets snapshot coverage.'
  },
  'automation:run-update': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Run lifecycle; no snapshot field.'
  },
  'automation:run-message': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Run transcript message; no snapshot field.'
  },
  'automation:stream-event': {
    cls: 'volatile-pending-phase-5',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Run streaming deltas — same volatile shape as session:stream, same phase-5 destination.'
  },
  'automation:processing': {
    cls: 'replicated',
    ring: true,
    canonical: false,
    delivery: 'all',
    why: 'Per-automation busy flag; no snapshot field.'
  },

  // -------------------------------------------------------------------------
  // Host-local — desktop window only, never ringed (rule 2)
  // -------------------------------------------------------------------------
  'auth:state': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Native OAuth flow transitions (ADR-014): a local browser + loopback listener, meaningless to a remote client.'
  },
  'account:changed': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Main-window-only today (remote.md defect 5). Promoting it is a deliberate later step, not a 4a side effect.'
  },
  'account:respawn-sessions': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'A command to the hosting renderer, not state.'
  },
  'remote:status': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'The remote server describing itself to its host. A remote client learns its own connectivity from the socket.'
  },
  'log-viewer:entry': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Feeds the separate log-viewer BrowserWindow. Host diagnostics; an `admin`-capability surface later, never ringed.'
  },
  'log-viewer:entry-batch': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Coalesced form of log-viewer:entry.'
  },
  'log-viewer:batch': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Full ring dump on log-viewer open.'
  },
  'voice:state': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Host microphone capture (security.md §Host-local).'
  },
  'voice:transcript': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
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
    delivery: 'all',
    why: 'Mixed emitters: VoiceClient sends it main-only, but ClaudeSession sends it through BaseSession.send (rings + all). Widest behavior recorded verbatim; no snapshot field.'
  },
  'terminal:data': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Desktop PTY bytes. Remote terminals ride the dedicated volatile WS lane (`term-data`), which is never logged — security.md §Audit.'
  },
  'terminal:exit': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Desktop PTY lifecycle; the remote lane has its own `term-exit` frame.'
  },
  'plugin:views-changed': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Main-window-only today; plugin-declared capabilities decide later whether plugin surfaces replicate.'
  },
  'window:maximized-change': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
    why: 'Window chrome (`host` capability).'
  },
  'app:before-quit': {
    cls: 'host-local',
    ring: false,
    canonical: false,
    delivery: 'main-only',
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
