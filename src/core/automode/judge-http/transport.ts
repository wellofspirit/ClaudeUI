/**
 * `makeHttpJudgeTransport` — the auto-mode {@link JudgeTransport} for opencode
 * and pi sessions, calling the judge model directly over HTTP (ADR-081).
 *
 * Per call: resolve the route (keys rotate, tokens refresh), POST one streamed
 * request, read the stream with the route's wire reader, report usage, return
 * the completion text. Every failure throws, which `classify()` turns into
 * `unavailable` → the human decides. There are no retries except one: an HTTP
 * 401 on a route that can `reauthorize` (ChatGPT) retries once with a freshly
 * refreshed token.
 *
 * Credential hygiene: the route's headers carry the key or token, so nothing
 * here logs, and every thrown message is built from the route's
 * credential-free `label`, the response body, and our own copy. The body
 * excerpt is additionally scrubbed of every long token that appears in a
 * request header value, in case a server (or a debugging proxy) echoes the
 * request back.
 */

import type { JudgeRequest, JudgeTransport } from '../classifier'
import { judgeCacheKey } from './caps'
import { pickJudgeFetch } from './net'
import { readSseFrames } from './sse'
import { buildChatBody, readChatStream } from './wire-chat'
import { buildResponsesBody, readResponsesStream } from './wire-responses'
import {
  JUDGE_CAPTURE_REASONING_MAX_CHARS,
  JudgeWireError,
  type JudgeCallCapture,
  type JudgeRouteResult,
  type JudgeRouteUnavailableCode,
  type JudgeUsageSample,
  type ResolvedJudgeRoute
} from './types'

export interface HttpJudgeTransportOptions {
  /** Called per judge call (rotation, refresh). */
  resolve: () => Promise<JudgeRouteResult>
  /** Called with each response's usage. A throw here is swallowed — it must never fail the verdict. */
  onUsage?: (usage: JudgeUsageSample, route: ResolvedJudgeRoute) => void
  /** Default: {@link pickJudgeFetch}. */
  fetchImpl?: typeof fetch
  /** Default 'ClaudeUI'. A route header of the same name wins. */
  userAgent?: string
  /**
   * Judge-reply capture (diagnostics). Read once at the start of each call: false/absent (or
   * no {@link onCall}) means nothing is collected and the call runs exactly as without capture.
   */
  shouldCapture?: () => boolean
  /**
   * Called once per capturing call that reached `fetch` — success, non-2xx (the final attempt),
   * wire error or abort — never for a call whose route did not resolve. A throw is swallowed.
   * It must not block: the verdict never waits on it.
   */
  onCall?: (record: JudgeCallCapture) => void
}

/** What one capturing call collects on the way; turned into a {@link JudgeCallCapture} at its end. */
interface CallTrace {
  startedAt: number
  /** The route of the latest attempt (a re-authorized 401 retry replaces it). */
  route: ResolvedJudgeRoute | null
  /** A request was actually sent. */
  fetched: boolean
  status?: number
  usage: JudgeUsageSample | null
  finish?: 'stop' | 'length'
  text?: string
  raw: string
  reasoning: string
  reasoningTruncated: boolean
}

/** The judge model has no route ClaudeUI can call (ADR-081 §3: no fallback). */
export class JudgeRouteUnavailableError extends Error {
  readonly code: JudgeRouteUnavailableCode
  /** User-facing copy, from the resolver. */
  readonly reason: string

  constructor(code: JudgeRouteUnavailableCode, reason: string) {
    super(`auto-mode judge route unavailable (${code}): ${reason}`)
    this.name = 'JudgeRouteUnavailableError'
    this.code = code
    this.reason = reason
  }
}

/** Default output budget when a request names none — `STAGE2_MAX_TOKENS`. */
const DEFAULT_MAX_TOKENS = 8192
/** Characters of text allowed per requested token before the call is aborted. */
const CHARS_PER_TOKEN_BUDGET = 16
/** How much of a non-2xx body goes into the error message. */
const ERROR_BODY_EXCERPT_BYTES = 2048
/** Header-value tokens at least this long are scrubbed from error excerpts. */
const SCRUB_MIN_LENGTH = 16

