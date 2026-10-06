/**
 * The status line of an opencode session nobody is running (ADR-034, ADR-071 §2).
 *
 * Everything the line reports — cost, tokens, active duration, context used —
 * was reconstructed inside `OpencodeSession.replayStoredHistory`, and that
 * object exists only once a prompt is sent. So a session reopened from the
 * sidebar painted no line at all: no Cost tile in the tooltip, and a composer
 * reading `In: 0 / Out: 0` however long the session was.
 *
 * The stored messages carry all of it, so the reconstruction lives here and
 * BOTH callers use it: the cold history load (`opencode-session-list.ts`) and
 * the session's own resume seeding. One loop, deliberately — two loops over
 * the same messages is exactly how the reopened figure and the figure after
 * the first new turn come to disagree.
 */

import type { ModelCostEntry, StatusLineData } from '../../shared/types'
import { totalCosts } from '../../shared/cost-rule'
import { computeStoredDurationMs, type MessageTokens } from './event-mapper'
import { opencodeCostInputs, resolveOpencodeCosts, type OpencodeCostInputs } from './message-cost'
import { getOpencodeModelContextWindow } from './model-discovery'
import type { StoredMessage } from './protocol/types'
import type { Session_Message_Info, TokenUsage_Info } from './protocol-v2/openapi'

