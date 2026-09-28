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
  JudgeWireError,
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

/**
 * Rate-limit timing for a 429 message: the `retry-after` header, and the
 * ChatGPT backend's `resets_at` (epoch seconds, top-level or under `error`).
 */
function rateLimitHint(res: Response, excerpt: string): string {
  const hints: string[] = []
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) hints.push(`retry-after ${retryAfter}`)
  try {
    const parsed = JSON.parse(excerpt) as Record<string, unknown> | null
    const nested =
      parsed && typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : {}
    const resetsAt = nested.resets_at ?? parsed?.resets_at
    if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
      hints.push(`resets at ${new Date(resetsAt * 1000).toISOString()}`)
    }
  } catch {
    // Not JSON (or truncated at the excerpt limit) — the header is all there is.
  }
  return hints.length ? ` (${hints.join(', ')})` : ''
}

/** Prefix a failure with the route's label, keeping its status/code. */
function labelled(route: ResolvedJudgeRoute, err: unknown): JudgeWireError {
  return new JudgeWireError(`${route.label}: ${errorMessage(err)}`, {
    ...(err instanceof JudgeWireError && err.status !== undefined ? { status: err.status } : {}),
    ...(err instanceof JudgeWireError && err.code !== undefined ? { code: err.code } : {})
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

  const call = async (req: JudgeRequest): Promise<string> => {
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

      const excerpt = scrub(await readExcerpt(res), route.headers)
      if (res.status === 401 && route.reauthorize && !reauthorized) {
        reauthorized = true
        // A refresh that throws is a refresh that failed: the labelled 401
        // below surfaces, never the refresh path's raw error.
        let fresh: ResolvedJudgeRoute | null = null
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
      throw labelled(
        route,
        new JudgeWireError(`HTTP ${res.status}${hint}: ${excerpt || '(empty body)'}`, {
          status: res.status
        })
      )
    }

    if (!res.body) throw labelled(route, new JudgeWireError('response has no body'))
    // A holder, not a `let`: the reader writes it from a callback.
    const seen: { usage: JudgeUsageSample | null } = { usage: null }
    const readOpts = {
      ...(req.stopSequences ? { stopSequences: req.stopSequences } : {}),
      maxChars: (req.maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN_BUDGET,
      onUsageSeen: (u: JudgeUsageSample) => {
        seen.usage = u
      }
    }
    const frames = readSseFrames(res.body)
    let text: string
    try {
      const out =
        route.wire === 'chat'
          ? await readChatStream(frames, readOpts)
          : await readResponsesStream(frames, readOpts)
      text = out.text
    } catch (err) {
      // The provider billed whatever it reported, even when the call failed.
      if (seen.usage) reportUsage(seen.usage, route)
      if (req.signal?.aborted) throw err
      throw labelled(route, err)
    }
    if (seen.usage) reportUsage(seen.usage, route)
    return text
  }

  return async (req: JudgeRequest): Promise<string> => {
    try {
      return await call(req)
    } catch (err) {
      // Whatever the abort surfaced as (fetch's AbortError, a body stream that
      // errored mid-read), it reads as one message.
      if (req.signal?.aborted) throw new Error(ABORTED_MESSAGE)
      throw err
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
