import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderRouteDiagnosis
} from '../../shared/shared-provider'
import { isPiModelAllowed } from '../../shared/pi-model-allowlist'
import { piAgentDir } from '../services/pi-session-list'
import { loadEngineConfig } from '../services/ui-config'
import { getPiModelCatalog, invalidatePiModelCache } from '../pi/model-discovery'
import type { PiModel } from '../pi/pi-protocol'
import { PI_NATIVE_VENDOR_IDS } from '../auth/pi-vendor-ids'

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 16_384

/**
 * The `apiKey` written into a keyless custom provider's models.json entry
 * (ADR-074 §4). pi omits a provider with no usable credential from
 * `get_available_models` (`vendor/pi-cli/pi/docs/models.md`: "The dummy key
 * makes the model available"), so a self-hosted endpoint added with the key
 * left blank would never reach pi's picker without one.
 *
 * Safe because pi resolves credentials `--api-key` → `auth.json` →
 * models.json `apiKey` → env: a real key vended to auth.json by
 * {@link PiSharedProviderAdapter.vendApiKey} still wins. It never goes into
 * auth.json itself — `hasCredential` reads auth.json ids, and a placeholder
 * there would report a keyless provider as connected.
 */
export const CLAUDEUI_KEYLESS_PLACEHOLDER = 'claudeui-no-key'

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
  /** pi's UNFILTERED catalog — `getPiModelCatalog()` (cached, [] on failure). */
  loadCatalog?: () => Promise<PiModel[]>
  /** `piConfig.modelAllowlist`, as `loadEngineConfig('pi')` normalises it. */
  readModelAllowlist?: () => Readonly<Record<string, readonly string[]>> | undefined
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
  private readonly loadCatalog: () => Promise<PiModel[]>
  private readonly readModelAllowlist: () => Readonly<Record<string, readonly string[]>> | undefined

  constructor(private readonly deps: PiSharedProviderAdapterDeps) {
    this.modelsPath = deps.modelsPath ?? path.join(piAgentDir(), 'models.json')
    this.invalidateModelCache = deps.invalidateModelCache ?? invalidatePiModelCache
    this.loadCatalog = deps.loadCatalog ?? getPiModelCatalog
    this.readModelAllowlist =
      deps.readModelAllowlist ?? (() => loadEngineConfig('pi').piConfig?.modelAllowlist)
  }

  /**
   * Why an enabled pi route surfaces zero models (ADR-074 §5) — the question
   * `OpencodeSharedProviderAdapter.diagnoseZeroModels` answers for opencode,
   * asked of pi's unfiltered catalog and its per-provider allowlist.
   */
  async diagnoseZeroModels(
    definition: SharedProviderDefinition
  ): Promise<SharedProviderRouteDiagnosis> {
    return diagnosePiZeroModels(
      nativeProviderId(definition),
      await this.loadCatalog(),
      this.readModelAllowlist()
    )
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

/**
 * The pure half of {@link PiSharedProviderAdapter.diagnoseZeroModels}, most
 * general cause last:
 *
 * - pi reported nothing at all → `no-models-discovered` (not installed, no
 *   auth anywhere, or the probe failed);
 * - it reported models, none under this provider id → `no-credential` (pi
 *   omits a provider it has no usable key for, and a broken `models.json`
 *   entry looks the same from here);
 * - the provider has models but its allowlist key admits none of them →
 *   `models-restricted`.
 *
 * Anything else — pi offers models the allowlist admits, yet the route counts
 * zero — has no more precise answer than `no-models-discovered`.
 */
export function diagnosePiZeroModels(
  providerId: string,
  catalog: readonly PiModel[],
  allowlist: Readonly<Record<string, readonly string[]>> | undefined
): SharedProviderRouteDiagnosis {
  if (catalog.length === 0) return 'no-models-discovered'
  const own = catalog.filter((model) => model.provider === providerId)
  if (own.length === 0) return 'no-credential'
  if (!own.some((model) => isPiModelAllowed(allowlist, providerId, model.id))) {
    return 'models-restricted'
  }
  return 'no-models-discovered'
}

export function nativeProviderId(definition: SharedProviderDefinition): string {
  return (
    definition.routes.pi.providerId ??
    (definition.id === 'chatgpt' ? 'openai-codex' : definition.id)
  )
}

/**
 * The `providers.<id>` keys in models.json that this adapter's projection
 * CURRENTLY owns, given the shared-provider definitions on disk.
 *
 * The membership test is {@link PiSharedProviderAdapter.applyDefinition}'s own
 * first three lines, in its order: ChatGPT is vended as a native credential and
 * never projected, a disabled pi route is removed rather than written, and a
 * non-custom provider writes no entry at all. Exported (rather than reproduced
 * by the caller) so the raw models.json editor's ownership guard — which must
 * refuse to hand-edit exactly these entries, since the next projection sync
 * would clobber the edit — cannot drift from what the writer actually owns.
 *
 * Deduped: two definitions resolving to one native id is a collision the service
 * rejects at save time, but a hand-written definition file can still produce it,
 * and "which ids are managed" is a set either way.
 */
export function managedPiProviderIds(definitions: readonly SharedProviderDefinition[]): string[] {
  return [
    ...new Set(
      definitions.flatMap((definition) =>
        definition.id !== 'chatgpt' && definition.kind === 'custom' && definition.routes.pi.enabled
          ? [nativeProviderId(definition)]
          : []
      )
    )
  ]
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
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

/**
 * `compiled` over `existing`, keeping every native field ClaudeUI does not own.
 *
 * `apiKey` is one of those: an existing value of any shape (a literal, `$ENV`,
 * `!command`) is left untouched, and only an entry with none gains
 * {@link CLAUDEUI_KEYLESS_PLACEHOLDER}. It stays outside
 * {@link managedProviderProjection}, so entries written before the placeholder
 * existed still read as unchanged.
 */
function mergeProvider(existing: unknown, compiled: PiProviderConfig): Record<string, unknown> {
  const merged = mergeManagedFields(existing, compiled)
  if (!isNonEmptyString(merged.apiKey)) merged.apiKey = CLAUDEUI_KEYLESS_PLACEHOLDER
  return merged
}

function mergeManagedFields(
  existing: unknown,
  compiled: PiProviderConfig
): Record<string, unknown> {
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
