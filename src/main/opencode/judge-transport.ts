/**
 * judge-transport.ts
 *
 * Direct `JudgeTransport` over the patched opencode server's tool-less
 * `POST /judge/completion` route (ADR-037 P1, fork `wellofspirit/opencode`
 * branch `claudeui`).
 *
 * Why a second transport at all: the session-backed judge
 * (`OpencodeSession.makeJudgeFn`) has to create a real opencode session, patch
 * a deny-all ruleset onto it, prompt it, and delete it. That works, but it
 * leaves three defects the endpoint removes outright:
 *
 *  1. **Tool exposure.** The judge reads attacker-influenced transcript text.
 *     On a session, tool execution is a state we can only DENY — and opencode's
 *     instance-global "always" approvals outrank the session's deny-all
 *     ruleset (plan §7 Q5). The endpoint registers no tools and never consults
 *     the permission layer, so there is nothing to pierce.
 *  2. **`maxTokens` / `stopSequences` are advisory** on the session transport
 *     (the prompt API exposes neither — the standing ADR-023 deviation). The
 *     endpoint honours both for real.
 *  3. Three HTTP round-trips and a persisted session row per judge call.
 *
 * **Version-skew safety.** A ClaudeUI build can meet an *unpatched* opencode
 * (a user-supplied binary, a stale vendor dir). Detection is deliberately NOT
 * "POST and look for a 404": an unpatched opencode answers unknown paths from
 * the web-UI catch-all, which returns **200 text/html** when the UI is
 * embedded and **proxies the request to app.opencode.ai** when it is not
 * (`server/shared/ui.ts:78-107`, verified live against the unpatched 1.18.9
 * build). Probing by POST would therefore ship the judge prompt — transcript
 * included — to a third party. So we probe with `GET /doc` and only send a
 * prompt once the route is known to exist. The POST path still treats a 404 or
 * a non-JSON response as "endpoint gone" as a second line of defence.
 */

import type { JudgeRequest, JudgeTransport } from '../automode/classifier'
import { logger } from '../services/logger'

/** Where the judge endpoint lives on an opencode server. */
export interface JudgeEndpointTarget {
  baseUrl: string
  /** Pre-computed HTTP Basic header — the same server password every route uses. */
  authHeader: string
}

export interface JudgeModelRef {
  providerID: string
  modelID: string
}

/**
 * Per-session probe cache. `available === undefined` means "not probed yet";
 * a probe that could not reach the server leaves it undefined so a later call
 * re-probes rather than downgrading the whole session on one blip.
 */
export interface JudgeEndpointProbe {
  available?: boolean
}

export const JUDGE_COMPLETION_PATH = '/judge/completion'
const DOC_PATH = '/doc'

/** `/doc` is ~480 KB of OpenAPI; a substring test beats parsing it. */
const DOC_MARKER = `"${JUDGE_COMPLETION_PATH}"`

const PROBE_TIMEOUT_MS = 20_000
/** A judge call is one model turn; matches OpencodeClient's prompt-tier cap. */
const COMPLETION_TIMEOUT_MS = 15 * 60_000

/**
 * The server answered, but not as the judge endpoint — it is an older/unpatched
 * opencode. Distinct from a real failure: the caller falls back instead of
 * failing the classification closed.
 */
export class JudgeEndpointUnavailableError extends Error {
  constructor(reason: string) {
    super(`opencode judge endpoint unavailable: ${reason}`)
    this.name = 'JudgeEndpointUnavailableError'
  }
}

type FetchFn = typeof fetch

