import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import type { CodexCredentialInput } from '../auth/vault/CredentialSync'
import {
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig,
  type NativeOpencodeFields
} from '../opencode/opencode-config'
import { invalidateOpencodeModelCache } from '../opencode/model-discovery'
import { loadEngineConfig } from '../services/ui-config'
import type { OpencodeProviderModelSettings, OpencodeProviderSettings } from '../../shared/types'
import type {
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderRouteDiagnosis
} from '../../shared/shared-provider'

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
  /** ClaudeUI's per-provider model allowlist, for zero-model diagnosis. */
  readModelAllowlist?: () => Record<string, string[]>
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
  private readonly readModelAllowlist: () => Record<string, string[]>

  constructor(deps: OpencodeSharedProviderAdapterDeps = {}) {
    this.readConfig = deps.readConfig ?? readOpencodeNativeConfig
    this.writeConfig = deps.writeConfig ?? writeOpencodeNativeConfig
    this.authTarget = deps.authTarget ?? opencodeAuthProvider
    this.invalidateModelCache = deps.invalidateModelCache ?? invalidateOpencodeModelCache
    this.readModelAllowlist =
      deps.readModelAllowlist ??
      (() => loadEngineConfig('opencode').opencodeConfig?.modelAllowlist ?? {})
  }

  /**
   * Why this route surfaces zero models despite being enabled and credentialed.
   *
   * Both causes collapse to the same observable at the aggregate layer — the
   * provider simply has no group in opencode's reported catalog — so they can
   * only be told apart from opencode's own config. `disabled_providers` is
   * reported first: it is the more fundamental veto (fixing the allowlist alone
   * would change nothing) and the easier one to leave set by accident.
   */
  diagnoseZeroModels(definition: SharedProviderDefinition): SharedProviderRouteDiagnosis {
    const providerId = opencodeProviderId(definition)
    try {
      if ((this.readConfig().disabledProviders ?? []).includes(providerId)) {
        return 'provider-disabled'
      }
      const allowed = this.readModelAllowlist()[providerId]
      if (allowed !== undefined && allowed.length === 0) return 'models-restricted'
    } catch {
      // opencode's config is optional — fall through to the generic cause.
    }
    return 'no-models-discovered'
  }

  // Only a CUSTOM definition projects a provider block into opencode's config.
  // ChatGPT and a catalog provider (ADR-074 §6) name one opencode already knows,
  // so there is nothing of ours to write, collide with, or remove — only a key.
  inspectCollision(definition: SharedProviderDefinition): boolean {
    if (definition.kind !== 'custom') return false
    return this.readConfig().providers?.[opencodeProviderId(definition)] !== undefined
  }

  applyDefinitionRoute({
    definition,
    previouslyManaged = false,
    previousDefinition
  }: ApplyOpencodeSharedProviderInput): void {
    if (definition.kind !== 'custom') return
    if (!definition.routes.opencode.enabled) {
      this.removeDefinitionRoute(previousDefinition ?? definition)
      return
    }

    const providerId = opencodeProviderId(definition)
    const current = this.readConfig()
    const compiled = compileProvider(definition)
    const previous = previousDefinition ?? definition
    const previousProviderId = opencodeProviderId(previous)
    const previousCompiled = compileProvider(previous)

    if (previouslyManaged && previousProviderId !== providerId) {
      const newProvider = current.providers?.[providerId]
      if (newProvider !== undefined) {
        throw new Error(`OpenCode provider collision: ${providerId}`)
      }
      const moved = current.providers?.[previousProviderId]
      if (!sameIdentity(moved, previousCompiled)) {
        throw new Error(`OpenCode provider changed outside ClaudeUI: ${previousProviderId}`)
      }
      const providers = { ...current.providers }
      delete providers[previousProviderId]
      providers[providerId] = mergeCapabilities(moved, compiled, previousCompiled)
      this.writeConfig({ ...current, providers })
      this.invalidateModelCache()
      return
    }

    const existing = current.providers?.[providerId]
    if (existing !== undefined && !previouslyManaged) {
      throw new Error(`OpenCode provider collision: ${providerId}`)
    }
    if (previouslyManaged && existing !== undefined && !sameIdentity(existing, previousCompiled)) {
      throw new Error(`OpenCode provider changed outside ClaudeUI: ${providerId}`)
    }
    const target = mergeCapabilities(existing, compiled, previousCompiled)
    if (sameJson(existing, target)) return

    this.writeConfig({
      ...current,
      providers: { ...current.providers, [providerId]: target }
    })
    this.invalidateModelCache()
  }

  /** Remove the exact native definition compiled from the prior shared definition. */
  removeDefinitionRoute(previousDefinition: SharedProviderDefinition): void {
    if (previousDefinition.kind !== 'custom') return

    const providerId = opencodeProviderId(previousDefinition)
    const current = this.readConfig()
    if (!sameIdentity(current.providers?.[providerId], compileProvider(previousDefinition))) return

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
    return sameIdentity(
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

/**
 * The opencode vendor id a definition's opencode route lands on.
 *
 * Exported (rather than re-derived at each call site) because "which native row
 * does this shared definition own" is asked in three places now — this adapter,
 * `decorateSharedProviderClaims` in `session.ipc.ts`, and the provider registry
 * — and the three must never disagree. `PiSharedProviderAdapter.nativeProviderId`
 * is the pi twin.
 */
export function opencodeProviderId(definition: SharedProviderDefinition): string {
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

/**
 * One declared model as opencode's config needs it (ADR-074 slice 10): what it
 * can do and how large it is, which opencode otherwise reads as "nothing" for a
 * model only a config declares (`reasoning`/`attachment` false, `limit` 0). The
 * same defaults pi's projection applies to an absent fact — except the limits,
 * where 0 is opencode's own "unknown". Key order matches the config reader's.
 */
function compileModel(model: SharedProviderModel): OpencodeProviderModelSettings[] {
  const override = model.harnessOverrides?.opencode
  if (override?.enabled === false || override?.available === false) return []
  return [
    {
      id: override?.id ?? model.id,
      ...(model.name ? { name: model.name } : {}),
      reasoning: model.reasoning === true,
      attachment: model.vision === true,
      toolCall: true,
      inputModalities: model.vision ? ['text', 'image'] : ['text'],
      limit: { context: model.contextWindow ?? 0, output: model.maxTokens ?? 0 }
    }
  ]
}

/** The capability leaves of a declared model — ClaudeUI's to seed, the user's to edit. */
const CAPABILITY_KEYS = ['reasoning', 'attachment', 'toolCall', 'inputModalities', 'limit'] as const

/**
 * What identifies the provider block as the one ClaudeUI wrote: its name,
 * adapter, endpoint and model ids and names. A difference here is someone else's
 * provider, or ours changed outside ClaudeUI. The capability leaves are NOT part
 * of it: they are hand-editable (opencode's model editor), and a block written
 * before ClaudeUI declared them (a Spark from before slice 10) has none.
 */
function sameIdentity(
  existing: OpencodeProviderSettings | undefined,
  compiled: OpencodeProviderSettings
): boolean {
  const identity = (value: OpencodeProviderSettings | undefined): unknown =>
    value && {
      name: value.name,
      npm: value.npm,
      baseURL: value.baseURL,
      models: value.models?.map((model) => ({ id: model.id, name: model.name }))
    }
  return sameJson(identity(existing), identity(compiled))
}

/**
 * `compiled`, with each model's capability leaves three-way merged against what
 * the file holds: ClaudeUI's new value where the file has none or still has
 * the value ClaudeUI wrote last (`previous`), the file's where someone edited it
 * since. A refresh therefore updates the details nobody touched, and a hand
 * edit in opencode's model editor survives every sync.
 */
function mergeCapabilities(
  existing: OpencodeProviderSettings | undefined,
  compiled: OpencodeProviderSettings,
  previous: OpencodeProviderSettings
): OpencodeProviderSettings {
  if (!existing) return compiled
  const inFile = new Map((existing.models ?? []).map((model) => [model.id, model]))
  const wrote = new Map((previous.models ?? []).map((model) => [model.id, model]))
  return {
    ...compiled,
    models: compiled.models?.map((model) => {
      const file = inFile.get(model.id)
      if (!file) return model
      const merged: OpencodeProviderModelSettings = {
        id: model.id,
        ...(model.name ? { name: model.name } : {})
      }
      for (const key of CAPABILITY_KEYS) {
        const own = file[key] === undefined || sameJson(file[key], wrote.get(model.id)?.[key])
        const value = own ? model[key] : file[key]
        if (value !== undefined) Object.assign(merged, { [key]: value })
      }
      return merged
    })
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
