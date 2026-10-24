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
import { activeChatgptAccountId, chatgptAccountPlan } from './judge-accounts'
import { judgeCaptureEnabled, writeJudgeCapture } from './judge-capture'
import { coolingUntil, noteRateLimited } from './judge-cooldown'
import {
  JudgeRouteUnavailableError,
  judgeFailureSummary,
  judgeRouteKey,
  makeHttpJudgeTransport
} from './judge-http/transport'
import {
  JUDGE_EMPTY_REPLY_CODE,
  JUDGE_OFF_FORMAT_CODE,
  JUDGE_OVER_BUDGET_CODE,
  JudgeWireError,
  type JudgeRouteResult
} from './judge-http/types'
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
   * The ChatGPT vault account this judge pays with, read per call; undefined → the active account.
   * Only the fallback judge names one (`autoMode.fallbackJudgeAccount`). Read by the resolver for a
   * model that routes through the ChatGPT subscription; any other route ignores it.
   */
  chatgptAccountId?: () => string | undefined
  /**
   * Called with a user-facing sentence whenever the judge cannot answer: the
   * resolver's reason when the model has no route ClaudeUI can call, or a
   * failed call's {@link judgeFailureSummary} (a rate limit, an outage, a
   * network error). The call then fails, and `classify()` sends the action to
   * the human (§3: no fallback). May be called on every failure; the owner
   * shows its one banner for the first.
   *
   * NOT called for a {@link JudgeWireError} coded `JUDGE_OFF_FORMAT_CODE` or
   * `JUDGE_OVER_BUDGET_CODE` — in any mode, deliberately: the model answered and the route is
   * fine, so there is nothing to fix. The banner is latched once per session and its copy (“every
   * gated action will ask you… change the judge model”) is wrong for a per-reply event — one
   * overflow would burn the only banner and hide a later real outage. `JUDGE_EMPTY_REPLY_CODE` is
   * quiet only on `both` mode's stage-1 request, where it escalates; anywhere else an empty reply
   * may be a judge that never answers, and the banner says so. The throw still happens;
   * `classify()` decides what it means.
   */
  onUnavailable: (reason: string) => void
}

export function makeSessionJudgeTransport(opts: SessionJudgeOptions): JudgeTransport {
  const transport = makeHttpJudgeTransport({
    resolve: async () => {
      const account = opts.chatgptAccountId?.()
      const resolved = account
        ? await resolveJudgeRoute(opts.engine, opts.modelValue(), {}, { chatgptAccountId: account })
        : await resolveJudgeRoute(opts.engine, opts.modelValue())
      const result = restingRoute(resolved)
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
    // Judge-reply capture (diagnostics): the switch is read at the start of each call.
    shouldCapture: judgeCaptureEnabled,
    onCall: (call) =>
      writeJudgeCapture({
        ...call,
        engine: opts.engine,
        routingId: opts.routingId,
        sessionId: opts.sessionId()
      }),
    userAgent: `ClaudeUI/${hostAppVersion()}`
  })
  // A call that fails (HTTP 429, an outage, a network error) throws, and `classify()` turns the
  // throw into `unavailable` → the human. The owner's banner says why, once. Not reported here:
  // a missing route (`resolve` reported it), an abort (a stage timeout or a cancelled review,
  // which the call's own error already names, and which says nothing about the route), and the
  // "answered, but unusably" codes — an empty reply only on the escalating stage-1 request (the
  // model and route are fine, and the latched banner's copy is wrong for a per-reply event — see
  // the `onUnavailable` doc).
  return async (req) => {
    try {
      return await transport(req)
    } catch (err) {
      // A 429 that names its reset rests the route until then: later calls skip it without a
      // round trip (`resolve` above), and the pipeline's fallback judge takes them.
      if (
        err instanceof JudgeWireError &&
        err.status === 429 &&
        err.routeKey !== undefined &&
        err.retryAtMs !== undefined
      ) {
        noteRateLimited(err.routeKey, err.retryAtMs, Date.now())
      }
      // The "answered, but unusably" codes mean the model answered and the route is fine:
      // `both` mode's stage 1 escalates on them, so there is nothing for the human to fix and
      // no banner to show. An EMPTY reply is quiet only on that stage-1 request (the one that
      // names `allowedPrefixes`): elsewhere it can be a judge that never answers, which the
      // banner must name. Rethrown all the same — `classify()` is the one that decides.
      const answeredUnusably =
        err instanceof JudgeWireError &&
        (err.code === JUDGE_OFF_FORMAT_CODE ||
          err.code === JUDGE_OVER_BUDGET_CODE ||
          (err.code === JUDGE_EMPTY_REPLY_CODE && req.allowedPrefixes !== undefined))
      if (
        !answeredUnusably &&
        !(err instanceof JudgeRouteUnavailableError) &&
        !req.signal?.aborted
      ) {
        opts.onUnavailable(
          `${judgeFailureSummary(err instanceof Error ? err.message : String(err))}.`
        )
      }
      throw err
    }
  }
}

/**
 * A resolved route that a 429 rested (`judge-cooldown.ts`) comes back as not callable, with the
 * time it recovers in the reason — the same shape as a route the resolver could not build, so
 * `makeHttpJudgeTransport` throws its `JudgeRouteUnavailableError` and no request is sent.
 */
function restingRoute(result: JudgeRouteResult): JudgeRouteResult {
  if (!result.ok) return result
  const until = coolingUntil(judgeRouteKey(result.route), Date.now())
  if (until === undefined) return result
  const at = new Date(until).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    ok: false,
    code: 'rate-limited',
    reason: `${result.route.label}: usage limit, resting until ${at}.`
  }
}

/**
 * The one `session:error` a session shows when its judge model has no route:
 * the resolver's reason (already an instruction), what happens meanwhile, and
 * where the judge picker is.
 */
