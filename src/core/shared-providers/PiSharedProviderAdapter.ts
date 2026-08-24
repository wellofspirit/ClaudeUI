import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SharedProviderDefinition, SharedProviderModel } from '../../shared/shared-provider'
import { piAgentDir } from '../services/pi-session-list'
import { invalidatePiModelCache } from '../pi/model-discovery'
import { PI_NATIVE_VENDOR_IDS } from '../auth/pi-vendor-ids'

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 16_384

export interface PiOauthCredential {
  access: string
  refresh: string
  expires: number
}

/** The only auth operations this adapter needs from PiAuthProvider. */
export interface PiSharedProviderAuthTarget {
  setVendorApiKey(vendorId: string, key: string): Promise<void>
  feedOauthCredential(vendorId: string, credential: PiOauthCredential): Promise<void>
  removeVendorAuth(vendorId: string): Promise<void>
  listVendorCredentialIds?(): Promise<Record<string, 'api' | 'oauth'>>
}

export interface PiSharedProviderAdapterDeps {
  modelsPath?: string
  auth: PiSharedProviderAuthTarget
  invalidateModelCache?: () => void
}

interface PiModelConfig {
  id: string
  name: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
}

interface PiProviderConfig {
  baseUrl: string
  api: NonNullable<SharedProviderDefinition['protocol']>
  models: PiModelConfig[]
}

type PiModelsFile = Record<string, unknown> & { providers?: Record<string, unknown> }

export class PiSharedProviderAdapter {
  private readonly modelsPath: string
  private readonly invalidateModelCache: () => void

  constructor(private readonly deps: PiSharedProviderAdapterDeps) {
    this.modelsPath = deps.modelsPath ?? path.join(piAgentDir(), 'models.json')
    this.invalidateModelCache = deps.invalidateModelCache ?? invalidatePiModelCache
  }

  applyDefinition(
    definition: SharedProviderDefinition,
    previouslyManaged = false,
    previousDefinition: SharedProviderDefinition = definition
  ): void {
    if (definition.id === 'chatgpt') return
    const route = definition.routes.pi
    if (!route.enabled) {
      this.removeDefinition(definition, previousDefinition)
      return
    }
    if (definition.kind !== 'custom') return

    assertNoPiBuiltinCollision(definition)
    const providerId = nativeProviderId(definition)
    const compiled = compileProvider(definition)
    const file = this.readModelsFile()
    const providers = isRecord(file.providers) ? file.providers : {}
    const existing = providers[providerId]
    if (existing !== undefined && !previouslyManaged) {
      throw new Error(`Pi provider collision: ${providerId}`)
    }

    const previousProviderId = nativeProviderId(previousDefinition)
    if (previouslyManaged && previousProviderId !== providerId) {
      if (existing !== undefined) {
        throw new Error(`Pi provider collision: ${providerId}`)
      }
      if (
        !sameManagedProvider(providers[previousProviderId], compileProvider(previousDefinition))
      ) {
        throw new Error(`Pi provider changed outside ClaudeUI: ${previousProviderId}`)
      }
      const { [previousProviderId]: _, ...remainingProviders } = providers
      file.providers = {
        ...remainingProviders,
        [providerId]: mergeProvider(providers[previousProviderId], compiled)
      }
      this.writeModelsFile(file)
      return
    }
    if (
      previouslyManaged &&
      existing !== undefined &&
      !sameManagedProvider(existing, compileProvider(previousDefinition))
    ) {
      throw new Error(`Pi provider changed outside ClaudeUI: ${providerId}`)
    }

    file.providers = {
      ...providers,
      [providerId]: mergeProvider(existing, compiled)
    }
    this.writeModelsFile(file)
  }

  /**
   * Remove only the exact config compiled from `previousDefinition`. Callers
   * changing models or disabling a route must provide the definition that was
   * last applied, rather than the newly persisted definition.
   */
  removeDefinition(
    definition: SharedProviderDefinition,
    previousDefinition: SharedProviderDefinition = definition
  ): void {
    if (previousDefinition.id === 'chatgpt' || previousDefinition.kind !== 'custom') return
    const file = this.readModelsFile()
    if (!isRecord(file.providers)) return
    const providerId = nativeProviderId(previousDefinition)
    if (!sameManagedProvider(file.providers[providerId], compileProvider(previousDefinition)))
      return

    const { [providerId]: _, ...providers } = file.providers
    file.providers = providers
    this.writeModelsFile(file)
  }

  async vendApiKey(definition: SharedProviderDefinition, key: string): Promise<void> {
    if (definition.kind !== 'custom') {
      throw new Error('Pi API keys are only supported for custom providers')
    }
    if (!definition.routes.pi.enabled) return
    assertNoPiBuiltinCollision(definition)
    await this.deps.auth.setVendorApiKey(nativeProviderId(definition), key)
  }

  async vendOauthCredential(
    definition: SharedProviderDefinition,
    credential: PiOauthCredential
  ): Promise<void> {
    if (definition.id !== 'chatgpt') {
      throw new Error('Pi OAuth is only supported for ChatGPT')
    }
    if (!definition.routes.pi.enabled) return
    await this.deps.auth.feedOauthCredential(nativeProviderId(definition), credential)
  }