const ABORTED_MESSAGE = 'auto-mode judge aborted'

/**
 * Read at most {@link ERROR_BODY_EXCERPT_BYTES} of a response body as text and
 * release the rest. Never throws: an unreadable body is an empty excerpt.
 */
async function readExcerpt(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < ERROR_BODY_EXCERPT_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    // A body that dies mid-read still yields what arrived.
  } finally {
    reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_EXCERPT_BYTES)).trim()
}

/** Remove every long token of every request header value from `text`. */
function scrub(text: string, headers: Readonly<Record<string, string>>): string {
  let out = text
  for (const value of Object.values(headers)) {
    for (const token of [value, ...value.split(/\s+/)]) {
      if (token.length >= SCRUB_MIN_LENGTH) out = out.split(token).join('[redacted]')
    }
  }
  return out
}

/** The ChatGPT backend's `resets_at` (epoch seconds, top-level or under `error`), when the body carries one. */
function resetsAtSeconds(excerpt: string): number | undefined {
  try {
    const parsed = JSON.parse(excerpt) as Record<string, unknown> | null
    const nested =
      parsed && typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : {}
    const resetsAt = nested.resets_at ?? parsed?.resets_at
    return typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : undefined
  } catch {
    // Not JSON (or truncated at the excerpt limit) — the header is all there is.
    return undefined
  }
}

/**
 * Rate-limit timing for a 429 message: the `retry-after` header, and the
 * ChatGPT backend's `resets_at`.
 */
function rateLimitHint(res: Response, excerpt: string): string {
  const hints: string[] = []
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) hints.push(`retry-after ${retryAfter}`)
  const resetsAt = resetsAtSeconds(excerpt)
  if (resetsAt !== undefined) hints.push(`resets at ${new Date(resetsAt * 1000).toISOString()}`)
  return hints.length ? ` (${hints.join(', ')})` : ''
}

/**
 * When a 429 says the route recovers, epoch ms: the body's `resets_at` (a usage limit's reset —
 * the authority when both are present, since `retry-after` then names a shorter, retry-too-soon
 * interval), else `retry-after` as delta-seconds or an HTTP date. Undefined when the response
 * names no time, or one that is not a usable number.
 */
export function rateLimitRetryAtMs(
  res: Response,
  excerpt: string,
  now: number
): number | undefined {
  const resetsAt = resetsAtSeconds(excerpt)
  if (resetsAt !== undefined) return resetsAt * 1000
  const retryAfter = res.headers.get('retry-after')?.trim()
  if (!retryAfter) return undefined
  if (/^\d+(\.\d+)?$/.test(retryAfter)) return now + Number(retryAfter) * 1000
  const at = Date.parse(retryAfter)
  return Number.isFinite(at) ? at : undefined
}

/**
 * The key one route's rate-limit cooldown is filed under (`judge-cooldown.ts`): the route's
 * credential-free label (provider and model) and the account that pays for it, so two accounts
 * on one model rest independently.
 */
export function judgeRouteKey(route: ResolvedJudgeRoute): string {
  return `${route.label}|${route.account.accountKey}`
}

/** Prefix a failure with the route's label, keeping its status/code/recovery time, and name the route. */
function labelled(route: ResolvedJudgeRoute, err: unknown): JudgeWireError {
  const wire = err instanceof JudgeWireError ? err : undefined
  return new JudgeWireError(`${route.label}: ${errorMessage(err)}`, {
    ...(wire?.status !== undefined ? { status: wire.status } : {}),
    ...(wire?.code !== undefined ? { code: wire.code } : {}),
    ...(wire?.retryAtMs !== undefined ? { retryAtMs: wire.retryAtMs } : {}),
    routeKey: judgeRouteKey(route)
  })
}

