import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type SharedProviderDefinition,
  type SharedProviderModel,
  validateSharedProviderId
} from '../../shared/shared-provider'

const PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

export function sharedProvidersDir(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'providers')
}

export function sharedProviderPath(id: string): string {
  validateSharedProviderId(id)
  return path.join(sharedProvidersDir(), `${id}.json`)
}

export function chatgptProvider(): SharedProviderDefinition {
  return {
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'subscription',
    models: [],
    managed: true,
    routes: {
      pi: { enabled: true, providerId: 'openai-codex' },
      opencode: { enabled: true, providerId: 'openai' }
    }
  }
}

export class SharedProviderRepository {
  list(): SharedProviderDefinition[] {
    const providers = [this.readChatgpt()]
    try {
      for (const name of fs.readdirSync(sharedProvidersDir())) {
        if (!name.endsWith('.json') || name === 'chatgpt.json') continue
        const id = name.slice(0, -'.json'.length)
        try {
          validateSharedProviderId(id)
          const value: unknown = JSON.parse(
            fs.readFileSync(path.join(sharedProvidersDir(), name), 'utf8')
          )
          if (isDefinition(value) && value.id === id) providers.push(value)
        } catch {
          // Individual malformed files must not make provider discovery fail.
        }
      }
    } catch {
      // The directory is absent until the first custom provider is saved.
    }
    return providers
  }

  get(id: string): SharedProviderDefinition | null {
    validateSharedProviderId(id)
    return this.list().find((provider) => provider.id === id) ?? null
  }

  save(provider: SharedProviderDefinition): void {
    validateDefinition(provider)
    const normalized = provider.id === 'chatgpt' ? normalizeChatgpt(provider) : provider
    this.ensureDir()
    this.writeAtomic(sharedProviderPath(normalized.id), normalized)
  }

  remove(id: string): void {
    validateSharedProviderId(id)
    if (id === 'chatgpt') throw new Error('ChatGPT is built-in')
    try {
      fs.unlinkSync(sharedProviderPath(id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private readChatgpt(): SharedProviderDefinition {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(sharedProviderPath('chatgpt'), 'utf8'))
      if (isDefinition(value)) return normalizeChatgpt(value)
    } catch {
      // Built-in defaults remain available when the optional override is absent or invalid.
    }
    return chatgptProvider()
  }

  private ensureDir(): void {
    fs.mkdirSync(sharedProvidersDir(), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') fs.chmodSync(sharedProvidersDir(), 0o700)
  }

  private writeAtomic(target: string, value: SharedProviderDefinition): void {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600)
      fs.renameSync(temporary, target)
      if (process.platform !== 'win32') fs.chmodSync(target, 0o600)
    } catch (err) {
      try {
        fs.unlinkSync(temporary)
      } catch {
        /* best-effort cleanup */
      }
      throw err
    }
  }
}

function normalizeChatgpt(value: SharedProviderDefinition): SharedProviderDefinition {
  const defaults = chatgptProvider()
  return {
    ...defaults,
    name: typeof value.name === 'string' && value.name ? value.name : defaults.name,
    models: value.models,
    routes: {
      pi: { ...value.routes.pi, providerId: 'openai-codex' },
      opencode: { ...value.routes.opencode, providerId: 'openai' }
    }
  }
}

function isDefinition(value: unknown): value is SharedProviderDefinition {
  try {
    validateDefinition(value as SharedProviderDefinition)
    return true
  } catch {
    return false
  }
}

function validateDefinition(provider: SharedProviderDefinition): void {
  if (!provider || provider.managed !== true || typeof provider.name !== 'string' || !provider.name)
    throw new Error('Invalid shared provider definition')
  validateSharedProviderId(provider.id)
  if (provider.kind !== 'subscription' && provider.kind !== 'custom')
    throw new Error('Invalid shared provider kind')
  if (
    !Array.isArray(provider.models) ||
    !provider.models.every(isModel) ||
    new Set(provider.models.map((model) => model.id)).size !== provider.models.length
  )
    throw new Error('Invalid shared provider models')
  if (!isRoute(provider.routes?.pi) || !isRoute(provider.routes?.opencode))
    throw new Error('Invalid shared provider routes')
  if (provider.protocol !== undefined && !PROTOCOLS.has(provider.protocol))
    throw new Error('Invalid shared provider protocol')
  if (
    provider.kind === 'custom' &&
    (!PROTOCOLS.has(provider.protocol ?? '') ||
      typeof provider.baseUrl !== 'string' ||
      !provider.baseUrl)
  )
    throw new Error('Custom providers require protocol and baseUrl')
}

function isRoute(value: unknown): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { enabled?: unknown }).enabled !== 'boolean'
  )
    return false
  const route = value as { providerId?: unknown; defaultModel?: unknown }
  return (
    (route.providerId === undefined || isNativeId(route.providerId)) &&
    (route.defaultModel === undefined ||
      (typeof route.defaultModel === 'string' && !!route.defaultModel))
  )
}

function isModel(value: SharedProviderModel): boolean {
  if (!value || typeof value.id !== 'string' || !value.id.trim()) return false
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim())) return false
  if (value.reasoning !== undefined && typeof value.reasoning !== 'boolean') return false
  if (value.vision !== undefined && typeof value.vision !== 'boolean') return false
  if (!isPositiveInteger(value.contextWindow) || !isPositiveInteger(value.maxTokens)) return false
  if (
    value.harnessOverrides &&
    Object.keys(value.harnessOverrides).some((key) => key !== 'pi' && key !== 'opencode')
  )
    return false
  return (
    !value.harnessOverrides ||
    Object.values(value.harnessOverrides).every(
      (override) =>
        !override ||
        (typeof override === 'object' &&
          (override.id === undefined || (typeof override.id === 'string' && !!override.id)) &&
          (override.enabled === undefined || typeof override.enabled === 'boolean') &&
          (override.available === undefined || typeof override.available === 'boolean') &&
          (override.default === undefined || typeof override.default === 'boolean'))
    )
  )
}

function isPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

function isNativeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) &&
    value !== '__proto__' &&
    value !== 'constructor'
  )
}
