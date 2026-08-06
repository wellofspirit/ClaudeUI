export type ConfigurableHarnessId = 'pi' | 'opencode'
export type SharedProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

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

export interface SharedProviderDefinition {
  id: string
  name: string
  kind: 'subscription' | 'custom'
  protocol?: SharedProviderProtocol
  baseUrl?: string
  models: SharedProviderModel[]
  routes: Record<ConfigurableHarnessId, SharedProviderRoute>
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
  | 'provider-disabled'
  | 'models-restricted'
  | 'no-models-discovered'

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
