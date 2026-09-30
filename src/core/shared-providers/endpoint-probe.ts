/**
 * Detect for a custom endpoint: what a self-hosted OpenAI-compatible server
 * says about the models it serves.
 *
 * - `GET {base}/models` — every OpenAI-compatible server. vLLM and SGLang add
 *   `owned_by: "vllm" | "sglang"` and `max_model_len` to each entry
 *   (vLLM `vllm/entrypoints/serve/engine/protocol.py:105`, SGLang
 *   `python/sglang/srt/entrypoints/openai/protocol.py:81`).
 * - `GET {root}/model_info` (SGLang only; `get_model_info` is its deprecated
 *   alias) — `has_image_understanding`, `reasoning_parser`, `tool_call_parser`
 *   (`http_server.py:790`). SGLang serves ONE base model per process, LoRA
 *   adapters appearing as extra `/models` entries, so its answer applies to
 *   every served model. Failing to read it is not a failed Detect.
 *
 * Neither server reports a max output; `endpoint-detect.ts` suggests one.
 *
 * It runs host-side because the key does: a typed key comes in, a stored one is
 * read from the vault by the caller, and neither goes back out — not in the
 * result, not in a message, not in a log line. Every message names the URL
 * without its query string or userinfo, and never carries a fetch error's own
 * text, which can quote a header value.
 */
import { logger } from '../services/logger'
import type {
  EndpointProbeFailure,
  EndpointProbeModel,
  EndpointProbeResult,
  EndpointServerKind,
  SharedProviderProtocol
} from '../../shared/shared-provider'

const DEFAULT_TIMEOUT_MS = 5_000
/** A `/models` list of a few thousand entries is well under this. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface EndpointProbeRequest {
  baseUrl: string
  protocol?: SharedProviderProtocol
  apiKey?: string
}

export interface EndpointProbeOptions {
  /** Per request. Tests shorten it; the form never does. */
  timeoutMs?: number
}

type Failure = Extract<EndpointProbeResult, { status: 'failed' }>
type Fetched = { kind: 'ok'; body: unknown } | { kind: 'failed'; failure: Failure; status?: number }

export async function probeEndpoint(
  request: EndpointProbeRequest,
  fetchImpl: typeof fetch = fetch,
  options: EndpointProbeOptions = {}
): Promise<EndpointProbeResult> {
  const base = parseBase(request.baseUrl)
  if (!base) {
    return failed(
      'invalid-url',
      'The Base URL must be an http:// or https:// address, without a username or password.'
    )
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = requestHeaders(request)
  const modelsUrl = withPath(base, `${basePath(base)}/models`)
  logger.debug('SharedProviders', `detect: probing ${displayUrl(modelsUrl)}`)

  const listed = await getJson(modelsUrl, headers, fetchImpl, timeoutMs)
  if (listed.kind === 'failed') return listed.failure
  const data = (listed.body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    return failed('invalid-response', `${displayUrl(modelsUrl)} did not answer a model list.`)
  }

  const models: EndpointProbeModel[] = []
  const seen = new Set<string>()
  const owners = { vllm: 0, sglang: 0 }
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const { id, owned_by: ownedBy, max_model_len: maxModelLen } = entry as Record<string, unknown>
    // Duplicates would make a definition the repository refuses to save.
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue
    seen.add(id)
    if (ownedBy === 'vllm') owners.vllm++
    else if (ownedBy === 'sglang') owners.sglang++
    models.push({ id, ...(isPositiveInteger(maxModelLen) ? { contextWindow: maxModelLen } : {}) })
  }
  const server: EndpointServerKind =
    owners.sglang > owners.vllm ? 'sglang' : owners.vllm > 0 ? 'vllm' : 'openai-compatible'
  if (server !== 'sglang') return { status: 'detected', server, models }

  const info = await readModelInfo(base, headers, fetchImpl, timeoutMs)
  if (!info) return { status: 'detected', server, models, modelInfoUnavailable: true }
  return {
    status: 'detected',
    server,
    models: models.map((model) => ({
      ...model,
      vision: info.vision,
      reasoning: info.reasoningParser !== undefined,
      ...(info.reasoningParser !== undefined ? { reasoningParser: info.reasoningParser } : {})
    })),
    ...(info.toolCallParser !== undefined ? { toolCallParser: info.toolCallParser } : {})
  }
}

interface ModelInfo {
  vision: boolean
  reasoningParser?: string
  toolCallParser?: string | null
}

/**
 * SGLang's server-wide model facts, or null when they cannot be read. It serves
 * `/model_info` at the server ROOT, not under `/v1`; the deprecated
 * `/get_model_info` is tried only on a 404, which is what an older release
 * answers for the new name.
 */
