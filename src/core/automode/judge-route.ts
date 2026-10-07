/**
 * The auto-mode judge's route resolver (ADR-081 §2-§3): turn the judge model a
 * session names — `<provider>/<model>` in the engine's own ids — into the one
 * {@link ResolvedJudgeRoute} `judge-http/` spends, or a user-facing reason why
 * ClaudeUI can't call it.
 *
 * Ownership is the rule `decorateSharedProviderClaims` (`session.ipc.ts`)
 * already uses: the shared definition whose DELIVERED route for the engine is
 * enabled and whose native provider id is the model's provider. Only a
 * provider ClaudeUI holds the credential for can be called; one the engine owns
 * itself (Copilot, pi's own OAuth vendors, keys added outside ClaudeUI) gets no
 * judge, and every gated action goes to the human (§3: no fallback).
 *
 * Kept OUT of `judge-http/`, which must not import vault, shared-provider or
 * engine code. Runs per judge call, so a rotated key or a refreshed token
 * applies to the next call.
 *
 * Two entry points share ONE decision path ({@link planRoute}):
 * {@link resolveJudgeRoute} spends a credential on the route it plans, and
 * {@link describeJudgeRoute} — the judge picker's "can ClaudeUI call this?" —
 * only asks whether the credential is there.
 *
 * CREDENTIAL BOUNDARY: keys and tokens go into `route.headers` and nowhere
 * else. Labels, reasons and the route's `account` are credential-free — the
 * account key of an API key is its digest (`apiKeyAccountKey`). The describe
 * path fetches no token at all and keeps no key. Nothing here logs. A
 * dependency that throws (an unreadable vault) rejects the call, which the
 * transport's caller treats like any other judge failure: the human decides.
 */

import * as os from 'node:os'
import { engineMeta } from '../../shared/engine-meta'
import { nativeAccountKey, type AccountIdentity } from '../../shared/account-key'
import { deliveredDefinition, type SharedProviderDefinition } from '../../shared/shared-provider'
import type { JudgeModelSupport, OpencodeCatalogModel } from '../../shared/types'
import { authVault, CHATGPT_PROVIDER_ID } from '../auth/vault/AuthVault'
import { computeResidencyFromToken } from '../auth/vault/codex-oauth'
import { credentialSync, type CodexInjectionToken } from '../auth/vault/CredentialSync'
import { hostAppVersion } from '../host'
import { getOpencodeProviderModels } from '../opencode/model-discovery'
import { getPiModelCatalog } from '../pi/model-discovery'
import type { PiModel } from '../pi/pi-protocol'
import { apiKeyAccountKey } from '../services/account-key-hash'
import { opencodeProviderId } from '../shared-providers/OpencodeSharedProviderAdapter'
import { nativeProviderId } from '../shared-providers/PiSharedProviderAdapter'
import { SharedProviderRepository } from '../shared-providers/SharedProviderRepository'
import { capsFor, wireForKind } from './judge-http/caps'
import type {
  JudgeRouteAccount,
  JudgeRouteKind,
  JudgeRouteResult,
  JudgeRouteUnavailableCode,
  ResolvedJudgeRoute
} from './judge-http/types'

export type JudgeEngine = 'opencode' | 'pi'

export interface JudgeRouteDeps {
  /** The shared-provider definitions on disk. */
  listDefinitions(): SharedProviderDefinition[]
  /** A definition's vault API key, or null when it holds none. */
  loadApiKey(definitionId: string): Promise<string | null>
  /**
   * The ACTIVE ChatGPT account's token (ADR-068 §1); `force` refreshes it
   * first whatever its expiry. Null when signed out or workspace-less.
   */
  chatgptToken(force: boolean): Promise<CodexInjectionToken | null>
  /**
   * Whether {@link chatgptToken} would find a token, answered WITHOUT one: the
   * active account holds a credential with a workspace id. The describe path's
   * ChatGPT check — it must never fetch or refresh a token.
   */
  chatgptSignedIn(): Promise<boolean>
  /** The ADR-071 §3 identity of one vault account. */
  chatgptIdentity(vaultAccountId: string): Promise<AccountIdentity>
  /** opencode's catalog entries for one provider. */
  opencodeCatalog(providerId: string): Promise<OpencodeCatalogModel[]>
  /** pi's whole model catalog. */
  piCatalog(): Promise<PiModel[]>
  /** For the ChatGPT route's User-Agent. */
  appVersion: string
}

