/**
 * The auto-mode judge transport an opencode or pi session hands `classify()`
 * (ADR-081): ClaudeUI's own HTTP call to the judge model, routed per call by
 * `resolveJudgeRoute`, with every call's usage on the ledger as a `judge` row
 * attributed to the judged session.
 *
 * One factory for both engines so the two wirings cannot drift in what a judge
 * row carries. It holds no state: nothing to dispose, and a session builds a
 * fresh one whenever it wants one.
 */

import { engineMeta } from '../../shared/engine-meta'
import { hostAppVersion } from '../host'
import type { JudgeTransport } from './classifier'
import { makeHttpJudgeTransport } from './judge-http/transport'
import { resolveJudgeRoute, type JudgeEngine } from './judge-route'
import { recordJudgeUsage } from './judge-usage'

export interface SessionJudgeOptions {
  engine: JudgeEngine
  /**
   * The judge model value for THIS call — `autoMode.judgeModel`, else the
   * session's current model. Read per call, so a mid-session model switch
   * applies to the next judge call.
   */
  modelValue: () => string
  /** The judged session's engine id, read per call (it can arrive late). */
  sessionId: () => string | null
  /** The judged session's routing id — a judge row's `parentRoutingId`. */
  routingId: string
  /**
   * Called with the resolver's user-facing reason whenever the model has no
   * route ClaudeUI can call. The call then fails, and `classify()` sends the
   * action to the human (§3: no fallback).
   */
  onUnavailable: (reason: string) => void
}

export function makeSessionJudgeTransport(opts: SessionJudgeOptions): JudgeTransport {
  return makeHttpJudgeTransport({
    resolve: async () => {
      const result = await resolveJudgeRoute(opts.engine, opts.modelValue())
      if (!result.ok) opts.onUnavailable(result.reason)
      return result
    },
    onUsage: (sample, route) =>
      recordJudgeUsage(sample, {
        engineId: opts.engine,
        vendorId: route.account.vendorId,
        modelId: route.model,
        sessionId: opts.sessionId(),
        parentRoutingId: opts.routingId,
        accountId: route.account.accountId,
        accountKey: route.account.accountKey,
        accountLabel: route.account.accountLabel,
        billingType: route.account.billingType
      }),
    userAgent: `ClaudeUI/${hostAppVersion()}`
  })
}

/**
 * The one `session:error` a session shows when its judge model has no route:
 * the resolver's reason (already an instruction), what happens meanwhile, and
 * where the judge picker is.
 */
export function judgeRouteUnavailableMessage(engine: JudgeEngine, reason: string): string {
  return (
    `Auto-mode can't judge here: ${reason} Every gated action will ask you instead. ` +
    `Change the judge model in Settings → Engines → ${engineMeta(engine).label} → Auto mode.`
  )
}