export function judgeRouteUnavailableMessage(engine: JudgeEngine, reason: string): string {
  return (
    `Auto-mode can't judge here: ${reason} Every gated action will ask you instead. ` +
    `Change the judge model in Settings › Sessions & autonomy › Auto-mode judge (${engineMeta(engine).label}).`
  )
}

/**
 * The `session:error` a session shows when its primary judge cannot answer but a fallback judge
 * can: `cause` is the primary's failure as a sentence (a {@link judgeFailureSummary} clause with
 * its full stop, or the resolver's `reason`), `fallbackLabel` the fallback model's route label.
 * Unlike {@link judgeRouteUnavailableMessage} nothing is asked of the user — it says where the
 * judging went and where to change it.
 */
export function judgeFallbackMessage(
  engine: JudgeEngine,
  cause: string,
  fallbackLabel: string
): string {
  return (
    `Auto-mode judge unavailable: ${cause} ${fallbackLabel} is judging instead until it recovers. ` +
    `Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (${engineMeta(engine).label}).`
  )
}

/**
 * The fallback judge model in effect: `autoMode.fallbackJudgeModel` trimmed, or `undefined` when
 * it is blank or names the model already judging (`primary`, the value `modelValue` would hand
 * the primary transport) — a fallback that is the primary can only repeat its failure. An owner
 * additionally drops a model its catalog no longer lists before it asks.
 *
 * The one exception is a fallback ACCOUNT (`autoMode.fallbackJudgeAccount`): the same model on a
 * different ChatGPT account is a different route (its own usage limit), so it is kept when
 * `fallbackAccount` is set and is not `activeAccount` — the account the primary pays with, by
 * default the last one `judge-accounts.ts` read (an owner refreshes it in its async
 * `judgeAvailable`). Same model, same account stays dropped. Unknown (`null`) counts as different.
 */
export function fallbackJudgeModelFor(
  configured: string | undefined,
  primary: string,
  fallbackAccount?: string,
  activeAccount: string | null = activeChatgptAccountId()
): string | undefined {
  const model = configured?.trim()
  if (!model) return undefined
  if (model !== primary.trim()) return model
  const account = fallbackJudgeAccountFor(fallbackAccount)
  return account && account !== activeAccount ? model : undefined
}

/** `autoMode.fallbackJudgeAccount` trimmed, or `undefined` when unset or blank. */
export function fallbackJudgeAccountFor(configured: string | undefined): string | undefined {
  return configured?.trim() || undefined
}

/**
 * The fallback judge as a banner and a log line name it: the model value as the user picked it,
 * plus — when the fallback runs on a named ChatGPT account — that account's plan type
 * (`openai/gpt-6-luna (Business account)`). The plan, never an email: it says which subscription
 * is judging without naming a person. A plan the snapshot (`judge-accounts.ts`) has not learned
 * reads `(ChatGPT account)`.
 */
export function fallbackJudgeLabel(model: string, account: string | undefined): string {
  if (!account) return model
  const plan = chatgptAccountPlan(account)
  return `${model} (${plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} ` : 'ChatGPT '}account)`
}

/**
 * The pipeline's fallback judge (`JudgePipelineHooks.fallbackJudgeTransport`): a session judge
 * transport pinned to `model`, labelled by {@link fallbackJudgeLabel}. `make` defaults to
 * {@link makeSessionJudgeTransport}; a test injects a scripted one. `opts.chatgptAccountId`
 * names the ChatGPT account it pays with.
 */
export function makeFallbackJudge(
  model: string,
  opts: Omit<SessionJudgeOptions, 'modelValue'>,
  make: (opts: SessionJudgeOptions) => JudgeTransport = makeSessionJudgeTransport
): { transport: JudgeTransport; label: string } {
  return {
    transport: make({ ...opts, modelValue: () => model }),
    label: fallbackJudgeLabel(model, opts.chatgptAccountId?.())
  }
}

/**
 * The one banner an owner shows when its PRIMARY judge cannot answer: with a fallback judge in
 * effect it says the fallback is judging ({@link judgeFallbackMessage}, named by its
 * {@link fallbackJudgeLabel}); without, that every gated action asks the user
 * ({@link judgeRouteUnavailableMessage}).
 */
export function judgeUnavailableMessage(
  engine: JudgeEngine,
  reason: string,
  fallbackLabel: string | undefined
): string {
  return fallbackLabel
    ? judgeFallbackMessage(engine, reason, fallbackLabel)
    : judgeRouteUnavailableMessage(engine, reason)
}

/**
 * The one banner an owner shows when its FALLBACK judge cannot answer either (its own flag, apart
 * from the primary's): nothing is left to judge, so every gated action asks the user.
 */
export function fallbackUnavailableMessage(
  engine: JudgeEngine,
  fallbackLabel: string,
  reason: string
): string {
  return judgeRouteUnavailableMessage(engine, `fallback ${fallbackLabel}: ${reason}`)
}

/**
 * The one banner an owner shows when the CONFIGURED judge model is no longer in its catalog: the
 * human decides — unless a fallback judge is in effect, which then judges, as the banner says.
 */
export function staleJudgeModelMessage(
  engine: JudgeEngine,
  configured: string,
  fallbackLabel: string | undefined
): string {
  const where =
    `Change ${fallbackLabel ? 'the judge models' : 'it'} in Settings › Sessions & autonomy › ` +
    `Auto-mode judge (${engineMeta(engine).label}).`
  return fallbackLabel
    ? `Auto-mode judge model "${configured}" is no longer available — ${fallbackLabel} is judging instead. ${where}`
    : `Auto-mode judge model "${configured}" is no longer available — every gated action will ask you instead. ${where}`
}