const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
/** A constant, not the catalog's: the two engines' catalogs disagree about `/v1`. */
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
/** OpenRouter's app attribution headers (ADR-081 §4). */
const OPENROUTER_ATTRIBUTION: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://github.com/wellofspirit/ClaudeUI',
  'X-Title': 'ClaudeUI'
}
/** The AI SDK package / pi api that means "an OpenAI-compatible chat endpoint". */
/** opencode's OpenAI-compatible adapter: 2.x's package, and the 1.x AI SDK one a config may still name. */
const OPENCODE_COMPATIBLE_NPM: ReadonlySet<string> = new Set([
  '@opencode/ai/providers/openai-compatible',
  '@ai-sdk/openai-compatible'
])
const PI_COMPATIBLE_API = 'openai-completions'

const PROVIDERS_PAGE = 'Settings › Models & providers'
const PICK_ANOTHER = 'or pick a judge model from another provider'

let productionDeps: JudgeRouteDeps | undefined

/**
 * The real dependencies, built on first use. Nothing here reads anything until
 * a dependency is CALLED, so a test that injects every dependency never
 * touches the real vault, provider files or engine catalogs.
 */
function defaultDeps(): JudgeRouteDeps {
  if (productionDeps) return productionDeps
  const repository = new SharedProviderRepository()
  productionDeps = {
    listDefinitions: () => repository.list(),
    loadApiKey: async (definitionId) => {
      const credential = await authVault.loadCredential(definitionId)
      return credential?.type === 'api_key' && credential.key ? credential.key : null
    },
    // `Infinity` puts any expiry inside the refresh margin, so the token is
    // refreshed first — through the same per-account single-flight as every
    // scheduled refresh.
    chatgptToken: (force) => credentialSync.injectionTokenFor(null, force ? Infinity : undefined),
    // `injectionTokenFor(null)` is null exactly when the active account has no
    // credential or no workspace id; `getStatus()` reports both, token-free.
    chatgptSignedIn: async () => {
      const status = await credentialSync.getStatus()
      return status.connected && Boolean(status.accountId)
    },
    chatgptIdentity: (vaultAccountId) => credentialSync.accountIdentity(vaultAccountId),
    opencodeCatalog: (providerId) => getOpencodeProviderModels(providerId),
    piCatalog: () => getPiModelCatalog(),
    // Read per use: the host publishes its version at boot, possibly after
    // this object was built.
    get appVersion() {
      return hostAppVersion()
    }
  }
  return productionDeps
}

/**
 * Resolve the judge model `modelValue` (the engine's picker value) for one
 * judge call. Never throws for a model ClaudeUI can't call — that is an
 * `ok: false` result whose `reason` is the banner copy — only when a dependency
 * itself fails.
 */
export async function resolveJudgeRoute(
  engine: JudgeEngine,
  modelValue: string,
  deps: Partial<JudgeRouteDeps> = {}
): Promise<JudgeRouteResult> {
  const d: JudgeRouteDeps = { ...defaultDeps(), ...deps }
  const plan = await planRoute(engine, modelValue, d, d.loadApiKey)
  if (!plan.ok) return plan
  if (plan.kind === 'chatgpt') return chatgptRoute(plan.ctx)
  return { ok: true, route: keyedRoute(plan.ctx, plan.kind, plan.url, plan.key, plan.facts) }
}

/** Whether ClaudeUI can call a judge model, and if not, the resolver's own reason. */
export type JudgeRouteDescription =
  { ok: true } | { ok: false; code: JudgeRouteUnavailableCode; reason: string }

/**
 * {@link resolveJudgeRoute}'s verdict on `modelValue` without spending a
 * credential: the same plan, but a key is only checked for presence (and not
 * kept), and ChatGPT counts as signed in from the token-free status. For the
 * judge picker, which must not refresh a token per listed model.
 *
 * It can disagree with a later resolve only where the credential itself
 * changes in between.
 */
export async function describeJudgeRoute(
  engine: JudgeEngine,
  modelValue: string,
  deps: Partial<JudgeRouteDeps> = {}
): Promise<JudgeRouteDescription> {
  const d: JudgeRouteDeps = { ...defaultDeps(), ...deps }
  return describeWith(engine, modelValue, d, keyPresence(d))
}