export function makeHttpJudgeTransport(opts: HttpJudgeTransportOptions): JudgeTransport {
  const userAgent = opts.userAgent ?? 'ClaudeUI'

  const reportUsage = (usage: JudgeUsageSample, route: ResolvedJudgeRoute): void => {
    try {
      opts.onUsage?.(usage, route)
    } catch {
      // A usage-recording failure must never fail the verdict.
    }
  }

  /** Header names are lower-cased so a route header replaces ours instead of doubling it. */
  const headersFor = (route: ResolvedJudgeRoute, cacheKey: string): Record<string, string> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': userAgent
    }
    for (const [name, value] of Object.entries(route.headers)) headers[name.toLowerCase()] = value
    if (route.caps.affinityHeader) headers[route.caps.affinityHeader.toLowerCase()] = cacheKey
    return headers
  }

  const wantsCapture = (): boolean => {
    if (!opts.onCall) return false
    try {
      return opts.shouldCapture ? opts.shouldCapture() : true
    } catch {
      return false
    }
  }

  const reportCall = (build: () => JudgeCallCapture): void => {
    try {
      opts.onCall?.(build())
    } catch {
      // A capture failure must never fail the verdict.
    }
  }

  const call = async (req: JudgeRequest, trace: CallTrace | null): Promise<string> => {
    const resolved = await opts.resolve()
    if (!resolved.ok) throw new JudgeRouteUnavailableError(resolved.code, resolved.reason)
    const fetchImpl = opts.fetchImpl ?? (await pickJudgeFetch())
    const cacheKey = judgeCacheKey(req.system)

    let route = resolved.route
    let reauthorized = false
    let res: Response
    for (;;) {
      if (req.signal?.aborted) throw new Error(ABORTED_MESSAGE)
      const body =
        route.wire === 'chat' ? buildChatBody(route, req) : buildResponsesBody(route, req)
      if (trace) {
        trace.route = route
        trace.fetched = true
        delete trace.status
      }
      try {
        res = await fetchImpl(route.url, {
          method: 'POST',
          headers: headersFor(route, cacheKey),
          body: JSON.stringify(body),
          ...(req.signal ? { signal: req.signal } : {})
        })
      } catch (err) {
        if (req.signal?.aborted) throw err
        throw labelled(route, new JudgeWireError(`request failed: ${errorMessage(err)}`))
      }
      if (res.ok) break
      if (trace) trace.status = res.status

      const excerpt = scrub(await readExcerpt(res), route.headers)
      if (res.status === 401 && route.reauthorize && !reauthorized) {
        reauthorized = true
        // A refresh that throws is a refresh that failed: the labelled 401
        // below surfaces, never the refresh path's raw error.
        let fresh: ResolvedJudgeRoute | null
        try {
          fresh = await route.reauthorize()
        } catch {
          fresh = null
        }
        if (fresh) {
          route = fresh
          continue
        }
      }
      const hint = res.status === 429 ? rateLimitHint(res, excerpt) : ''
      const retryAtMs =
        res.status === 429 ? rateLimitRetryAtMs(res, excerpt, Date.now()) : undefined
      throw labelled(
        route,
        new JudgeWireError(`HTTP ${res.status}${hint}: ${excerpt || '(empty body)'}`, {
          status: res.status,
          ...(retryAtMs !== undefined ? { retryAtMs } : {})
        })
      )
    }

    if (!res.body) throw labelled(route, new JudgeWireError('response has no body'))
    // A holder, not a `let`: the reader writes it from a callback.
    const seen: { usage: JudgeUsageSample | null } = { usage: null }
    const readOpts = {
      ...(req.stopSequences ? { stopSequences: req.stopSequences } : {}),
      maxChars: maxCharsFor(req),
      onUsageSeen: (u: JudgeUsageSample) => {
        seen.usage = u
        if (trace) trace.usage = u
      },
      ...(trace
        ? {
            onDelta: (delta: string) => {
              trace.raw += delta
            },
            onReasoningDelta: (delta: string) => {
              const room = JUDGE_CAPTURE_REASONING_MAX_CHARS - trace.reasoning.length
              if (delta.length > room) trace.reasoningTruncated = true
              if (room > 0) trace.reasoning += delta.slice(0, room)
            }
          }
        : {})
    }
    const frames = readSseFrames(res.body)
    let text: string
    try {
      const out =
        route.wire === 'chat'
          ? await readChatStream(frames, readOpts)
          : await readResponsesStream(frames, readOpts)
      text = out.text
      if (trace) {
        trace.text = out.text
        trace.finish = out.finish
      }
    } catch (err) {
      // The provider billed whatever it reported, even when the call failed.
      if (seen.usage) reportUsage(seen.usage, route)
      if (req.signal?.aborted) throw err
      throw labelled(route, err)
    }
    if (seen.usage) reportUsage(seen.usage, route)
    return text
  }

  /** The finished capture record, from the trace and the call's outcome. */
  const captureOf = (
    req: JudgeRequest,
    trace: CallTrace,
    route: ResolvedJudgeRoute,
    failure: { error: unknown; aborted: boolean } | null
  ): JudgeCallCapture => {
    const system = req.system
    return {
      ts: new Date(trace.startedAt).toISOString(),
      durationMs: Date.now() - trace.startedAt,
      route: route.label,
      model: route.model,
      wire: route.wire,
      stage: req.stage ?? null,
      maxTokens: req.maxTokens ?? null,
      maxChars: maxCharsFor(req),
      stopSequences: req.stopSequences ? [...req.stopSequences] : [],
      systemHash: judgeCacheKey(system),
      system,
      user: req.user,
      outcome: failure ? (failure.aborted ? 'aborted' : 'error') : 'ok',
      ...(failure ? { error: errorMessage(failure.error) } : {}),
      ...(trace.status !== undefined ? { status: trace.status } : {}),
      ...(!failure && trace.finish ? { finish: trace.finish } : {}),
      ...(trace.usage ? { usage: trace.usage } : {}),
      ...(!failure && trace.text !== undefined ? { text: trace.text } : {}),
      raw: trace.raw,
      ...(trace.reasoning ? { reasoning: trace.reasoning } : {}),
      ...(trace.reasoningTruncated ? { reasoningTruncated: true as const } : {})
    }
  }

  return async (req: JudgeRequest): Promise<string> => {
    const trace: CallTrace | null = wantsCapture()
      ? {
          startedAt: Date.now(),
          route: null,
          fetched: false,
          usage: null,
          raw: '',
          reasoning: '',
          reasoningTruncated: false
        }
      : null
    let failure: { error: unknown; aborted: boolean } | null = null
    try {
      return await call(req, trace)
    } catch (err) {
      // Whatever the abort surfaced as (fetch's AbortError, a body stream that
      // errored mid-read), it reads as one message.
      const thrown = req.signal?.aborted ? new Error(ABORTED_MESSAGE, { cause: err }) : err
      failure = { error: thrown, aborted: req.signal?.aborted === true }
      throw thrown
    } finally {
      // One report per call that sent a request; a route that did not resolve sends none.
      const route = trace?.route
      if (trace && route && trace.fetched) reportCall(() => captureOf(req, trace, route, failure))
    }
  }
}

