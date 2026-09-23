/**
 * @vitest-environment node
 *
 * ADR-074 §2 — `models:set-provider-allowlist`, the ONE writer of a provider's
 * model allowlist for either engine, and `config:save-opencode-settings`
 * no longer writing one at all.
 *
 * `engines/<id>.json` is an in-memory map behind a mocked `ui-config`, so what
 * is pinned is exactly what each call writes: one leaf, siblings untouched, an
 * emptied map (and an emptied block) removed rather than kept, and the right
 * engine's model cache dropped. The perimeter (engine pair, id-segment guard,
 * payload shape) refuses before anything is written.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EngineConfig } from '../../../shared/types'

const store = vi.hoisted(() => ({ files: {} as Record<string, unknown> }))

const uiConfigMocks = vi.hoisted(() => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn((id: string) => structuredClone(store.files[id] ?? {})),
  saveEngineConfig: vi.fn((id: string, config: unknown) => {
    store.files[id] = structuredClone(config)
  }),
  loadVendorConfig: vi.fn(() => ({})),
  saveVendorConfig: vi.fn(),
  loadSharedAutoModeConfig: vi.fn(() => ({})),
  saveSharedAutoModeConfig: vi.fn()
}))
vi.mock('../../../core/services/ui-config', () => uiConfigMocks)

const invalidate = vi.hoisted(() => ({ opencode: vi.fn(), pi: vi.fn() }))
vi.mock('../../../core/opencode/model-discovery', () => ({
  invalidateOpencodeModelCache: invalidate.opencode
}))
vi.mock('../../../core/pi/model-discovery', () => ({ invalidatePiModelCache: invalidate.pi }))

const nativeMocks = vi.hoisted(() => ({
  readOpencodeNativeConfig: vi.fn(() => ({})),
  writeOpencodeNativeConfig: vi.fn(),
  migrateOpencodeConfigToNative: vi.fn()
}))
vi.mock('../../../core/opencode/opencode-config', () => nativeMocks)

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { configCommands } from '../../../core/ipc/config-commands'
import type { SessionManager } from '../../../core/services/session-manager'

const commands = configCommands({} as unknown as SessionManager)

function commandFor(channel: string): (typeof commands)[number] {
  const found = commands.find((c) => c.channel === channel)
  if (!found) throw new Error(`no registration for ${channel}`)
  return found
}

function invoke(channel: string, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> {
  return (commandFor(channel).handler as (...a: unknown[]) => Promise<{ ok: boolean }>)(...args)
}

const file = (id: string): EngineConfig => store.files[id] as EngineConfig

beforeEach(() => {
  store.files = {}
  uiConfigMocks.saveEngineConfig.mockClear()
  invalidate.opencode.mockClear()
  invalidate.pi.mockClear()
})

describe('models:set-provider-allowlist', () => {
  it('is a `config` command', () => {
    expect(commandFor('models:set-provider-allowlist')).toMatchObject({
      capability: 'config',
      kind: 'command'
    })
  })

  it('opencode: sets one provider’s list, keeping siblings and every other block', async () => {
    store.files.opencode = {
      autoMode: { enabled: true },
      opencodeConfig: { modelAllowlist: { openrouter: ['moonshotai/kimi-k3'] } }
    }
    expect(await invoke('models:set-provider-allowlist', 'opencode', 'groq', ['llama-4'])).toEqual({
      ok: true,
      data: undefined
    })
    expect(file('opencode')).toEqual({
      autoMode: { enabled: true },
      opencodeConfig: {
        modelAllowlist: { openrouter: ['moonshotai/kimi-k3'], groq: ['llama-4'] }
      }
    })
    expect(invalidate.opencode).toHaveBeenCalledTimes(1)
    expect(invalidate.pi).not.toHaveBeenCalled()
  })

  it('opencode: null deletes the key, and the LAST key drops `opencodeConfig`', async () => {
    store.files.opencode = {
      autoMode: { enabled: true },
      opencodeConfig: { modelAllowlist: { openrouter: [], groq: ['llama-4'] } }
    }
    await invoke('models:set-provider-allowlist', 'opencode', 'openrouter', null)
    expect(file('opencode').opencodeConfig).toEqual({ modelAllowlist: { groq: ['llama-4'] } })

    await invoke('models:set-provider-allowlist', 'opencode', 'groq', null)
    expect(file('opencode')).toEqual({ autoMode: { enabled: true } })
  })

  it('opencode: `[]` is a real list (none), not "all"', async () => {
    await invoke('models:set-provider-allowlist', 'opencode', 'openrouter', [])
    expect(file('opencode')).toEqual({ opencodeConfig: { modelAllowlist: { openrouter: [] } } })
  })

  it('pi: edits only piConfig.modelAllowlist, keeping the default model', async () => {
    store.files.pi = {
      dispatch: { defaultModel: 'groq/llama-4' },
      piConfig: { defaultModel: 'groq/llama-4', modelAllowlist: { groq: ['llama-4'] } }
    }
    await invoke('models:set-provider-allowlist', 'pi', 'openai-codex', ['gpt-5.6-luna'])
    expect(file('pi')).toEqual({
      dispatch: { defaultModel: 'groq/llama-4' },
      piConfig: {
        defaultModel: 'groq/llama-4',
        modelAllowlist: { groq: ['llama-4'], 'openai-codex': ['gpt-5.6-luna'] }
      }
    })
    expect(invalidate.pi).toHaveBeenCalledTimes(1)
    expect(invalidate.opencode).not.toHaveBeenCalled()

    await invoke('models:set-provider-allowlist', 'pi', 'groq', null)
    await invoke('models:set-provider-allowlist', 'pi', 'openai-codex', null)
    expect(file('pi')).toEqual({
      dispatch: { defaultModel: 'groq/llama-4' },
      piConfig: { defaultModel: 'groq/llama-4' }
    })
  })

  it('pi: a block left empty goes too', async () => {
    store.files.pi = { piConfig: { modelAllowlist: { groq: [] } } }
    await invoke('models:set-provider-allowlist', 'pi', 'groq', null)
    expect(file('pi')).toEqual({})
  })

  it('refuses a bad engine, a traversal id or a malformed list, writing nothing', async () => {
    for (const args of [
      ['claude', 'groq', []],
      ['pi', '../../settings', []],
      ['pi', 'groq', 'llama-4'],
      ['pi', 'groq', [42]],
      ['pi', 'groq', undefined]
    ]) {
      const result = await invoke('models:set-provider-allowlist', ...args)
      expect(result.ok, JSON.stringify(args)).toBe(false)
    }
    expect(uiConfigMocks.saveEngineConfig).not.toHaveBeenCalled()
  })
})

describe('config:save-opencode-settings — never writes the allowlist', () => {
  const stored = {
    autoMode: { enabled: true },
    opencodeConfig: { modelAllowlist: { openrouter: ['moonshotai/kimi-k3'] } }
  }
  beforeEach(() => {
    store.files.opencode = structuredClone(stored)
  })

  // Every settings pane saves the WHOLE object it loaded at mount, allowlist
  // included. Honouring that allowlist is how a stale pane reverted curation.
  it.each([
    ['an empty map', {}],
    ['a different list', { groq: [] }],
    ['an absent one', undefined]
  ])('ignores %s and keeps what is stored', async (_label, modelAllowlist) => {
    await invoke('config:save-opencode-settings', { model: 'x/y', modelAllowlist })
    expect(file('opencode')).toEqual(stored)
    // The native fields still reach opencode's own file.
    expect(nativeMocks.writeOpencodeNativeConfig).toHaveBeenLastCalledWith({ model: 'x/y' })
  })

  it('curation made through the ONE writer survives a stale whole-settings save', async () => {
    // The pane loaded before the Manage sheet curated…
    const loadedAtMount = { model: 'x/y', modelAllowlist: { openrouter: ['moonshotai/kimi-k3'] } }
    // …the sheet sets openrouter back to All models…
    await invoke('models:set-provider-allowlist', 'opencode', 'openrouter', null)
    expect(file('opencode')).toEqual({ autoMode: { enabled: true } })
    // …and the pane's next save must not put the old list back.
    await invoke('config:save-opencode-settings', loadedAtMount)
    expect(file('opencode')).toEqual({ autoMode: { enabled: true } })
  })
})
