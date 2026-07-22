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

export interface SharedProviderStatus {
  id: string
  connected: boolean
  modelCount?: number
  routes: Record<
    ConfigurableHarnessId,
    { enabled: boolean; delivered: boolean; modelCount?: number; error?: string }
  >
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

export function validateSharedProviderId(id: string): void {
  if (!PROVIDER_ID.test(id)) throw new Error(`Invalid shared provider id: ${id}`)
}
