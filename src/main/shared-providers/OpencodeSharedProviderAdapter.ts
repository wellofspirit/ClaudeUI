import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import type { CodexCredentialInput } from '../auth/vault/CredentialSync'
import {
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig,
  type NativeOpencodeFields
} from '../opencode/opencode-config'
import { invalidateOpencodeModelCache } from '../opencode/model-discovery'
import type { OpencodeProviderSettings } from '../../shared/types'
import type { SharedProviderDefinition, SharedProviderModel } from '../../shared/shared-provider'

export interface OpencodeSharedProviderAuthTarget {
  setVendorApiKey(vendorId: string, key: string): Promise<void>
  feedOauthCredential(vendorId: string, credential: CodexCredentialInput): Promise<void>
  removeVendorAuth(vendorId: string): Promise<void>
  listVendorCredentialIds?(): Promise<Record<string, 'api' | 'oauth'>>
}

export interface OpencodeSharedProviderAdapterDeps {
  readConfig?: () => NativeOpencodeFields
  writeConfig?: (settings: NativeOpencodeFields) => void
  authTarget?: OpencodeSharedProviderAuthTarget
  invalidateModelCache?: () => void
}

export interface ApplyOpencodeSharedProviderInput {
  definition: SharedProviderDefinition
  previouslyManaged?: boolean
  previousDefinition?: SharedProviderDefinition
}

export interface OpencodeDefaultModel {
  providerId: string
  modelId: string
}

/** Compiles ClaudeUI-managed routes into OpenCode's native provider/auth surfaces. */
export class OpencodeSharedProviderAdapter {
  private readonly readConfig: () => NativeOpencodeFields
  private readonly writeConfig: (settings: NativeOpencodeFields) => void
  private readonly authTarget: OpencodeSharedProviderAuthTarget
  private readonly invalidateModelCache: () => void

  constructor(deps: OpencodeSharedProviderAdapterDeps = {}) {
    this.readConfig = deps.readConfig ?? readOpencodeNativeConfig
    this.writeConfig = deps.writeConfig ?? writeOpencodeNativeConfig
    this.authTarget = deps.authTarget ?? opencodeAuthProvider
    this.invalidateModelCache = deps.invalidateModelCache ?? invalidateOpencodeModelCache
  }

  inspectCollision(definition: SharedProviderDefinition): boolean {
    if (definition.kind === 'subscription') return false
    return this.readConfig().providers?.[opencodeProviderId(definition)] !== undefined
  }

  applyDefinitionRoute({
    definition,
    previouslyManaged = false,
    previousDefinition
  }: ApplyOpencodeSharedProviderInput): void {
    if (definition.kind === 'subscription') return
    if (!definition.routes.opencode.enabled) {
      this.removeDefinitionRoute(previousDefinition ?? definition)
      return
    }

    const providerId = opencodeProviderId(definition)
    const current = this.readConfig()
    const compiled = compileProvider(definition)
    const previous = previousDefinition ?? definition
    const previousProviderId = opencodeProviderId(previous)

    if (previouslyManaged && previousProviderId !== providerId) {
      const newProvider = current.providers?.[providerId]
      if (newProvider !== undefined) {
        throw new Error(`OpenCode provider collision: ${providerId}`)
      }
      if (!sameJson(current.providers?.[previousProviderId], compileProvider(previous))) {
        throw new Error(`OpenCode provider changed outside ClaudeUI: ${previousProviderId}`)
      }
      const providers = { ...current.providers }
      delete providers[previousProviderId]
      providers[providerId] = compiled
      this.writeConfig({ ...current, providers })
      this.invalidateModelCache()
      return
    }

    const existing = current.providers?.[providerId]
    if (existing !== undefined && !previouslyManaged) {
      throw new Error(`OpenCode provider collision: ${providerId}`)
    }
    if (
      previouslyManaged &&
      existing !== undefined &&
      !sameJson(existing, compileProvider(previous))
    ) {
      throw new Error(`OpenCode provider changed outside ClaudeUI: ${providerId}`)
    }
    if (sameJson(existing, compiled)) return

    this.writeConfig({
      ...current,
      providers: { ...current.providers, [providerId]: compiled }
    })
    this.invalidateModelCache()
  }