/** Cumulative token counts, in the shape the status line reports them. */
export interface OpencodeHistoryTokens {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** Everything a resumed session (or a cold load) recovers from stored messages. */
export interface OpencodeHistorySeed {
  /** One entry per priced message, resolved on READ so a later auth probe still counts. */
  costInputs: OpencodeCostInputs[]
  /** What opencode itself claimed to have charged — MeteringSnapshot's input. */
  engineReportedCostUsd: number
  /** modelId → summed display cost. Resolved here, as the live half is. */
  modelCosts: Map<string, number>
  tokens: OpencodeHistoryTokens
  /** The last turn's prompt size (input + cache read) — the context meter's numerator. */
  lastContextLength: number
  /** Accumulated ACTIVE turn time, the engine-neutral duration semantic of ADR-034. */
  totalDurationMs: number
}

/**
 * One priced request in a stored history, whatever the engine version wrote
 * it as: a 1.x assistant message, a 2.x step (`assistant` row) or a 2.x
 * compaction's own request.
 */
export interface OpencodeUsageRow {
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: MessageTokens
  /** False for a request whose prompt is not the conversation's context (a compaction's). */
  context: boolean
}

/**
 * Rebuild a session's accounting from the messages opencode stored for it.
 *
 * A stored message is priced by the same rule as a live one (ADR-071 §2).
 * Unlike a live own message it carries its OWN providerID/modelID, so the
 * model it actually ran on prices it, not whatever the session is set to now;
 * `fallbackModel` covers the message that carries neither.
 *
 * `listMessages` returns only the session's own messages — a child (subagent)
 * session's messages live under a distinct id — so there is nothing to filter
 * out here, mirroring the live overlay's own child exclusion.
 */
export function opencodeHistorySeed(
  storedMessages: StoredMessage[],
  fallbackModel: { providerID: string; modelID: string }
): OpencodeHistorySeed {
  const rows: OpencodeUsageRow[] = []
  for (const stored of storedMessages) {
    const info = stored.info
    if (!info || info.role !== 'assistant') continue
    rows.push({
      providerID: info.providerID,
      modelID: info.modelID,
      cost: info.cost,
      tokens: info.tokens,
      context: true
    })
  }
  return seedFromUsageRows(rows, fallbackModel, computeStoredDurationMs(storedMessages))
}

/** What a 2.x cold load knows beyond the session's own rows. */
export interface OpencodeV2SeedExtras {
  /** The rows of every child session its subagent calls ran (nested ones too). */
  children?: Iterable<readonly Session_Message_Info[]>
  /** `GET /api/session/:id` `cost`/`tokens`: opencode's cumulative for the session. */
  sessionTotals?: { cost: number; tokens: TokenUsage_Info }
}

/**
 * {@link opencodeHistorySeed} for opencode 2.x rows (ADR-093 S4). ONE rule,
 * the same as the live mapper's outputs and as Claude's status line (which
 * folds subagent transcripts into the session, `session-history.ts`
 * `foldSubagentCosts`): every request the chat caused counts —
 * - each step (`assistant` row) of the session and of its children;
 * - each compaction's own request (opencode bills it to the session);
 * - the session's remainder: its cumulative (`sessionTotals`) minus the above,
 *   which is opencode's title generation (`session.usage.recorded
 *   {source:'title'}` reaches the cumulative and nothing else), priced on the
 *   fallback model.
 * Only the own session's steps move the context meter.
 */
export function opencodeV2HistorySeed(
  messages: readonly Session_Message_Info[],
  fallbackModel: { providerID: string; modelID: string },
  extras: OpencodeV2SeedExtras = {}
): OpencodeHistorySeed {
  const rows: OpencodeUsageRow[] = []
  const usageRows = (list: readonly Session_Message_Info[], context: boolean) => {
    for (const row of list) {
      if (row.type === 'assistant')
        rows.push({
          providerID: row.model.providerID,
          modelID: row.model.id,
          cost: row.cost,
          tokens: row.tokens,
          context
        })
      else if (row.type === 'compaction' && row.status !== 'running')
        rows.push({
          providerID: row.status === 'completed' ? row.model?.providerID : undefined,
          modelID: row.status === 'completed' ? row.model?.id : undefined,
          cost: row.cost,
          tokens: row.tokens,
          context: false
        })
    }
  }
  usageRows(messages, true)
  const own = [...rows]
  for (const child of extras.children ?? []) usageRows(child, false)
  const remainder = extras.sessionTotals ? sessionRemainder(extras.sessionTotals, own) : null
  if (remainder) rows.push(remainder)
  return seedFromUsageRows(rows, fallbackModel, opencodeV2ActiveDurationMs(messages))
}

/** The part of the session's cumulative no own row carries (positive fields only), or null. */
function sessionRemainder(
  totals: { cost: number; tokens: TokenUsage_Info },
  own: readonly OpencodeUsageRow[]
): OpencodeUsageRow | null {
  const sum = (pick: (t: MessageTokens) => number | undefined) =>
    own.reduce((total, row) => total + (row.tokens ? (pick(row.tokens) ?? 0) : 0), 0)
  const left = (x: number) => (x > 0 ? x : 0)
  const cost = totals.cost - own.reduce((total, row) => total + (row.cost ?? 0), 0)
  const tokens = {
    input: left(totals.tokens.input - sum((t) => t.input)),
    output: left(totals.tokens.output - sum((t) => t.output)),
    reasoning: left(totals.tokens.reasoning - sum((t) => t.reasoning)),
    cache: {
      read: left(totals.tokens.cache.read - sum((t) => t.cache?.read)),
      write: left(totals.tokens.cache.write - sum((t) => t.cache?.write))
    }
  }
  const any =
    tokens.input || tokens.output || tokens.reasoning || tokens.cache.read || tokens.cache.write
  if (!(cost > 1e-9) && !any) return null
  return { cost: cost > 1e-9 ? cost : 0, tokens, context: false }
}

/**
 * Accumulated ACTIVE time of a 2.x history (ADR-034's semantic, as
 * `computeStoredDurationMs` for 1.x): opencode writes an `idle` row when an
 * execution ends, so a turn runs from the first row after the previous idle
 * (its user prompt, or a compaction) to its idle. A turn with no idle yet (in
 * flight, or the engine shut down mid-turn) ends at its last completed step.
 */
export function opencodeV2ActiveDurationMs(messages: readonly Session_Message_Info[]): number {
  let total = 0
  let start: number | null = null
  let lastEnd: number | null = null
  for (const row of messages) {
    if (row.type === 'idle') {
      if (start !== null && row.time.created > start) total += row.time.created - start
      start = null
      lastEnd = null
      continue
    }
    if (row.type !== 'user' && row.type !== 'assistant' && row.type !== 'compaction') continue
    start ??= row.time.created
    if (row.type === 'assistant') lastEnd = row.time.completed ?? row.time.created
  }
  if (start !== null && lastEnd !== null && lastEnd > start) total += lastEnd - start
  return total
}

function seedFromUsageRows(
  rows: readonly OpencodeUsageRow[],
  fallbackModel: { providerID: string; modelID: string },
  totalDurationMs: number
): OpencodeHistorySeed {
  const costInputs: OpencodeCostInputs[] = []
  const modelCosts = new Map<string, number>()
  const tokens: OpencodeHistoryTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  let engineReportedCostUsd = 0
  let lastContextLength = 0

  for (const info of rows) {
    if (!info.cost && !info.tokens) continue

    const engineCost = typeof info.cost === 'number' ? info.cost : null
    engineReportedCostUsd += engineCost ?? 0
    const modelId = info.modelID ?? fallbackModel.modelID
    const inputs = opencodeCostInputs(
      info.providerID ?? fallbackModel.providerID,
      modelId,
      info.tokens,
      engineCost
    )
    costInputs.push(inputs)
    const displayCostUsd = resolveOpencodeCosts(inputs).displayCostUsd
    if (displayCostUsd !== null) {
      modelCosts.set(modelId, (modelCosts.get(modelId) ?? 0) + displayCostUsd)
    }

    const t = info.tokens
    if (!t) continue
    tokens.input += t.input ?? 0
    // Reasoning tokens are billed as output — the same fold recordTurnUsage
    // and the live status line apply, so the two agree.
    tokens.output += (t.output ?? 0) + (t.reasoning ?? 0)
    tokens.cacheWrite += t.cache?.write ?? 0
    tokens.cacheRead += t.cache?.read ?? 0
    // Context used is the LATEST turn's prompt, not the cumulative sum — same
    // definition the live `result` handler applies.
    if (info.context) lastContextLength = (t.input ?? 0) + (t.cache?.read ?? 0)
  }

  return {
    costInputs,
    engineReportedCostUsd,
    modelCosts,
    tokens,
    lastContextLength,
    totalDurationMs
  }
}

/**
 * The status line a reopened opencode session shows before anything spawns.
 *
 * Field for field what `OpencodeSession.buildStatusLine` emits on a resume
 * whose live overlay is still empty — the two share the seed above — except
 * that nothing is in flight here, so `turnStartedAtMs` is null.
 *
 * `dispatchedCosts` are the durable cross-engine rows for this session
 * (ADR-034): a reopened session has no `BaseSession` to seed them into, and
 * they are breakdown-only, never folded into the headline.
 */
export function opencodeHistoryStatusLine(
  storedMessages: StoredMessage[],
  fallbackModel: { providerID: string; modelID: string },
  dispatchedCosts: ModelCostEntry[] = []
): StatusLineData {
  return statusLineFromSeed(
    opencodeHistorySeed(storedMessages, fallbackModel),
    fallbackModel,
    dispatchedCosts
  )
}

/** {@link opencodeHistoryStatusLine} for opencode 2.x rows. */
export function opencodeV2HistoryStatusLine(
  messages: readonly Session_Message_Info[],
  fallbackModel: { providerID: string; modelID: string },
  dispatchedCosts: ModelCostEntry[] = [],
  extras: OpencodeV2SeedExtras = {}
): StatusLineData {
  return statusLineFromSeed(
    opencodeV2HistorySeed(messages, fallbackModel, extras),
    fallbackModel,
    dispatchedCosts
  )
}

function statusLineFromSeed(
  seed: OpencodeHistorySeed,
  fallbackModel: { providerID: string; modelID: string },
  dispatchedCosts: ModelCostEntry[]
): StatusLineData {
  const costs = totalCosts(seed.costInputs.map(resolveOpencodeCosts))
  const ctx = getOpencodeModelContextWindow(fallbackModel.providerID, fallbackModel.modelID)
  const usedPercentage =
    ctx > 0 && seed.lastContextLength > 0 ? Math.round((seed.lastContextLength / ctx) * 100) : null
  const cachedTokens = seed.tokens.cacheRead + seed.tokens.cacheWrite

  return {
    totalCostUsd: costs.displayCostUsd,
    billedCostUsd: costs.billedCostUsd,
    ...(costs.unknownMessages > 0 ? { unknownCostMessages: costs.unknownMessages } : {}),
    totalDurationMs: seed.totalDurationMs,
    totalApiDurationMs: 0,
    totalInputTokens: seed.tokens.input,
    totalOutputTokens: seed.tokens.output,
    cachedTokens,
    totalTokens: seed.tokens.input + seed.tokens.output + cachedTokens,
    contextWindow: { used: seed.lastContextLength, size: ctx },
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? 100 - usedPercentage : null,
    turnStartedAtMs: null,
    modelCosts: [
      ...[...seed.modelCosts.entries()].map(([modelId, costUsd]) => ({
        engineId: 'opencode' as const,
        modelId,
        costUsd
      })),
      ...dispatchedCosts
    ]
  }
}

/**
 * The model a cold load prices its unattributed messages under: the last one
 * the session actually used. A session object has its own current model to
 * fall back on; a history read has only the transcript.
 */
export function lastOpencodeModel(storedMessages: StoredMessage[]): {
  providerID: string
  modelID: string
} {
  for (let i = storedMessages.length - 1; i >= 0; i--) {
    const info = storedMessages[i]?.info
    if (info?.role !== 'assistant' || !info.modelID) continue
    return { providerID: info.providerID ?? '', modelID: info.modelID }
  }
  return { providerID: '', modelID: '' }
}

/** {@link lastOpencodeModel} for opencode 2.x rows: the last step's model. */
export function lastOpencodeV2Model(messages: readonly Session_Message_Info[]): {
  providerID: string
  modelID: string
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]
    if (row?.type === 'assistant')
      return { providerID: row.model.providerID, modelID: row.model.id }
  }
  return { providerID: '', modelID: '' }
}
