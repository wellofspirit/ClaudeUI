/**
 * Shadow comparator — SyncCore phase 4a item 9.
 *
 * 4a runs canonical state alongside the still-authoritative renderer store. The
 * comparator is the drift detector for that duplication: it diffs
 * `SyncCore.getSnapshot()` against the renderer's `__getRemoteState()` and names
 * the fields that disagree. If the two interpretations of the same event stream
 * diverge, 4b's cutover would silently change what clients see — so the whole
 * point of shadowing is to find that BEFORE the switch, not after.
 *
 * Dev/test only. Nothing here runs in a production build path: the host gates it
 * behind `CLAUDEUI_SYNC_SHADOW=1` and the e2e suite calls it directly.
 *
 * ## Masks (each one is a KNOWN, documented divergence — not a fudge)
 *
 * - **Streaming buffers** are compared only when the session is idle. Mid-turn,
 *   the renderer has applied a delta core has not yet delivered (or the reverse);
 *   at idle both have applied everything, so a difference is real.
 * - **Unseeded / evicted sessions** are skipped. The renderer strips heavy arrays
 *   for cold sessions (`evictColdSessions`) and hydrates them through a query
 *   core never sees; core seeds from the transcript asynchronously. Neither is
 *   drift, and both resolve to the same content once the session is warm.
 * - **`durationMs` on thinking blocks** is stripped. The renderer computes it
 *   from wall-clock deltas; the reducer is clock-free by contract
 *   (`shared/sync/reducer.ts`). Replicating durations needs the EMITTER to put
 *   elapsed time in the event — a 4b prerequisite, recorded here.
 * - **User-message identity** (`id`, `timestamp`) is normalized. Today's
 *   `session:user-message` payload carries neither, so the renderer mints
 *   `msg-<uuid>`/`Date.now()` locally and core mints `user-<seq>`/`0`. Also a 4b
 *   prerequisite: the id must move into the event.
 *
 * Electron-free (lint-fenced): the caller supplies both snapshots.
 */

import type { FullStateSnapshot, PerSessionSnapshot } from '../../shared/remote-protocol'
import type { ChatMessage, ContentBlock } from '../../shared/types'

export interface ShadowDiff {
  /** `null` for app-level fields. */
  routingId: string | null
  field: string
  canonical: unknown
  renderer: unknown
}

export interface ShadowCompareOptions {
  /**
   * Sessions core has not finished seeding (`CanonicalSessionState.seeded ===
   * false`). Skipped entirely — their transcript is still arriving.
   */
  unseeded?: ReadonlySet<string>
  /** Compare streaming buffers even mid-turn (tests that drive to a known point). */
  compareStreamingAlways?: boolean
  /**
   * Field names (app-level or per-session) to skip, each one a divergence the
   * CALLER can justify. Used by the 4a shadow flows for the fields the renderer
   * still writes locally rather than deriving from the stream:
   *
   * - `activeSessionId` — selection is per-client view state (ADR-041); the
   *   snapshot carries it only so a fresh remote client has somewhere to land.
   * - `recentSessionIds` / `pinnedSessionIds` / `customTitles` / `hiddenSessions` /
   *   `hiddenProjects` / `sessionEngines` / `worktreeInfoMap` — mutated by client
   *   actions (`createNewSession`, `addUserMessage`, `setCustomTitle`, the
   *   worktree detection in `useClaudeEvents`) and reaching canonical only via the
   *   slow `config:sessions-changed` file-watcher loop, so they cannot match at an
   *   arbitrary instant in 4a. Closing that gap means those writes become
   *   commands — 4c work, recorded in docs/architecture/sync-channels.md.
   * - `directories` — sourced from a query, not the stream.
   */
  ignoreFields?: ReadonlySet<string>
  /** Cap on reported rows so a dev-mode log line stays bounded. */
  limit?: number
}

/**
 * The client-written snapshot fields (docs/architecture/sync-channels.md
 * §"Client-written state"): mutated by client actions and reaching core only via
 * the slow config file-watcher loop — or never — so a 4a shadow compare must
 * skip them. ONE definition, used by both the dev watch (`services/sync-host.ts`)
 * and the shadow-parity e2e: a watch that forgot one of these would log
 * known-divergence noise every tick, which is exactly the blunted-instrument
 * failure the shadow exists to avoid.
 */
export const CLIENT_WRITTEN_FIELDS: ReadonlySet<string> = new Set([
  'activeSessionId',
  'recentSessionIds',
  'pinnedSessionIds',
  'customTitles',
  'sessionEngines',
  'hiddenSessions',
  'hiddenProjects',
  'worktreeInfoMap',
  'directories'
])

/** Per-session fields compared verbatim (deep JSON equality). */
const SESSION_FIELDS = [
  'cwd',
  'pendingApprovals',
  'todos',
  'sentFiles',
  'queue',
  'taskNotifications',
  'activeTasks',
  'taskProgressMap',
  'subagentMessages',
  'permissionMode',
  'effort',
  'thinkingMode',
  'reasoningVariant',
  'statusLine',
  'metering',
  'sdkActive',
  'selectedEngineId',
  'selectedModel'
] as const satisfies ReadonlyArray<keyof PerSessionSnapshot>