  /** Remove the exact native definition compiled from the prior shared definition. */
  removeDefinitionRoute(previousDefinition: SharedProviderDefinition): void {
    if (previousDefinition.kind === 'subscription') return

    const providerId = opencodeProviderId(previousDefinition)
    const current = this.readConfig()
    if (!sameJson(current.providers?.[providerId], compileProvider(previousDefinition))) return

    const providers = { ...current.providers }
    delete providers[providerId]
    this.writeConfig({ ...current, providers })
    this.invalidateModelCache()
  }

  async vendApiKey(definition: SharedProviderDefinition, apiKey: string): Promise<void> {
    if (definition.kind === 'subscription') {
      throw new Error('Subscription providers require OAuth credentials')
    }
    if (!definition.routes.opencode.enabled) return
    await this.authTarget.setVendorApiKey(opencodeProviderId(definition), apiKey)
    this.invalidateModelCache()
  }

  async vendOauthCredential(
    definition: SharedProviderDefinition,
    credential: CodexCredentialInput
  ): Promise<void> {
    if (definition.kind !== 'subscription') {
      throw new Error('Custom providers require API-key credentials')
    }
    if (!definition.routes.opencode.enabled) return
    await this.authTarget.feedOauthCredential(opencodeProviderId(definition), credential)
    this.invalidateModelCache()
  }

  async removeCredential(definition: SharedProviderDefinition): Promise<void> {
    await this.authTarget.removeVendorAuth(opencodeProviderId(definition))
    this.invalidateModelCache()
  }

  hasDefinition(definition: SharedProviderDefinition): boolean {
    if (definition.kind !== 'custom') return true
    return sameJson(
      this.readConfig().providers?.[opencodeProviderId(definition)],
      compileProvider(definition)
    )
  }

  async hasCredential(definition: SharedProviderDefinition): Promise<boolean> {
    return !!(await this.authTarget.listVendorCredentialIds?.())?.[opencodeProviderId(definition)]
  }

  resolveDefaultModel(definition: SharedProviderDefinition): OpencodeDefaultModel | null {
    const defaultModel = definition.routes.opencode.defaultModel
    if (!definition.routes.opencode.enabled || !defaultModel) return null

    const model = definition.models.find((candidate) => candidate.id === defaultModel)
    if (!model) return null
    const override = model.harnessOverrides?.opencode
    if (override?.enabled === false || override?.available === false) return null

    return { providerId: opencodeProviderId(definition), modelId: override?.id ?? model.id }
  }
}

function opencodeProviderId(definition: SharedProviderDefinition): string {
  return definition.routes.opencode.providerId ?? definition.id
}

function compileProvider(definition: SharedProviderDefinition): OpencodeProviderSettings {
  if (!definition.protocol || !definition.baseUrl) {
    throw new Error('Custom OpenCode providers require protocol and baseUrl')
  }
  return {
    name: definition.name,
    npm: npmForProtocol(definition.protocol),
    baseURL: definition.baseUrl,
    models: definition.models.flatMap(compileModel)
  }
}

function npmForProtocol(protocol: NonNullable<SharedProviderDefinition['protocol']>): string {
  switch (protocol) {
    case 'openai-completions':
      return '@ai-sdk/openai-compatible'
    case 'openai-responses':
      return '@ai-sdk/openai'
    case 'anthropic-messages':
      return '@ai-sdk/anthropic'
  }
}

function compileModel(model: SharedProviderModel): Array<{ id: string; name?: string }> {
  const override = model.harnessOverrides?.opencode
  if (override?.enabled === false || override?.available === false) return []
  return [{ id: override?.id ?? model.id, ...(model.name ? { name: model.name } : {}) }]
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
