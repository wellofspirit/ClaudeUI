/**
 * The OpenRouter tab's reads (Usage Analytics › OpenRouter): the key's budget,
 * the account's credits, the model catalog and one model's providers.
 *
 * ## The credential boundary
 *
 * This is the one place the app sends a vault key to a third party for a
 * dashboard, and the channels in front of it are reachable from a remote client.
 * So:
 *
 *   - The key is read from the vault PER CALL and lives in locals only: never in
 *     a field, a cache entry, a return value, an error or a log line. Caches are
 *     keyed by the key's account digest, so a swapped key misses all of them.
 *   - The base URL is a constant. An env or settings override would be a
 *     key-exfiltration knob.
 *   - GET only, `redirect: 'error'` (a redirect would carry the Authorization
 *     header to wherever it points), a 15 s timeout, the proxy-aware fetch.
 *   - Least privilege: the key goes ONLY to `/key`, `/credits`, `/models/user`,
 *     `/benchmarks` and a model's `/endpoints`. `/models` and `/models/count` are
 *     public and go without an Authorization header. The endpoints route answers
 *     without a key too, but nulls every latency and throughput figure, so it is
 *     keyed — which is why its one caller-supplied input, `modelId`, is held to
 *     two anchored segments and the parsed URL re-checked before the key is read:
 *     the keyed request can only ever be `/api/v1/models/<a>/<s>/endpoints`.
 *   - Every failure is one of a fixed set of messages. A 200 whose body does not
 *     parse or map is "unexpected response", because a `SyntaxError` from
 *     `res.json()` quotes the body (a captive-portal page, say) and a mapper
 *     `TypeError` names fields, and `safeHandler` logs `err.message` and returns
 *     it to remote clients. Bodies and headers are never echoed.
 *   - Results are mapped field by field to `shared/openrouter.ts`; nothing a
 *     response carries beyond that (creator id, workspace id) leaves this file.
 */

import { authVault, type VaultCredentialRecord } from '../auth/vault/AuthVault'
import type {
  OpenRouterEndpointRow,
  OpenRouterKeyInfo,
  OpenRouterModelRow,
  OpenRouterOverview,
  OpenRouterSpendWindows
} from '../../shared/openrouter'
import { apiKeyAccountKey } from './account-key-hash'
import {
  getRemoteUsageBucketsSince,
  getUsageBucketsSince,
  type RemoteUsageBucketRow,
  type UsageBucketRow
} from './db'
import { logger } from './logger'
import { pickNetFetch } from './net-fetch'
import { bucketDisplayCostUsd } from './usage-aggregation'
import { selfMachine } from './usage-dashboard'

const VENDOR_ID = 'openrouter'
const BASE_URL = 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 15_000

const MODELS_TTL_MS = 60 * 60_000
const BENCHMARKS_TTL_MS = 6 * 60 * 60_000
const ENDPOINTS_TTL_MS = 5 * 60_000

/**
 * Each segment starts alphanumeric — after the `~` OpenRouter puts on its
 * "latest" aliases (`~openai/gpt-luna-latest`) — which rejects `.`, `..`, `?`,
 * `#`, `%` and a third `/`.
 */
const MODEL_ID_PATTERN = /^~?[A-Za-z0-9][A-Za-z0-9._~-]*\/[A-Za-z0-9][A-Za-z0-9._~:-]*$/

const MSG_NO_KEY = 'No OpenRouter API key'
const MSG_UNEXPECTED = 'OpenRouter sent an unexpected response'
const MSG_UNREACHABLE = 'Could not reach OpenRouter'

/** An error whose message is safe to show a remote client: fixed text, never a body. */
export class OpenRouterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return 'OpenRouter rejected the key'
  if (status === 404) return 'Not found on OpenRouter'
  if (status === 429) return 'OpenRouter rate limit reached'
  if (status >= 500) return 'OpenRouter is unavailable'
  return `OpenRouter answered ${status}`
}