async function readModelInfo(
  base: URL,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<ModelInfo | null> {
  const root = basePath(base).replace(/\/v1$/, '')
  let answer = await getJson(withPath(base, `${root}/model_info`), headers, fetchImpl, timeoutMs)
  if (answer.kind === 'failed' && answer.status === 404)
    answer = await getJson(withPath(base, `${root}/get_model_info`), headers, fetchImpl, timeoutMs)
  if (answer.kind === 'failed' || !answer.body || typeof answer.body !== 'object') return null
  const body = answer.body as Record<string, unknown>
  const reasoning = body.reasoning_parser
  const tools = body.tool_call_parser
  return {
    vision: body.has_image_understanding === true,
    ...(typeof reasoning === 'string' && reasoning ? { reasoningParser: reasoning } : {}),
    // Absent (an SGLang too old to say) stays absent: only an explicit null
    // means "no tool-call parser".
    ...(tools === null || (typeof tools === 'string' && tools)
      ? { toolCallParser: tools as string | null }
      : {})
  }
}

/** One GET, never throwing, and never quoting anything a header could have put in an error. */
async function getJson(
  url: URL,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Fetched> {
  const shown = displayUrl(url)
  let response: Response
  try {
    // `manual`: a redirect is reported, never followed — a login page answering
    // for the server (an auth proxy in front of it) is not a model list, and
    // following one would carry the key to wherever it points.
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    return { kind: 'failed', failure: transportFailure(err, shown, timeoutMs) }
  }

  const status = response.status
  if (status === 0 || (status >= 300 && status < 400)) {
    const location = response.headers.get('location')
    const target = location ? safeLocation(location, url) : null
    return {
      kind: 'failed',
      status,
      failure: failed(
        'redirect',
        target
          ? `${shown} redirected to ${target} (HTTP ${status}). Use the address it serves the API on.`
          : `${shown} answered with a redirect (HTTP ${status}).`
      )
    }
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'failed',
      status,
      failure: failed('unauthorized', `${shown} refused the request (HTTP ${status}).`)
    }
  }
  if (status < 200 || status >= 300) {
    return {
      kind: 'failed',
      status,
      failure: failed('http', `${shown} answered HTTP ${status}.`)
    }
  }

  let text: string | null
  try {
    text = await readCapped(response)
  } catch (err) {
    return { kind: 'failed', failure: transportFailure(err, shown, timeoutMs) }
  }
  if (text === null) {
    return {
      kind: 'failed',
      failure: failed('invalid-response', `${shown} answered more than 2 MiB.`)
    }
  }
  try {
    return { kind: 'ok', body: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'failed', failure: failed('invalid-response', `${shown} did not answer JSON.`) }
  }
}

/** The body as text, or null once it passes {@link MAX_BODY_BYTES} — read no further than that. */
async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A failed request, in our own words. The error's message is deliberately not
 * used: undici's can quote a rejected header value, which is where the key is.
 */
function transportFailure(err: unknown, shown: string, timeoutMs: number): Failure {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return failed(
      'timeout',
      `${shown} did not answer within ${Math.round(timeoutMs / 100) / 10} s.`
    )
  }
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  const why =
    typeof code === 'string' ? (NETWORK_ERRORS[code] ?? code) : 'the request could not be sent'
  return failed('unreachable', `Couldn't reach ${shown} (${why}).`)
}

const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host not found',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'connection timed out'
}

function requestHeaders(request: EndpointProbeRequest): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = request.apiKey?.trim()
  if (!key) return headers
  // vLLM's and SGLang's `--api-key` both check the Bearer token; an Anthropic-
  // protocol gateway reads `x-api-key`.
  headers.authorization = `Bearer ${key}`
  if (request.protocol === 'anthropic-messages') headers['x-api-key'] = key
  return headers
}

/**
 * The Base URL as typed, or null. http(s) only; a userinfo is refused rather
 * than stripped or sent — fetch will not send one, and a message naming the URL
 * must not either. The query string is kept for the request (some gateways
 * need one) and left out of every message.
 */
function parseBase(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  url.hash = ''
  return url
}

/** `{base}`'s path without trailing slashes: `/v1/` → `/v1`, `/` → ``. */
function basePath(base: URL): string {
  return base.pathname.replace(/\/+$/, '')
}

function withPath(base: URL, pathname: string): URL {
  const url = new URL(base.href)
  url.pathname = pathname
  return url
}

function displayUrl(url: URL): string {
  return `${url.origin}${url.pathname}`
}

/** A redirect target resolved against the request, shown without query or userinfo. */
function safeLocation(location: string, from: URL): string | null {
  try {
    return displayUrl(new URL(location, from))
  } catch {
    return null
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function failed(reason: EndpointProbeFailure, message: string): Failure {
  return { status: 'failed', reason, message }
}
