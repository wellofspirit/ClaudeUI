/**
 * What a full sync costs — a pure measurement of one {@link FullStateSnapshot}.
 *
 * `sync-full` is all of canonical state in one frame, and nothing used to say how
 * big that is in a real install or where the bytes sit. This is the breakdown the
 * `SyncStats` log lines print (`services/sync-stats-log.ts`), so the progress /
 * shrink design for the snapshot can be chosen from numbers.
 *
 * It is NOT free: it serializes the snapshot (once whole, once per bucket), which
 * on a multi-MB snapshot blocks the thread for tens of milliseconds. Callers
 * gate it behind `logger.isEnabled('SyncStats', 'info')`.
 *
 * Sizes are `JSON.stringify(...).length` — UTF-16 code units, which equal bytes
 * for ASCII and under-count other text (up to 3x for CJK). Close enough to pick a
 * design; the frame-size line on the WS transport is the exact byte count.
 *
 * **Never carries content.** The result holds counts, byte sizes and routing ids
 * only — no message text, no titles, no cwd — because it is written to a log file
 * that is routinely pasted into bug reports.
 */

import type { FullStateSnapshot, PerSessionSnapshot } from '../../../shared/remote-protocol'

/** One session entry's size, by what it is made of. Sums to `bytes`. */
export interface SessionBytes {
  routingId: string
  /** Whole entry serialized: `messages + subagentMessages + itemStreams + rest`. */
  bytes: number
  messages: number
  subagentMessages: number
  itemStreams: number
  /** Everything else on the entry — including its copy of `slashCommands`/`sdkSkillNames`. */
  rest: number
  /** Top-level messages in the entry (a count, not content). */
  messageCount: number
}

export interface SnapshotStats {
  /** `JSON.stringify(snapshot).length` — the whole frame payload bar the envelope. */
  totalBytes: number
  /** How long that one stringify took, ms. The cost the host pays to encode a plaintext frame. */
  stringifyMs: number
  /** App-level split; `directories + settings + sessions + rest === totalBytes`. */
  app: {
    directories: number
    settings: number
    /** Σ of every session entry's `bytes`. */
    sessions: number
    /** Envelope, keys and every other top-level field (pins, titles, worktree map, links, …). */
    rest: number
  }
  sessionCounts: {
    total: number
    /** `sdkActive` or `status.state === 'running'` — what keeps a transcript in canonical. */
    live: number
    /** `seeded === false`: the host dropped (or has not read) this transcript. */
    unseeded: number
    // "watched" (stream:watch) is not a snapshot property, so it is not counted.
  }
  /** Σ over sessions of `messages` / `subagentMessages` / `itemStreams` / `rest`. */
  sessionBytes: Pick<SessionBytes, 'messages' | 'subagentMessages' | 'itemStreams' | 'rest'>
  /**
   * `slashCommands` + `sdkSkillNames` are repeated in EVERY session entry
   * (`toSnapshot`), so their cost scales with the session count. These are the
   * numbers for deciding whether to dedupe them.
   */
  slashRepeat: { perEntry: number; entries: number; total: number }
  /** The 5 largest session entries, largest first. */
  top: SessionBytes[]
}

/** The one logger source every sync-measurement line uses — host lines and the clients' relayed ones. */
export const SYNC_STATS_SOURCE = 'SyncStats'

const TOP_N = 5

/** `JSON.stringify(value).length`, 0 for `undefined` (which stringifies to nothing). */
function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

function describeSession(id: string, entry: PerSessionSnapshot): SessionBytes {
  const { messages, subagentMessages, itemStreams, ...others } = entry
  const messagesBytes = size(messages)
  const subagentBytes = size(subagentMessages)
  const streamsBytes = size(itemStreams)
  const rest = size(others)
  return {
    routingId: id,
    bytes: messagesBytes + subagentBytes + streamsBytes + rest,
    messages: messagesBytes,
    subagentMessages: subagentBytes,
    itemStreams: streamsBytes,
    rest,
    messageCount: Array.isArray(messages) ? messages.length : 0
  }
}

/** Measure `snapshot`. Pure apart from the clock; see the module note for its cost. */
export function describeSnapshot(snapshot: FullStateSnapshot): SnapshotStats {
  const started = performance.now()
  const totalBytes = size(snapshot)
  const stringifyMs = performance.now() - started

  const entries = Object.entries(snapshot.sessions ?? {})
  const perSession = entries.map(([id, entry]) => describeSession(id, entry))

  const sessions = perSession.reduce((n, s) => n + s.bytes, 0)
  const directories = size(snapshot.directories)
  const settings = size(snapshot.settings)

  const sessionBytes = { messages: 0, subagentMessages: 0, itemStreams: 0, rest: 0 }
  for (const s of perSession) {
    sessionBytes.messages += s.messages
    sessionBytes.subagentMessages += s.subagentMessages
    sessionBytes.itemStreams += s.itemStreams
    sessionBytes.rest += s.rest
  }

  const first = entries[0]?.[1]
  const perEntry = first ? size(first.slashCommands) + size(first.sdkSkillNames) : 0

  let live = 0
  let unseeded = 0
  for (const [, entry] of entries) {
    if (entry.sdkActive === true || entry.status?.state === 'running') live++
    if (entry.seeded === false) unseeded++
  }

  return {
    totalBytes,
    stringifyMs,
    app: {
      directories,
      settings,
      sessions,
      rest: totalBytes - directories - settings - sessions
    },
    sessionCounts: { total: entries.length, live, unseeded },
    sessionBytes,
    slashRepeat: { perEntry, entries: entries.length, total: perEntry * entries.length },
    top: [...perSession].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_N)
  }
}

/** One log-line rendering of {@link SnapshotStats}: `key=value` pairs, ids and numbers only. */
export function formatSnapshotStats(stats: SnapshotStats): string {
  const { app, sessionCounts: c, sessionBytes: b, slashRepeat: r } = stats
  const top = stats.top
    .map(
      (s) =>
        `${s.routingId}:${s.bytes}(messages=${s.messages} count=${s.messageCount} subagent=${s.subagentMessages} streams=${s.itemStreams} rest=${s.rest})`
    )
    .join(' ')
  return (
    `snapshot breakdown: totalBytes=${stats.totalBytes} stringifyMs=${stats.stringifyMs.toFixed(1)}` +
    ` app[directories=${app.directories} settings=${app.settings} sessions=${app.sessions} rest=${app.rest}]` +
    ` sessions[total=${c.total} live=${c.live} unseeded=${c.unseeded}]` +
    ` sessionBytes[messages=${b.messages} subagent=${b.subagentMessages} streams=${b.itemStreams} rest=${b.rest}]` +
    ` slashRepeat[perEntry=${r.perEntry} entries=${r.entries} total=${r.total}]` +
    ` top[${top}]`
  )
}