// ---------------------------------------------------------------------------
// Mapping (throws on a shape it cannot use; `get` turns that into MSG_UNEXPECTED)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function record(value: unknown): Json {
  if (!isRecord(value)) throw new TypeError('not an object')
  return value
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('not a number')
  return value
}
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A per-token decimal string as USD per million tokens; a negative price (a router's `-1`) is no price. */
function perMillion(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value) * 1e6
  if (!Number.isFinite(n) || n < 0) return null
  return Number(n.toPrecision(12))
}

function spendWindows(prefix: 'usage' | 'byok_usage', data: Json): OpenRouterSpendWindows {
  return {
    dailyUsd: finiteOr(data[`${prefix}_daily`], 0),
    weeklyUsd: finiteOr(data[`${prefix}_weekly`], 0),
    monthlyUsd: finiteOr(data[`${prefix}_monthly`], 0),
    totalUsd: finiteOr(data[prefix], 0)
  }
}

const RESET_INTERVALS = ['daily', 'weekly', 'monthly'] as const
function resetInterval(value: unknown): OpenRouterKeyInfo['limitReset'] {
  return RESET_INTERVALS.find((interval) => interval === value) ?? null
}

function mapKey(body: unknown): OpenRouterKeyInfo {
  const data = record(record(body).data)
  if (typeof data.label !== 'string') throw new TypeError('no label')
  finite(data.usage)

  // ONE source for the four budget fields: a guardrail can be the effective
  // budget, and mixing its limit with the key's own reset would be wrong.
  const effective = isRecord(data.effective_budget) ? data.effective_budget : null
  const budget = effective
    ? {
        limitUsd: finiteOrNull(effective.limit_usd),
        limitRemainingUsd: finiteOrNull(effective.remaining_usd),
        limitReset: resetInterval(effective.reset_interval),
        resetsAt: stringOrNull(effective.resets_at)
      }
    : {
        limitUsd: finiteOrNull(data.limit),
        limitRemainingUsd: finiteOrNull(data.limit_remaining),
        limitReset: resetInterval(data.limit_reset),
        resetsAt: null
      }

  const free = data.free_model_daily_requests
  return {
    label: data.label,
    ...budget,
    includeByokInLimit: data.include_byok_in_limit === true,
    usage: spendWindows('usage', data),
    byokUsage: spendWindows('byok_usage', data),
    isFreeTier: data.is_free_tier === true,
    expiresAt: stringOrNull(data.expires_at),
    dataRegions: Array.isArray(data.allowed_data_regions)
      ? data.allowed_data_regions.filter((r): r is string => typeof r === 'string')
      : [],
    freeModelRequests:
      isRecord(free) &&
      typeof free.used === 'number' &&
      typeof free.limit === 'number' &&
      typeof free.remaining === 'number'
        ? { used: free.used, limit: free.limit, remaining: free.remaining }
        : null
  }
}

function mapCredits(body: unknown): { totalUsd: number; usedUsd: number } {
  const data = record(record(body).data)
  return { totalUsd: finite(data.total_credits), usedUsd: finite(data.total_usage) }
}

function mapCount(body: unknown): number {
  return finite(record(record(body).data).count)
}

/** A catalog row before the benchmark join; `canonicalSlug` is the join key and goes no further. */
type CatalogRow = Omit<OpenRouterModelRow, 'intelligenceIndex' | 'codingIndex'> & {
  canonicalSlug: string | null
}

function mapCatalog(body: unknown): CatalogRow[] {
  const data = record(body).data
  if (!Array.isArray(data)) throw new TypeError('no list')
  const rows: CatalogRow[] = []
  for (const raw of data) {
    // One malformed row is not a reason to lose the other four hundred.
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
    const pricing = isRecord(raw.pricing) ? raw.pricing : {}
    const architecture = isRecord(raw.architecture) ? raw.architecture : {}
    rows.push({
      id: raw.id,
      name: raw.name,
      canonicalSlug: stringOrNull(raw.canonical_slug),
      contextLength: finiteOrNull(raw.context_length),
      promptPerM: perMillion(pricing.prompt),
      completionPerM: perMillion(pricing.completion),
      cacheReadPerM: perMillion(pricing.input_cache_read),
      inputModalities: Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities.filter((m): m is string => typeof m === 'string')
        : [],
      reasoning:
        Array.isArray(raw.supported_parameters) && raw.supported_parameters.includes('reasoning')
    })
  }
  return rows
}