async function timedFetch(
  fetchImpl: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (timedOut) throw new Error(`opencode ${url} timed out after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Does this server expose `POST /judge/completion`? Reads the OpenAPI document,
 * which is local, authenticated, and carries no prompt payload.
 *
 * Throws only if `/doc` itself could not be read — the caller keeps the probe
 * cache untouched in that case.
 */
export async function probeJudgeEndpoint(
  target: JudgeEndpointTarget,
  fetchImpl: FetchFn = fetch
): Promise<boolean> {
  const res = await timedFetch(
    fetchImpl,
    `${target.baseUrl}${DOC_PATH}`,
    {
      method: 'GET',
      headers: { Authorization: target.authHeader, Accept: 'application/json' }
    },
    PROBE_TIMEOUT_MS
  )
  if (!res.ok) throw new Error(`opencode GET ${DOC_PATH} → ${res.status}`)
  const body = await res.text()
  return body.includes(DOC_MARKER)
}

/**
 * A `JudgeTransport` that posts straight to the patched endpoint.
 *
 * Throws {@link JudgeEndpointUnavailableError} when the response shows the
 * route is not there (404, or any non-JSON body — the UI catch-all). Every
 * other failure throws normally, so `classify()` fails closed to a human.
 */
export function makeDirectJudgeTransport(
  target: JudgeEndpointTarget,
  model: JudgeModelRef,
  fetchImpl: FetchFn = fetch
): JudgeTransport {
  return async (req: JudgeRequest): Promise<string> => {
    const url = `${target.baseUrl}${JUDGE_COMPLETION_PATH}`
    const body: Record<string, unknown> = {
      model: { providerID: model.providerID, modelID: model.modelID },
      system: req.system,
      user: req.user
    }
    // Honoured for real by the patched route — this is the whole point.
    if (req.maxTokens !== undefined) body.maxTokens = req.maxTokens
    if (req.stopSequences?.length) body.stopSequences = req.stopSequences

    const res = await timedFetch(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: {
          Authorization: target.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body)
      },
      COMPLETION_TIMEOUT_MS
    )

    // An unpatched server never answers this path as JSON: it serves the web UI
    // (text/html) or proxies upstream. Treat that as "route missing", not as a
    // judge failure.
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      throw new JudgeEndpointUnavailableError(
        `${res.status} with content-type "${contentType || 'none'}"`
      )
    }
    if (res.status === 404) {
      // The patched route's own 404 is ModelNotFoundError — a real failure the
      // fallback cannot fix. Only a bare/unknown-route 404 means "no endpoint".
      const text = await res.text()
      if (!text.includes('ModelNotFoundError')) {
        throw new JudgeEndpointUnavailableError(`404 ${text.slice(0, 200)}`)
      }
      throw new Error(`opencode POST ${JUDGE_COMPLETION_PATH} → 404: ${text.slice(0, 400)}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(
        `opencode POST ${JUDGE_COMPLETION_PATH} → ${res.status}: ${text.slice(0, 400)}`
      )
    }

    const parsed = (await res.json()) as { text?: unknown; usage?: unknown }
    // Token counts only — no prompt or completion content — so this is safe to
    // log. It is the one signal that explains an empty/unparseable completion:
    // a native-reasoning judge can spend the whole `maxTokens` budget on
    // reasoning tokens and emit no visible text. Logged before the text check
    // so a malformed response is diagnosable too.
    if (parsed?.usage && typeof parsed.usage === 'object') {
      logger.debug('judge-transport', `judge usage ${JSON.stringify(parsed.usage)}`)
    }
    if (typeof parsed?.text !== 'string') {
      throw new Error(`opencode POST ${JUDGE_COMPLETION_PATH} returned no text field`)
    }
    return parsed.text
  }
}

/**
 * Prefer the direct endpoint; fall back to `fallback` (the tool-denied judge
 * session) when this server does not have it.
 *
 * The probe runs at most once per `probe` object — one per session — and its
 * result is cached. A direct call that turns out to hit a missing route flips
 * the cache too, so the fallback is engaged exactly once and stays engaged.
 */
export function makeJudgeTransportWithFallback(opts: {
  target: JudgeEndpointTarget
  model: JudgeModelRef
  fallback: JudgeTransport
  probe: JudgeEndpointProbe
  fetchImpl?: FetchFn
}): JudgeTransport {
  const { target, model, fallback, probe } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const direct = makeDirectJudgeTransport(target, model, fetchImpl)

  return async (req: JudgeRequest): Promise<string> => {
    if (probe.available === undefined) {
      try {
        probe.available = await probeJudgeEndpoint(target, fetchImpl)
        logger.info(
          'judge-transport',
          probe.available
            ? 'opencode exposes /judge/completion — using the tool-less judge transport'
            : 'opencode has no /judge/completion — falling back to the tool-denied judge session'
        )
      } catch (err) {
        // Server unreachable for the probe. Do NOT cache: this is transient,
        // and downgrading the whole session on one blip is worse than retrying.
        logger.warn(
          'judge-transport',
          `judge endpoint probe failed, using session transport this call: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        return fallback(req)
      }
    }

    if (!probe.available) return fallback(req)

    try {
      return await direct(req)
    } catch (err) {
      if (err instanceof JudgeEndpointUnavailableError) {
        probe.available = false
        logger.warn(
          'judge-transport',
          `${err.message} — falling back to the tool-denied judge session for this session`
        )
        return fallback(req)
      }
      // Anything else is a real judge failure: propagate so classify() fails
      // closed and the approval goes to the human.
      throw err
    }
  }
}