/**
 * {@link describeJudgeRoute} for every value of a picker at once (the
 * `automode:judge-model-support` IPC). Within one batch the provider list, the
 * ChatGPT status, each key's PRESENCE and each catalog are read once. A value
 * whose check itself fails (an unreadable catalog) is reported as unsupported
 * with that failure: the picker can't offer a judge ClaudeUI could not vet.
 */
export async function describeJudgeModels(
  engine: JudgeEngine,
  values: readonly string[],
  deps: Partial<JudgeRouteDeps> = {}
): Promise<Record<string, JudgeModelSupport>> {
  const base: JudgeRouteDeps = { ...defaultDeps(), ...deps }
  let definitions: SharedProviderDefinition[] | undefined
  const d: JudgeRouteDeps = {
    ...base,
    listDefinitions: () => (definitions ??= base.listDefinitions()),
    chatgptSignedIn: once(() => base.chatgptSignedIn()),
    opencodeCatalog: memoized((providerId) => base.opencodeCatalog(providerId)),
    piCatalog: once(() => base.piCatalog())
  }
  const hasKey = memoized(keyPresence(base))
  const out: Record<string, JudgeModelSupport> = {}
  for (const value of new Set(values)) {
    try {
      const described = await describeWith(engine, value, d, hasKey)
      out[value] = described.ok ? { ok: true } : { ok: false, reason: described.reason }
    } catch (err) {
      out[value] = {
        ok: false,
        reason: `ClaudeUI couldn't check whether it can call this model for the judge (${
          err instanceof Error ? err.message : String(err)
        }).`
      }
    }
  }
  return out
}

async function describeWith(
  engine: JudgeEngine,
  modelValue: string,
  d: JudgeRouteDeps,
  hasKey: KeyLookup<true>
): Promise<JudgeRouteDescription> {
  const plan = await planRoute(engine, modelValue, d, hasKey)
  if (!plan.ok) return plan
  if (plan.kind === 'chatgpt') {
    return (await d.chatgptSignedIn()) ? { ok: true } : chatgptUnavailable()
  }
  return { ok: true }
}

/**
 * A key lookup that answers only whether the key exists: the value is dropped
 * on the spot, so the describe path holds no key material. Truthiness, as the
 * resolver's own checks read a key.
 */
function keyPresence(d: JudgeRouteDeps): KeyLookup<true> {
  return async (definitionId) => ((await d.loadApiKey(definitionId)) ? true : null)
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let hit: Promise<T> | undefined
  return () => (hit ??= fn())
}

function memoized<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const hits = new Map<string, Promise<T>>()
  return (key) => {
    let hit = hits.get(key)
    if (!hit) {
      hit = fn(key)
      hits.set(key, hit)
    }
    return hit
  }
}

// ---------------------------------------------------------------------------
// The plan: every branch decision, made once for both entry points
// ---------------------------------------------------------------------------

/**
 * Looks a definition's API key up. The resolver's returns the key itself; the
 * describe path's returns `true` for "there is one" and forgets the key.
 */
type KeyLookup<K> = (definitionId: string) => Promise<K | null>

type Unavailable = { ok: false; code: JudgeRouteUnavailableCode; reason: string }

/**
 * What the resolver decided for a judge model before any route is built:
 * refused, the ChatGPT subscription (whose token is fetched by whoever acts on
 * the plan, or not at all), or a key route with the lookup's answer in hand.
 */
type RoutePlan<K> =
  | Unavailable
  | { ok: true; kind: 'chatgpt'; ctx: RouteContext }
  | {
      ok: true
      kind: Exclude<JudgeRouteKind, 'chatgpt'>
      ctx: RouteContext
      url: string
      key: K | null
      facts: ModelFacts
    }

