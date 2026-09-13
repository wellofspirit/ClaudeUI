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

export interface SharedProviderDefinition {
  id: string
  name: string
  kind: 'subscription' | 'custom'
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
  managed: true
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
 * - `no-models-discovered` — the engine reported no models at all: not installed,
 *                            or discovery failed.
 */
export type SharedProviderRouteDiagnosis =
  'provider-disabled' | 'models-restricted' | 'no-models-discovered'

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
