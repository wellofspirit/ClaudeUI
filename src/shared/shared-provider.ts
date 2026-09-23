export type ConfigurableHarnessId = 'pi' | 'opencode'
export type SharedProviderProtocol =
  'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface SharedProviderModel {
  id: string
  name?: string
  reasoning?: boolean
  vision?: boolean
  contextWindow?: number
  maxTokens?: number
  harnessOverrides?: Partial<
    Record<
      ConfigurableHarnessId,
      { id?: string; enabled?: boolean; available?: boolean; default?: boolean }
    >
  >
}

export interface SharedProviderRoute {
  enabled: boolean
  providerId?: string
  defaultModel?: string
}

/**
 * The NATIVE provider id ChatGPT's route lands on in each configurable harness
 * (ADR-068 §3). The managed `chatgpt` definition pins both — the mapping is not
 * the user's to change — and `SharedProviderRepository.normalizeChatgpt` rewrites
 * a hand-edited file back to it.
 *
 * Lives here rather than beside the definition because the RENDERER needs the
 * same fact: "does this picker group belong to the ChatGPT route?" is asked of
 * a `(engineId, vendorId)` pair, and answering it from a second hard-coded copy
 * is how a route rename would silently stop offering a sign-in.
 */
export const CHATGPT_ROUTE_PROVIDER_IDS: Record<ConfigurableHarnessId, string> = {
  pi: 'openai-codex',
  opencode: 'openai'
}

/**
 * One stored subscription account, as everything OUTSIDE the vault sees it
 * (ADR-068 §2): an id to name it by, and the identity claims read off the JWT.
 * Never any token material.
 */
export interface SharedProviderAccountSummary {
  id: string
  email?: string
  accountId?: string
  planType?: string
}

/** {@link SharedProviderAccountSummary} plus what the refresher knows about it. */
export interface SharedProviderAccountStatus extends SharedProviderAccountSummary {
  expiresAt: number
  needsReauth: boolean
}

/** What `provider-account:list` answers: the stored accounts and the policy over them. */
export interface SharedProviderAccountList {
  activeId: string | null
  perSession: boolean
  accounts: SharedProviderAccountStatus[]
}

/**
 * What a shared definition IS (ADR-074 §6):
 *
 * - `subscription` — ChatGPT: OAuth accounts in the vault, vended to each engine.
 * - `custom` — an endpoint ClaudeUI projects into each engine's own provider
 *   config (`protocol` + `baseUrl` + `models`), keyed by an id ClaudeUI owns.
 * - `catalog` — a provider every engine ALREADY knows (`openrouter`,
 *   `anthropic`, …): nothing is projected, only the API key, stored once in the
 *   vault and delivered to each enabled engine under `routes.<engine>.providerId`
 *   (default: `id`). No `protocol`, no `baseUrl`, `models: []` — the engines'
 *   own catalogs list the models.
 */
export type SharedProviderKind = 'subscription' | 'custom' | 'catalog'

export interface SharedProviderDefinition {
  id: string
  name: string
  kind: SharedProviderKind
  protocol?: SharedProviderProtocol
  baseUrl?: string
  models: SharedProviderModel[]
  routes: Record<ConfigurableHarnessId, SharedProviderRoute>
  /**
   * Account policy for a `kind: 'subscription'` provider (ADR-068 §2).
   * `perSession` off (the default, and the meaning of an absent value) means one
   * ACTIVE account for everything; on, a session may pin one of the stored
   * accounts. Meaningless on a custom provider, which holds one API key.
   */
  accounts?: { perSession: boolean }
  /**
   * One model list for every engine, or one per engine (ADR-074 §3). Absent:
   * derived from the engines' own lists by `effectiveCuration` — linked iff
   * they agree — so an existing install needs no migration write.
   */
  curation?: SharedProviderCuration
  managed: true
}

/**
 * The provider-level model list. `models` are CANONICAL ids — the definition's
 * own model ids for a custom provider, the bare ids both engines share for
 * ChatGPT and a catalog provider — and absent means All models. While `linked`
 * it is the source of truth, projected into each enabled engine's allowlist
 * under that engine's ids; unlinked, each engine's own list is.
 */
export interface SharedProviderCuration {
  linked: boolean
  models?: string[]
}

/**
 * Why an enabled, credentialed route still surfaces zero models.
 *
 * A bare "delivered · 0 models" is what made a real failure opaque: ChatGPT's
 * credential was being vended to opencode correctly, but opencode's
 * `disabled_providers` hid the provider, so every model came back unavailable
 * and the status had nothing to say about it. These codes name the cause so the
 * next instance diagnoses itself.
 *
 * - `provider-disabled`    — the engine's own provider veto hides it (opencode's
 *                            `disabled_providers`). The credential is fine.
 * - `models-restricted`    — a per-provider model allowlist filters every model
 *                            out (an empty allowlist surfaces nothing).
 * - `no-credential`        — the engine reports models, but none for this
 *                            provider id: no usable key, or a broken entry
 *                            (pi's `models.json`).
 * - `no-models-discovered` — the engine reported no models at all: not installed,
 *                            or discovery failed.
 */
export type SharedProviderRouteDiagnosis =
  'provider-disabled' | 'models-restricted' | 'no-credential' | 'no-models-discovered'

export interface SharedProviderStatus {
  id: string
  connected: boolean
  modelCount?: number
  routes: Record<
    ConfigurableHarnessId,
    {
      enabled: boolean
      delivered: boolean
      modelCount?: number
      error?: string
      /**
       * Set only when the route is enabled and surfaces zero models. Distinct
       * from `error`, which means an operation FAILED — a diagnosis is a healthy
       * route with a configuration reason for being empty.
       */
      diagnosis?: SharedProviderRouteDiagnosis
    }
  >
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

export function validateSharedProviderId(id: string): void {
  if (!PROVIDER_ID.test(id)) throw new Error(`Invalid shared provider id: ${id}`)
}