async function planRoute<K>(
  engine: JudgeEngine,
  modelValue: string,
  d: JudgeRouteDeps,
  loadKey: KeyLookup<K>
): Promise<RoutePlan<K>> {
  const meta = engineMeta(engine)
  // The wire model id is the engine-native model id on every route: it is what
  // the engine itself sends (`harnessOverrides[engine].id ?? model.id` for a
  // shared definition's model).
  const { vendorId: provider, modelId: model } = meta.decodeModelValue(modelValue)
  const ctx: RouteContext = { engine, engineLabel: meta.label, provider, model, deps: d }

  const definitions = d.listDefinitions()
  // The service's collision guard keeps two delivered definitions off one
  // native id; a hand-written file that breaks it resolves to the first
  // (ChatGPT is listed first).
  const owner = definitions.find(
    (definition) =>
      deliveredDefinition(definition).routes[engine].enabled &&
      nativeIdFor(engine, definition) === provider
  )
  if (!owner) {
    const off = definitions.find(
      (definition) => definition.disabled && nativeIdFor(engine, definition) === provider
    )
    if (off) {
      return unavailable(
        'provider-disabled',
        `"${off.name}" is switched off in ${PROVIDERS_PAGE}, so ClaudeUI can't call it for the judge. Switch it back on, ${PICK_ANOTHER}.`
      )
    }
    return unavailable(
      'no-shared-provider',
      `"${provider}" is set up inside ${meta.label}, not in ClaudeUI, so ClaudeUI can't call it for the judge. Pick a judge model from a provider in ${PROVIDERS_PAGE}.`
    )
  }

  if (owner.id === CHATGPT_PROVIDER_ID) return { ok: true, kind: 'chatgpt', ctx }
  if (owner.kind === 'custom') return customPlan(ctx, owner, loadKey)
  if (owner.kind === 'catalog') return catalogPlan(ctx, owner, loadKey)
  // A subscription other than ChatGPT: none exists, and none has a route.
  return unavailable(
    'unsupported-protocol',
    `ClaudeUI can't call "${owner.name}" for the judge. Pick a judge model from another provider in ${PROVIDERS_PAGE}.`
  )
}

interface RouteContext {
  engine: JudgeEngine
  engineLabel: string
  /** The engine-native provider id the judge model names. */
  provider: string
  /** The engine-native model id — the wire model id. */
  model: string
  deps: JudgeRouteDeps
}

/** What a catalog (or a definition's declared model) says about the model. */
interface ModelFacts {
  reasoning?: boolean
  maxOutputTokens?: number
}

/** The native provider id a definition's route lands on — the adapters' own rule. */
function nativeIdFor(engine: JudgeEngine, definition: SharedProviderDefinition): string {
  return engine === 'opencode' ? opencodeProviderId(definition) : nativeProviderId(definition)
}

function unavailable(code: JudgeRouteUnavailableCode, reason: string): Unavailable {
  return { ok: false, code, reason }
}

// ---------------------------------------------------------------------------
// ChatGPT subscription
// ---------------------------------------------------------------------------