interface Benchmark {
  intelligenceIndex: number | null
  codingIndex: number | null
}

/** permaslug → the row with the highest intelligence index (a slug has one row per variant). */
function mapBenchmarks(body: unknown): Map<string, Benchmark> {
  const data = record(body).data
  if (!Array.isArray(data)) throw new TypeError('no list')
  const best = new Map<string, Benchmark>()
  for (const raw of data) {
    if (!isRecord(raw) || typeof raw.model_permaslug !== 'string') continue
    const intelligenceIndex = finiteOrNull(raw.intelligence_index)
    const seen = best.get(raw.model_permaslug)
    if (seen && (seen.intelligenceIndex ?? -Infinity) >= (intelligenceIndex ?? -Infinity)) continue
    best.set(raw.model_permaslug, {
      intelligenceIndex,
      codingIndex: finiteOrNull(raw.coding_index)
    })
  }
  return best
}

function p50(value: unknown): number | null {
  return isRecord(value) ? finiteOrNull(value.p50) : null
}

function mapEndpoints(body: unknown): OpenRouterEndpointRow[] {
  const endpoints = record(record(body).data).endpoints
  if (!Array.isArray(endpoints)) throw new TypeError('no list')
  const rows: OpenRouterEndpointRow[] = []
  for (const raw of endpoints) {
    if (!isRecord(raw) || typeof raw.provider_name !== 'string') continue
    const pricing = isRecord(raw.pricing) ? raw.pricing : {}
    rows.push({
      provider: raw.provider_name,
      tag: typeof raw.tag === 'string' ? raw.tag : raw.provider_name,
      // OpenRouter says "unknown" where it has no figure; the tab shows a dash.
      quantization:
        typeof raw.quantization === 'string' && raw.quantization !== 'unknown'
          ? raw.quantization
          : null,
      promptPerM: perMillion(pricing.prompt),
      completionPerM: perMillion(pricing.completion),
      contextLength: finiteOrNull(raw.context_length),
      status: finiteOr(raw.status, 0),
      uptime1d: finiteOrNull(raw.uptime_last_1d),
      uptime30m: finiteOrNull(raw.uptime_last_30m),
      latencyP50Ms: p50(raw.latency_last_30m),
      throughputP50: p50(raw.throughput_last_30m)
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * TTL entries under `<digest>|<name>`. A different key is a different digest,
 * so it can never be served another key's rows; storing drops every other
 * digest's entries, so a rotated key does not leave the old one's data behind.
 */
class DigestCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>()
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number
  ) {}

  get(digest: string, name: string): T | undefined {
    const hit = this.entries.get(`${digest}|${name}`)
    return hit && this.now() - hit.at < this.ttlMs ? hit.value : undefined
  }

  set(digest: string, name: string, value: T): void {
    for (const key of this.entries.keys())
      if (!key.startsWith(`${digest}|`)) this.entries.delete(key)
    this.entries.set(`${digest}|${name}`, { at: this.now(), value })
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface OpenRouterDashboardDeps {
  /** Only `loadCredential` (the network reads) and `hasApiKey` (presence, for `status`) are used. */
  vault?: {
    loadCredential(providerId: string): Promise<VaultCredentialRecord | null>
    hasApiKey(providerId: string): Promise<boolean>
  }
  fetch?: () => Promise<typeof fetch>
  now?: () => number
  logger?: Pick<typeof logger, 'debug' | 'warn'>
  /** The ledger's hourly buckets since `sinceMs` (UTC hour starts), and this machine's hub identity. */
  ledger?: {
    local(sinceMs: number): UsageBucketRow[]
    remote(sinceMs: number): RemoteUsageBucketRow[]
    self(): { deviceId: string } | null
  }
}

interface Credential {
  key: string
  digest: string
}

export class OpenRouterDashboard {
  private readonly vault: NonNullable<OpenRouterDashboardDeps['vault']>
  private readonly getFetch: () => Promise<typeof fetch>
  private readonly now: () => number
  private readonly log: NonNullable<OpenRouterDashboardDeps['logger']>
  private readonly ledger: NonNullable<OpenRouterDashboardDeps['ledger']>
  private readonly catalogs: DigestCache<CatalogRow[]>
  private readonly benchmarks: DigestCache<Map<string, Benchmark>>
  private readonly endpoints: DigestCache<OpenRouterEndpointRow[]>
  private overviewInFlight: Promise<OpenRouterOverview> | null = null

  constructor(deps: OpenRouterDashboardDeps = {}) {
    this.vault = deps.vault ?? authVault
    this.getFetch = deps.fetch ?? (() => pickNetFetch())
    this.now = deps.now ?? Date.now
    this.log = deps.logger ?? logger
    this.ledger = deps.ledger ?? {
      local: getUsageBucketsSince,
      remote: getRemoteUsageBucketsSince,
      self: selfMachine
    }
    this.catalogs = new DigestCache(MODELS_TTL_MS, this.now)
    this.benchmarks = new DigestCache(BENCHMARKS_TTL_MS, this.now)
    this.endpoints = new DigestCache(ENDPOINTS_TTL_MS, this.now)
  }

  async status(): Promise<{ configured: boolean }> {
    return { configured: await this.vault.hasApiKey(VENDOR_ID) }
  }

  /**
   * Concurrent reads share one round of requests: the renderer guards its own
   * button, but a remote client calling in a loop would otherwise spend three
   * keyed GETs per call and run into OpenRouter's rate limit.
   */
  overview(): Promise<OpenRouterOverview> {
    this.overviewInFlight ??= this.readOverview().finally(() => {
      this.overviewInFlight = null
    })
    return this.overviewInFlight
  }

  private async readOverview(): Promise<OpenRouterOverview> {
    const { key, digest } = await this.credential()
    const [keyInfo, credits, count, user] = await Promise.allSettled([
      this.get('/key', key, mapKey),
      this.get('/credits', key, mapCredits),
      this.get('/models/count', null, mapCount),
      this.get('/models/user', key, mapCatalog)
    ])
    // Without the key's own read there is no tab to draw.
    if (keyInfo.status === 'rejected') throw keyInfo.reason

    const partialErrors: Record<string, string> = {}
    if (credits.status === 'rejected') partialErrors.credits = failureMessage(credits.reason)
    if (user.status === 'fulfilled') this.catalogs.set(digest, 'user', user.value)
    const modelsFailure = count.status === 'rejected' ? count : user
    if (modelsFailure.status === 'rejected')
      partialErrors.models = failureMessage(modelsFailure.reason)

    return {
      fetchedAt: this.now(),
      key: keyInfo.value,
      credits: credits.status === 'fulfilled' ? credits.value : null,
      models: {
        available: user.status === 'fulfilled' ? user.value.length : null,
        total: count.status === 'fulfilled' ? count.value : null
      },
      ledger: this.ledgerFigure(digest),
      partialErrors
    }
  }

  async models(scope: unknown): Promise<OpenRouterModelRow[]> {
    // A remote caller ignores the TypeScript types.
    if (scope !== 'user' && scope !== 'all') throw new OpenRouterError('Invalid model scope')
    const { key, digest } = await this.credential()
    let catalog = this.catalogs.get(digest, scope)
    if (!catalog) {
      catalog =
        scope === 'user'
          ? await this.get('/models/user', key, mapCatalog)
          : await this.get('/models', null, mapCatalog)
      this.catalogs.set(digest, scope, catalog)
    }
    const benchmarks = await this.benchmarkIndex(key, digest)
    return catalog.map(({ canonicalSlug, ...row }) => {
      const bench = canonicalSlug ? benchmarks.get(canonicalSlug) : undefined
      return {
        ...row,
        intelligenceIndex: bench?.intelligenceIndex ?? null,
        codingIndex: bench?.codingIndex ?? null
      }
    })
  }

  async modelEndpoints(modelId: unknown): Promise<OpenRouterEndpointRow[]> {
    const path = endpointsPath(modelId)
    const { key, digest } = await this.credential()
    const hit = this.endpoints.get(digest, path)
    if (hit) return hit
    const rows = await this.get(path, key, mapEndpoints)
    this.endpoints.set(digest, path, rows)
    return rows
  }

  /** Best-effort: the indices are a garnish, and their absence must not hide the catalog. */
  private async benchmarkIndex(key: string, digest: string): Promise<Map<string, Benchmark>> {
    const cached = this.benchmarks.get(digest, 'index')
    if (cached) return cached
    try {
      const index = await this.get('/benchmarks', key, mapBenchmarks)
      this.benchmarks.set(digest, 'index', index)
      return index
    } catch (err) {
      this.log.warn('OpenRouter', `benchmarks unavailable: ${failureMessage(err)}`)
      return new Map()
    }
  }

  private async credential(): Promise<Credential> {
    const stored = await this.vault.loadCredential(VENDOR_ID)
    if (stored?.type !== 'api_key' || !stored.key) throw new OpenRouterError(MSG_NO_KEY)
    return { key: stored.key, digest: apiKeyAccountKey(VENDOR_ID, stored.key).accountKey }
  }

  /**
   * One GET. `key` is the Authorization bearer, or null for a public path; there
   * is no default, so a new call has to say which it is.
   */
  private async get<T>(path: string, key: string | null, map: (body: unknown) => T): Promise<T> {
    let res: Response
    try {
      const doFetch = await this.getFetch()
      res = await doFetch(`${BASE_URL}${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ClaudeUI',
          ...(key === null ? {} : { Authorization: `Bearer ${key}` })
        }
      })
    } catch {
      // The cause can quote the URL or a proxy's address; none of it is for the client.
      this.log.warn('OpenRouter', `GET ${path}: unreachable`)
      throw new OpenRouterError(MSG_UNREACHABLE)
    }
    if (!res.ok) {
      this.log.warn('OpenRouter', `GET ${path}: ${res.status}`)
      throw new OpenRouterError(statusMessage(res.status))
    }
    try {
      return map(await res.json())
    } catch {
      this.log.warn('OpenRouter', `GET ${path}: unexpected response`)
      throw new OpenRouterError(MSG_UNEXPECTED)
    }
  }

  /** What the ledger recorded on this key since the UTC month began; null if it cannot be read. */
  private ledgerFigure(digest: string): OpenRouterOverview['ledger'] {
    try {
      const now = this.now()
      const date = new Date(now)
      const sinceMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
      const mine = (row: UsageBucketRow): boolean =>
        row.accountKey === digest && row.hourUtc >= sinceMs && row.hourUtc <= now

      let costUsd = 0
      for (const row of this.ledger.local(sinceMs))
        if (mine(row)) costUsd += bucketDisplayCostUsd(row)

      // Another machine's rows only under the same gate as the dashboard's
      // combined scope: a hub that is on and a device id to tell the rows apart.
      const self = this.ledger.self()
      const devices = new Set<string>()
      if (self) {
        for (const row of this.ledger.remote(sinceMs)) {
          // The hub's copy of THIS machine's own rows would double the hour.
          if (row.deviceId === self.deviceId || !mine(row)) continue
          costUsd += bucketDisplayCostUsd(row)
          devices.add(row.deviceId)
        }
      }
      return { sinceUtc: new Date(sinceMs).toISOString(), costUsd, machines: 1 + devices.size }
    } catch {
      return null
    }
  }
}

/** `/models/{author}/{slug}/endpoints` for a validated id; throws before any request otherwise. */
function endpointsPath(modelId: unknown): string {
  if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
    throw new OpenRouterError('Invalid model id')
  }
  const [author, slug] = modelId.split('/')
  const path = `/models/${author}/${slug}/endpoints`
  // Belt and braces over the pattern: the URL as the platform parses it must
  // still sit under the models tree and have exactly the six segments.
  const url = new URL(`${BASE_URL}${path}`)
  const segments = url.pathname.split('/').filter(Boolean)
  if (!url.pathname.startsWith('/api/v1/models/') || segments.length !== 6) {
    throw new OpenRouterError('Invalid model id')
  }
  return path
}

function failureMessage(err: unknown): string {
  return err instanceof OpenRouterError ? err.message : MSG_UNREACHABLE
}

export const openrouterDashboard = new OpenRouterDashboard()