/** App-level fields compared verbatim. */
const APP_FIELDS = [
  'activeSessionId',
  'directories',
  'recentSessionIds',
  'pinnedSessionIds',
  'customTitles',
  'worktreeInfoMap',
  'sessionEngines',
  'hiddenSessions',
  'hiddenProjects'
] as const satisfies ReadonlyArray<keyof FullStateSnapshot>

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Strip the fields that are structurally unreplicable today (see class note). */
function normalizeMessages(messages: ChatMessage[] | undefined): unknown[] {
  return (messages ?? []).map((m) => ({
    // A user message's id/timestamp are client-minted; an assistant message's id
    // comes from the engine and IS comparable, so only user rows are normalized.
    id: m.role === 'user' ? '<user>' : m.id,
    role: m.role,
    timestamp: 0,
    content: (m.content ?? []).map(stripBlockTiming),
    ...(m.planContent !== undefined ? { planContent: m.planContent } : {})
  }))
}

function stripBlockTiming(block: ContentBlock): unknown {
  if (block.type === 'thinking') {
    const { durationMs: _durationMs, ...rest } = block
    return rest
  }
  return block
}

/**
 * Compare canonical against the renderer replica.
 *
 * Sessions present on ONE side only are reported as a single row rather than a
 * field-by-field storm: "core knows a session the renderer does not" is one
 * finding, and the reverse usually means eviction/hydration.
 */
export function compareShadow(
  canonical: FullStateSnapshot,
  renderer: FullStateSnapshot,
  options: ShadowCompareOptions = {}
): ShadowDiff[] {
  const diffs: ShadowDiff[] = []
  const limit = options.limit ?? 50
  const unseeded = options.unseeded ?? new Set<string>()
  const push = (d: ShadowDiff): void => {
    if (diffs.length < limit) diffs.push(d)
  }

  const ignored = options.ignoreFields ?? new Set<string>()

  for (const field of APP_FIELDS) {
    if (ignored.has(field)) continue
    if (!jsonEq(canonical[field], renderer[field])) {
      push({ routingId: null, field, canonical: canonical[field], renderer: renderer[field] })
    }
  }

  const ids = new Set([
    ...Object.keys(canonical.sessions ?? {}),
    ...Object.keys(renderer.sessions ?? {})
  ])
  for (const id of ids) {
    if (unseeded.has(id)) continue
    const c = canonical.sessions?.[id]
    const r = renderer.sessions?.[id]
    if (!c || !r) {
      push({
        routingId: id,
        field: c ? 'session-missing-in-renderer' : 'session-missing-in-canonical',
        canonical: c ? '<present>' : '<absent>',
        renderer: r ? '<present>' : '<absent>'
      })
      continue
    }
    // The renderer strips a cold session's transcript and re-hydrates it from
    // disk on reselect. An empty renderer transcript against a non-empty
    // canonical one is that eviction, not drift.
    const evicted = (r.messages?.length ?? 0) === 0 && (c.messages?.length ?? 0) > 0
    if (evicted) continue

    for (const field of SESSION_FIELDS) {
      if (ignored.has(field)) continue
      if (!jsonEq(c[field], r[field])) {
        push({ routingId: id, field, canonical: c[field], renderer: r[field] })
      }
    }

    if (!jsonEq(c.status?.state, r.status?.state)) {
      push({ routingId: id, field: 'status.state', canonical: c.status, renderer: r.status })
    }

    const cm = normalizeMessages(c.messages)
    const rm = normalizeMessages(r.messages)
    if (!jsonEq(cm, rm)) {
      push({ routingId: id, field: 'messages', canonical: cm, renderer: rm })
    }

    const idle = c.status?.state === 'idle' && r.status?.state === 'idle'
    if (options.compareStreamingAlways || idle) {
      if (!jsonEq(c.streamingText, r.streamingText)) {
        push({
          routingId: id,
          field: 'streamingText',
          canonical: c.streamingText,
          renderer: r.streamingText
        })
      }
      if (!jsonEq(c.streamingThinking, r.streamingThinking)) {
        push({
          routingId: id,
          field: 'streamingThinking',
          canonical: c.streamingThinking,
          renderer: r.streamingThinking
        })
      }
      if (!jsonEq(c.subagentStreamingText, r.subagentStreamingText)) {
        push({
          routingId: id,
          field: 'subagentStreamingText',
          canonical: c.subagentStreamingText,
          renderer: r.subagentStreamingText
        })
      }
      if (!jsonEq(c.subagentStreamingThinking, r.subagentStreamingThinking)) {
        push({
          routingId: id,
          field: 'subagentStreamingThinking',
          canonical: c.subagentStreamingThinking,
          renderer: r.subagentStreamingThinking
        })
      }
    }
  }

  return diffs
}

/** One bounded log line per divergence — never the whole state. */
export function formatShadowDiff(diffs: readonly ShadowDiff[], valueChars = 160): string[] {
  return diffs.map((d) => {
    const where = d.routingId ? `${d.routingId}.${d.field}` : d.field
    const brief = (v: unknown): string => JSON.stringify(v ?? null).slice(0, valueChars)
    return `${where}: core=${brief(d.canonical)} renderer=${brief(d.renderer)}`
  })
}