/** `ClaudeUI/<version> (<platform> <release>; <arch>)`, the shape opencode's own agent sends. */
function chatgptUserAgent(appVersion: string): string {
  return `ClaudeUI/${appVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
}

/**
 * The ChatGPT backend with the active account's token. `originator: opencode`
 * because the vault's token is issued to opencode's OAuth client
 * (`codex-oauth.ts`'s `CLIENT_ID`). `reauthorize` rebuilds the route from a
 * force-refreshed token for the transport's one 401 retry.
 */
async function chatgptRoute(ctx: RouteContext): Promise<JudgeRouteResult> {
  const { deps, model, provider } = ctx

  const build = async (token: CodexInjectionToken): Promise<ResolvedJudgeRoute> => {
    const identity = await deps.chatgptIdentity(token.vaultAccountId)
    const residency = computeResidencyFromToken(token.accessToken)
    return {
      kind: 'chatgpt',
      wire: 'responses',
      url: CHATGPT_RESPONSES_URL,
      model,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'ChatGPT-Account-Id': token.chatgptAccountId,
        originator: 'opencode',
        'User-Agent': chatgptUserAgent(deps.appVersion),
        ...(residency ? { 'x-openai-internal-codex-residency': residency } : {})
      },
      caps: capsFor('chatgpt', model),
      label: `ChatGPT · ${model}`,
      account: {
        vendorId: provider,
        accountId: token.vaultAccountId,
        accountKey: identity.accountKey,
        accountLabel: identity.accountLabel,
        billingType: 'subscription'
      },
      reauthorize: async () => {
        const fresh = await deps.chatgptToken(true)
        // A refresh that failed leaves the old token in the vault — and
        // retrying with the token that was just refused would only 401 again.
        if (!fresh || fresh.accessToken === token.accessToken) return null
        return build(fresh)
      }
    }
  }

  const token = await deps.chatgptToken(false)
  if (!token) return chatgptUnavailable()
  return { ok: true, route: await build(token) }
}

/** No token (signed out, or no workspace id) — the same refusal on both entry points. */
function chatgptUnavailable(): Unavailable {
  return unavailable(
    'chatgpt-unavailable',
    `ChatGPT isn't signed in in ClaudeUI (or its account has no workspace), so ClaudeUI can't call it for the judge. Sign in to ChatGPT in ${PROVIDERS_PAGE}, ${PICK_ANOTHER}.`
  )
}

// ---------------------------------------------------------------------------
// Custom endpoints (incl. a catalog provider's second key)
// ---------------------------------------------------------------------------

async function customPlan<K>(
  ctx: RouteContext,
  definition: SharedProviderDefinition,
  loadKey: KeyLookup<K>
): Promise<RoutePlan<K>> {
  const { protocol } = definition
  if (protocol !== 'openai-completions' && protocol !== 'openai-responses') {
    const api = protocol === 'anthropic-messages' ? 'the Anthropic Messages API' : 'an API'
    return unavailable(
      'unsupported-protocol',
      `"${definition.name}" speaks ${api}, which ClaudeUI can't call for the judge. Pick a judge model from an OpenAI-compatible provider in ${PROVIDERS_PAGE}.`
    )
  }
  const kind: JudgeRouteKind =
    protocol === 'openai-responses'
      ? 'custom-responses'
      : definition.derivedFrom === 'openrouter'
        ? 'openrouter'
        : 'custom-chat'
  const url = endpointUrl(definition.baseUrl, kind)
  if (!url) {
    return unavailable(
      'no-base-url',
      `"${definition.name}" has no usable base URL, so ClaudeUI can't call it for the judge. Set one in ${PROVIDERS_PAGE}, ${PICK_ANOTHER}.`
    )
  }
  const declared = definition.models.find(
    (candidate) => (candidate.harnessOverrides?.[ctx.engine]?.id ?? candidate.id) === ctx.model
  )
  // No key is not a refusal here: the endpoint may be keyless.
  const key = await loadKey(definition.id)
  const facts = modelFacts(declared?.reasoning, declared?.maxTokens)
  return { ok: true, kind, ctx, url, key, facts }
}

// ---------------------------------------------------------------------------
// Catalog providers (a vault key for a provider the engines already know)
// ---------------------------------------------------------------------------

async function catalogPlan<K>(
  ctx: RouteContext,
  definition: SharedProviderDefinition,
  loadKey: KeyLookup<K>
): Promise<RoutePlan<K>> {
  const key = await loadKey(definition.id)
  if (!key) {
    return unavailable(
      'no-credential',
      `"${definition.name}" has no API key in ClaudeUI, so ClaudeUI can't call it for the judge. Add one in ${PROVIDERS_PAGE}, ${PICK_ANOTHER}.`
    )
  }
  if (definition.id === 'openai' || definition.id === 'openrouter') {
    const kind = definition.id === 'openai' ? 'openai' : 'openrouter'
    const url = kind === 'openai' ? OPENAI_CHAT_URL : OPENROUTER_CHAT_URL
    // The URL is a constant here: the catalog only adds optional facts (the
    // reasoning bit, the ceiling), so a catalog that fails routes without them.
    const entry = await catalogEntry(ctx).catch(() => null)
    return { ok: true, kind, ctx, url, key, facts: entry?.facts ?? {} }
  }

  // Every other catalog provider needs the catalog for its URL: a catalog
  // failure rejects the call.
  const entry = await catalogEntry(ctx)

  if (!entry) {
    return unavailable(
      'unsupported-protocol',
      `"${ctx.model}" is not in ${ctx.engineLabel}'s catalog for "${ctx.provider}", so ClaudeUI can't find its endpoint for the judge. Pick another judge model.`
    )
  }
  if (!entry.compatible) {
    const via = entry.api ? ` (${entry.api})` : ''
    return unavailable(
      'unsupported-protocol',
      `${ctx.engineLabel} talks to "${ctx.provider}" through its own API${via}, not an OpenAI-compatible one, so ClaudeUI can't call it for the judge. Pick a judge model from an OpenAI-compatible provider.`
    )
  }
  const url = endpointUrl(entry.baseUrl, 'custom-chat')
  if (!url) {
    return unavailable(
      'no-base-url',
      `${ctx.engineLabel}'s catalog gives no usable endpoint for "${ctx.provider}", so ClaudeUI can't call it for the judge. Pick another judge model.`
    )
  }
  return { ok: true, kind: 'custom-chat', ctx, url, key, facts: entry.facts }
}

