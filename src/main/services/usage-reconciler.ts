/**
 * Backfill reconciler — Phase 7 Pass 2.
 *
 * Imports usage that happened OUTSIDE ClaudeUI (terminal `claude`/`opencode`, or
 * another client) into the usage_event DB so the dashboard is complete. Runs on
 * startup + periodically, and is also triggered near-live post-result.
 *
 *   Claude   → reuses block-usage's JSONL parse (ParsedEntry, the SAME parse +
 *              calculateCostFromTokens) → insertUsageEvents(source 'backfill').
 *              Dedup by message_id: live opencode rows + Claude reconciled rows
 *              never collide (different message_id namespaces); re-runs are
 *              idempotent via ON CONFLICT(message_id) DO NOTHING.
 *   opencode → via the API (GET /session + /session/{id}/message) against the
 *              running per-cwd server — NOT by parsing the on-disk store.
 *              Best-effort: skipped if no server is up.
 *
 * Failures are swallowed (logged) — reconcile is advisory and must never throw
 * into the caller.
 */

import { v4 as uuid } from 'uuid'
import { insertUsageEvents, type UsageEventRow } from './db'
import { blockUsageService } from './block-usage'
import { equivalentCostUsd } from '../../shared/pricing'
import { logger } from './logger'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'

/** How often the periodic reconcile runs. */
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

class UsageReconciler {
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  /**
   * Start periodic reconciliation. The startup reconcile + recalc is driven by
   * session.ipc (reconcileAll().finally(recalculate)); here the PERIODIC tick
   * reconciles then refreshes the dashboard so out-of-tool usage (esp. opencode,
   * which block-usage's JSONL scan never sees) rolls into daily_usage + the
   * per-engine breakdown. recalculate() is concurrency-guarded internally.
   */
  start(): void {
    if (this.intervalTimer) return
    this.intervalTimer = setInterval(() => {
      this.reconcileAll()
        .catch(() => {})
        .finally(() => {
          blockUsageService.recalculate().catch(() => {})
        })
    }, RECONCILE_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  /** Reconcile both engines. Guarded against concurrent runs. */
  async reconcileAll(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.reconcileClaude()
      await this.reconcileOpencode()
    } finally {
      this.running = false
    }
  }

  /**
   * Reconcile Claude usage from the JSONL transcripts (block-usage's parse).
   * Each ParsedEntry → one usage_event (source 'backfill', dedup by message_id).
   */
  async reconcileClaude(): Promise<void> {
    try {
      const entries = await blockUsageService.getClaudeEntriesForReconcile()
      if (entries.length === 0) return

      const rows: UsageEventRow[] = []
      for (const e of entries) {
        if (!e.messageId) continue // dedup key required; skip if missing
        const equiv = equivalentCostUsd('anthropic', e.model, {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          // The live stream / JSONL ParsedEntry does not split the 1h cache TTL
          // out separately here (block-usage already priced it into costUsd via
          // calculateCostFromTokens). For the equiv_cost column we treat all
          // cache writes as 5m; engine_cost carries block-usage's exact figure.
          cacheWriteTokens: e.cacheCreationTokens,
          cacheWrite1hTokens: 0,
          cacheReadTokens: e.cacheReadTokens
        })
        rows.push({
          id: uuid(),
          ts: e.timestamp,
          engineId: 'claude',
          vendorId: 'anthropic',
          accountId: null,
          accountUuid: e.accountUuid,
          modelId: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheWriteTokens: e.cacheCreationTokens,
          cacheWrite1hTokens: 0,
          cacheReadTokens: e.cacheReadTokens,
          // equiv_cost from the pricing table when priced; otherwise fall back to
          // block-usage's calculateCostFromTokens value (e.costUsd).
          equivCostUsd: equiv ?? e.costUsd,
          engineCostUsd: e.costUsd,
          sessionId: null,
          messageId: e.messageId,
          source: 'backfill'
        })
      }

      insertUsageEvents(rows)
      logger.debug('UsageReconciler', `Claude reconcile: ${rows.length} entries upserted`)
    } catch (err) {
      logger.warn('UsageReconciler', `Claude reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Reconcile opencode usage via the API. Best-effort — acquires the per-cwd
   * server (PERSISTED_SESSIONS_DIR, like model-discovery), lists sessions, then
   * lists each session's messages and imports assistant messages with tokens.
   */
  async reconcileOpencode(): Promise<void> {
    let acquired = false
    try {
      const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
      acquired = true
      const client = new OpencodeClient(conn.baseUrl, conn.authHeader)

      const sessions = await client.listSessions().catch(() => [])
      if (sessions.length === 0) return

      const rows: UsageEventRow[] = []
      for (const session of sessions) {
        const messages = await client.listMessages(session.id).catch(() => [])
        for (const m of messages) {
          const row = this.opencodeMessageToRow(m.info, session.id)
          if (row) rows.push(row)
        }
      }

      if (rows.length > 0) {
        insertUsageEvents(rows)
        logger.debug('UsageReconciler', `opencode reconcile: ${rows.length} messages upserted`)
      }
    } catch (err) {
      logger.debug('UsageReconciler', `opencode reconcile skipped: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (acquired) opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  }

  /**
   * Map an opencode message `info` object to a usage_event row.
   * Returns null for non-assistant messages or messages without a stable id.
   * Cost = info.cost (engine-reported); equiv via the pricing table.
   */
  private opencodeMessageToRow(
    info: Record<string, unknown> | undefined,
    sessionId: string
  ): UsageEventRow | null {
    if (!info) return null
    const role = info.role as string | undefined
    if (role !== 'assistant') return null
    const messageId = info.id as string | undefined
    if (!messageId) return null

    // providerID/modelID — opencode messages carry these on info.
    const providerID = (info.providerID as string | undefined) ?? 'opencode'
    const modelID = (info.modelID as string | undefined) ?? 'unknown'

    const tokens = info.tokens as
      | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      | undefined
    const input = tokens?.input ?? 0
    const output = tokens?.output ?? 0
    const cacheWrite = tokens?.cache?.write ?? 0
    const cacheRead = tokens?.cache?.read ?? 0
    const engineCost = typeof info.cost === 'number' ? info.cost : null

    // Timestamp: opencode info.time.created is epoch ms (best-effort).
    const time = info.time as { created?: number } | undefined
    const ts = typeof time?.created === 'number' ? time.created : Date.now()

    const equiv = equivalentCostUsd(providerID, modelID, {
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      cacheReadTokens: cacheRead
    })

    return {
      id: uuid(),
      ts,
      engineId: 'opencode',
      vendorId: providerID,
      accountId: null,
      accountUuid: null,
      modelId: modelID,
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      cacheReadTokens: cacheRead,
      equivCostUsd: equiv,
      engineCostUsd: engineCost,
      sessionId,
      messageId,
      source: 'backfill'
    }
  }
}

export const usageReconciler = new UsageReconciler()