  async removeCredential(definition: SharedProviderDefinition): Promise<void> {
    // Defense in depth (M-AT4): never delete a built-in pi vendor's native
    // credential on behalf of a COLLIDING custom provider. Such a definition is
    // rejected at save/apply, so this only fires for one persisted before the
    // fix; skipping the delete preserves the user's real native credential.
    // ChatGPT (kind:'subscription') legitimately targets built-in 'openai-codex'
    // and is NOT a collision, so it still removes as before.
    if (isPiBuiltinCollision(definition)) return
    await this.deps.auth.removeVendorAuth(nativeProviderId(definition))
  }

  hasDefinition(definition: SharedProviderDefinition): boolean {
    if (definition.kind !== 'custom') return true
    const provider = this.readModelsFile().providers?.[nativeProviderId(definition)]
    return sameManagedProvider(provider, compileProvider(definition))
  }

  async hasCredential(definition: SharedProviderDefinition): Promise<boolean> {
    return !!(await this.deps.auth.listVendorCredentialIds?.())?.[nativeProviderId(definition)]
  }

  /** Resolve a canonical shared-model id to Pi's `<provider>/<model>` value. */
  resolveDefaultModel(definition: SharedProviderDefinition): string | undefined {
    const defaultModel = definition.routes.pi.defaultModel
    if (!definition.routes.pi.enabled || !defaultModel) return undefined
    const model = definition.models.find((candidate) => candidate.id === defaultModel)
    if (
      !model ||
      model.harnessOverrides?.pi?.enabled === false ||
      model.harnessOverrides?.pi?.available === false
    )
      return undefined
    const modelId = model?.harnessOverrides?.pi?.id ?? defaultModel
    return `${nativeProviderId(definition)}/${modelId}`
  }

  private readModelsFile(): PiModelsFile {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.modelsPath, 'utf8'))
      return isRecord(value) ? value : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private writeModelsFile(value: PiModelsFile): void {
    const dir = path.dirname(this.modelsPath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
    const temporary = `${this.modelsPath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600)
      fs.renameSync(temporary, this.modelsPath)
      if (process.platform !== 'win32') fs.chmodSync(this.modelsPath, 0o600)
      this.invalidateModelCache()
    } catch (error) {
      try {
        fs.unlinkSync(temporary)
      } catch {
        // Best-effort cleanup after a failed atomic write.
      }
      throw error
    }
  }
}

function compileProvider(definition: SharedProviderDefinition): PiProviderConfig {
  if (!definition.protocol || !definition.baseUrl)
    throw new Error('Custom Pi providers require protocol and baseUrl')
  return {
    baseUrl: definition.baseUrl,
    api: definition.protocol,
    models: definition.models.flatMap((model) => {
      if (
        model.harnessOverrides?.pi?.enabled === false ||
        model.harnessOverrides?.pi?.available === false
      )
        return []
      return [compileModel(model)]
    })
  }
}

function compileModel(model: SharedProviderModel): PiModelConfig {
  return {
    id: model.harnessOverrides?.pi?.id ?? model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    input: model.vision ? ['text', 'image'] : ['text'],
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS
  }
}

export function nativeProviderId(definition: SharedProviderDefinition): string {
  return (
    definition.routes.pi.providerId ??
    (definition.id === 'chatgpt' ? 'openai-codex' : definition.id)
  )
}

/**
 * True when a CUSTOM shared provider's effective pi providerId collides with a
 * built-in native pi vendor id (M-AT4). Only custom providers are checked —
 * the built-in ChatGPT provider (kind:'subscription') legitimately targets the
 * native 'openai-codex' and must never be flagged.
 */
export function isPiBuiltinCollision(definition: SharedProviderDefinition): boolean {
  return definition.kind === 'custom' && PI_NATIVE_VENDOR_IDS.has(nativeProviderId(definition))
}

function assertNoPiBuiltinCollision(definition: SharedProviderDefinition): void {
  if (isPiBuiltinCollision(definition)) {
    throw new Error(
      `Pi provider id "${nativeProviderId(definition)}" collides with a built-in pi vendor; choose a different provider id`
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Ignore native extensions while retaining every field ClaudeUI owns. */
function sameManagedProvider(left: unknown, right: PiProviderConfig): boolean {
  return sameJson(managedProviderProjection(left), right)
}

function managedProviderProjection(value: unknown): unknown {
  if (!isRecord(value)) return value
  const models = value.models
  return {
    baseUrl: value.baseUrl,
    api: value.api,
    models: Array.isArray(models)
      ? models.map((model) => {
          if (!isRecord(model)) return model
          return {
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            input: model.input,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens
          }
        })
      : models
  }
}

function mergeProvider(existing: unknown, compiled: PiProviderConfig): Record<string, unknown> {
  if (!isRecord(existing)) return { ...compiled }
  const existingModels = new Map(
    Array.isArray(existing.models)
      ? existing.models.flatMap((model) =>
          isRecord(model) && typeof model.id === 'string' ? [[model.id, model]] : []
        )
      : []
  )
  return {
    ...existing,
    ...compiled,
    models: compiled.models.map((model) => ({ ...existingModels.get(model.id), ...model }))
  }
}