interface CatalogEntry {
  /** An OpenAI-compatible chat endpoint. */
  compatible: boolean
  /** The engine's name for the API it speaks (opencode's AI SDK package, pi's `api`). */
  api: string | undefined
  baseUrl: string | undefined
  facts: ModelFacts
}

/** The judge model's entry in the engine's own catalog, normalized; null when absent. */
async function catalogEntry(ctx: RouteContext): Promise<CatalogEntry | null> {
  if (ctx.engine === 'opencode') {
    const found = (await ctx.deps.opencodeCatalog(ctx.provider)).find((m) => m.id === ctx.model)
    if (!found) return null
    return {
      compatible: found.apiNpm !== undefined && OPENCODE_COMPATIBLE_NPM.has(found.apiNpm),
      api: found.apiNpm,
      baseUrl: found.apiUrl,
      facts: modelFacts(found.reasoning, found.maxTokens)
    }
  }
  const found = (await ctx.deps.piCatalog()).find(
    (m) => m.provider === ctx.provider && m.id === ctx.model
  )
  if (!found) return null
  return {
    compatible: found.api === PI_COMPATIBLE_API,
    api: found.api || undefined,
    baseUrl: found.baseUrl,
    facts: modelFacts(found.reasoning, found.maxTokens)
  }
}

function modelFacts(reasoning: boolean | undefined, maxTokens: number | undefined): ModelFacts {
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    // A zero limit is a catalog's "unknown", not a limit.
    ...(positive(maxTokens) ? { maxOutputTokens: maxTokens } : {})
  }
}

// ---------------------------------------------------------------------------
// Shared construction
// ---------------------------------------------------------------------------

/**
 * A route authorised by an API key — or by nothing, for a keyless custom
 * endpoint. OpenRouter routes also carry its attribution headers.
 */
function keyedRoute(
  ctx: RouteContext,
  kind: Exclude<JudgeRouteKind, 'chatgpt'>,
  url: string,
  key: string | null,
  facts: ModelFacts
): ResolvedJudgeRoute {
  const { provider, model } = ctx
  return {
    kind,
    wire: wireForKind(kind),
    url,
    model,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(kind === 'openrouter' ? OPENROUTER_ATTRIBUTION : {})
    },
    caps: capsFor(kind, model, { reasoning: facts.reasoning }),
    label: `${provider} · ${model}`,
    account: keyAccount(ctx, key),
    ...(facts.maxOutputTokens !== undefined ? { maxOutputTokens: facts.maxOutputTokens } : {})
  }
}

/**
 * ADR-071 §3's account for a key route: the key's digest, or — keyless — the
 * native key an engine-held credential gets, labelled with the provider id
 * (as `accountIdentityFromAuthEntry` labels one).
 */
function keyAccount(ctx: RouteContext, key: string | null): JudgeRouteAccount {
  const identity: AccountIdentity = key
    ? apiKeyAccountKey(ctx.provider, key)
    : { accountKey: nativeAccountKey(ctx.engine, ctx.provider), accountLabel: ctx.provider }
  return {
    vendorId: ctx.provider,
    accountId: null,
    accountKey: identity.accountKey,
    accountLabel: identity.accountLabel,
    billingType: 'apiKey'
  }
}

/**
 * `<base>` without trailing slashes + the wire's path, or undefined for a base
 * URL that is missing, blank or still a template (`${…}`, an env reference the
 * engine expands and ClaudeUI can't).
 */
function endpointUrl(base: string | undefined, kind: JudgeRouteKind): string | undefined {
  const trimmed = base?.trim()
  if (!trimmed || trimmed.includes('${')) return undefined
  const path = wireForKind(kind) === 'chat' ? '/chat/completions' : '/responses'
  return `${trimmed.replace(/\/+$/, '')}${path}`
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