/** The client-side character budget of one request. */
function maxCharsFor(req: JudgeRequest): number {
  return (req.maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN_BUDGET
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Longest {@link judgeFailureSummary} result, in characters. */
const FAILURE_SUMMARY_MAX = 200
/** Where a failure message's response body starts: `: {...}`, `: [...]`, or an HTML page. */
const FAILURE_BODY_START = /: [{[<]/
/** {@link JudgeRouteUnavailableError}'s own prefix; the resolver's `reason` after it is the user-facing part. */
const ROUTE_UNAVAILABLE_PREFIX = /^auto-mode judge route unavailable \([a-z-]+\): /

/**
 * A judge failure's message as one short, user-facing clause: the route label,
 * the status and the rate-limit hint, without the response body.
 * `ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z): {"error":…}` →
 * `ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z)`. Cut at the first
 * `: {`, `: [` or `: <`, whitespace collapsed, capped at {@link FAILURE_SUMMARY_MAX},
 * no trailing full stop (the caller adds its own); never empty. The full text still goes to
 * the log.
 */
export function judgeFailureSummary(error: string): string {
  const message = error.replace(ROUTE_UNAVAILABLE_PREFIX, '')
  const cut = message.search(FAILURE_BODY_START)
  const head = (cut === -1 ? message : message.slice(0, cut)).replace(/\s+/g, ' ').trim()
  const capped =
    head.length > FAILURE_SUMMARY_MAX ? `${head.slice(0, FAILURE_SUMMARY_MAX - 1)}…` : head
  return capped.replace(/[.\s]+$/, '') || 'unknown error'
}
