/**
 * Tests for provider-management.ts — enable/disable vs remove.
 *
 * REGRESSION ANCHOR (the bug that started this): removing a provider MUST clear
 * its own `disabled_providers` entry. The original defect was a veto that
 * outlived what it vetoed — ChatGPT's credential was deleted and the id was
 * disabled, CredentialSync re-fed the credential, and the surviving veto kept
 * opencode from ever reporting the provider again, so the route sat at 0 models.
 *
 * Other guards:
 * - Disable and remove are genuinely different writes: disable never touches
 *   credentials or declarations; remove never leaves either behind.
 * - `kind` is honoured exactly ('credential' must not delete a declaration).
 * - The declaration delete and the veto cleanup are ONE config write.
 * - The per-provider model allowlist is cleared, so a later re-add cannot
 *   inherit an empty allowlist and present another "0 models" state.
 * - A provider an ENABLED shared route delivers is refused for every kind,
 *   before any credential call or config write (a stale surface asked).
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NativeOpencodeFields } from '../opencode-config'
import type { EngineConfig } from '../../../shared/types'

/** Every side effect in the order it happened: the order is part of the contract. */
const calls: string[] = []
const removeVendorAuth = vi.fn(
  async (id: string): Promise<void> => void calls.push(`credential ${id}`)
)
const writeNative = vi.fn<(fields: NativeOpencodeFields) => void>(() => void calls.push('config'))
const invalidate = vi.fn()
const saveEngine = vi.fn()
let native: NativeOpencodeFields = {}
let engineConfig: EngineConfig = {}
let credentials: Record<string, 'api' | 'oauth'> = {}
let declaredElsewhere: string[] = []
let claimed = new Set<string>()
/** The live read of the credential table; recorded in `calls`, so the ORDER against the claim check is pinned too. */
const readRows = async (): Promise<Set<string>> => {
  calls.push('rows')
  return new Set(Object.keys(credentials))
}
let rowsRead: () => Promise<Set<string>> = readRows

vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: {
    removeVendorAuth: (id: string) => removeVendorAuth(id)
  }
}))
vi.mock('../opencode-config', () => ({
  readOpencodeNativeConfig: () => native,
  readDeclaredProviderIds: () => [...Object.keys(native.providers ?? {}), ...declaredElsewhere],
  writeOpencodeNativeConfig: (fields: NativeOpencodeFields) => writeNative(fields)
}))
vi.mock('../model-discovery', () => ({ invalidateOpencodeModelCache: () => invalidate() }))
// opencode 2.x (ADR-097 §5): Remove is offered for ANY row opencode's credential
// table holds — the user's own included. `credentials` names those integrations.
vi.mock('../opencode-credentials', () => ({
  opencodeCredentialStore: {
    integrationsWithRows: () => rowsRead()
  }
}))
// The enabled shared routes (`claimed`): a provider they deliver is not Remove-able.
vi.mock('../../shared-providers/opencode-claims', () => ({
  claimedOpencodeIds: () => {
    calls.push('claims')
    return claimed
  }
}))
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => engineConfig,
  saveEngineConfig: (id: string, cfg: unknown) => saveEngine(id, cfg)
}))
vi.mock('../../services/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const { removeOpencodeProvider, setOpencodeProviderDisabled } =
  await import('../provider-management')

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  native = {}
  engineConfig = {}
  credentials = {}
  declaredElsewhere = []
  claimed = new Set()
  rowsRead = readRows
})

describe('setOpencodeProviderDisabled', () => {
  it('adds the id to disabled_providers without touching anything else', () => {
    native = { providers: { mine: { baseURL: 'http://x' } }, model: 'openai/gpt-5.5' }
    setOpencodeProviderDisabled('mine', true)

    expect(writeNative).toHaveBeenCalledTimes(1)
    const written = writeNative.mock.calls[0][0]
    expect(written.disabledProviders).toEqual(['mine'])
    // Disable is non-destructive: the declaration and every other key survive.
    expect(written.providers).toEqual({ mine: { baseURL: 'http://x' } })
    expect(written.model).toBe('openai/gpt-5.5')
    expect(removeVendorAuth).not.toHaveBeenCalled()
  })

  it('re-enabling removes only that id from the array', () => {
    native = { disabledProviders: ['openai', 'zen'] }
    setOpencodeProviderDisabled('openai', false)
    expect(writeNative.mock.calls[0][0].disabledProviders).toEqual(['zen'])
  })

  it('is a no-op when already in the requested state', () => {
    native = { disabledProviders: ['openai'] }
    setOpencodeProviderDisabled('openai', true)
    expect(writeNative).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('removeOpencodeProvider — clears its own veto', () => {
  it('removes disabled-only settings and curation, preserving unrelated config and credentials', async () => {
    native = {
      disabledProviders: ['llamacpp', 'other'],
      model: 'other/model',
      providers: { other: {} }
    }
    engineConfig = {
      autoMode: { enabled: true },
      opencodeConfig: {
        modelAllowlist: { llamacpp: ['old'], other: ['keep'] },
        smallModel: 'other/small'
      }
    }
    await removeOpencodeProvider('llamacpp', 'settings')
    expect(writeNative).toHaveBeenCalledWith({ ...native, disabledProviders: ['other'] })
    expect(removeVendorAuth).not.toHaveBeenCalled()
    expect(saveEngine).toHaveBeenCalledWith('opencode', {
      ...engineConfig,
      opencodeConfig: {
        ...engineConfig.opencodeConfig,
        modelAllowlist: { other: ['keep'] }
      }
    })
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it.each(['credential', 'declaration', 'external declaration', 'enabled', 'free'])(
    'rejects a stale removal after the row has become %s',
    async (change) => {
      native = { disabledProviders: ['mine'] }
      if (change === 'credential') credentials = { mine: 'api' }
      if (change === 'declaration') native.providers = { mine: {} }
      if (change === 'external declaration') declaredElsewhere = ['mine']
      if (change === 'enabled') native.disabledProviders = []
      const id = change === 'free' ? 'opencode' : 'mine'
      if (change === 'free') native.disabledProviders = [id]
      await expect(removeOpencodeProvider(id, 'settings')).rejects.toThrow('no longer a stale')
      expect(saveEngine).not.toHaveBeenCalled()
      expect(writeNative).not.toHaveBeenCalled()
      expect(removeVendorAuth).not.toHaveBeenCalled()
    }
  )

  it('drops a stale disabled_providers entry when removing a credential', async () => {
    // THE REGRESSION: this is the exact live state that stranded ChatGPT —
    // credential present in auth.json, id vetoed in disabled_providers.
    native = { disabledProviders: ['qwen-sandbox', 'openai'] }
    await removeOpencodeProvider('openai', 'credential')

    expect(removeVendorAuth).toHaveBeenCalledWith('openai')
    const written = writeNative.mock.calls[0][0]
    expect(written.disabledProviders).toEqual(['qwen-sandbox'])
    expect(written.disabledProviders).not.toContain('openai')
  })

  it('clears the veto even when the provider was not disabled', async () => {
    native = { disabledProviders: ['other'] }
    await removeOpencodeProvider('openai', 'credential')
    expect(writeNative.mock.calls[0][0].disabledProviders).toEqual(['other'])
  })
})

describe('removeOpencodeProvider — honours kind exactly', () => {
  it("'credential' deletes the credential and leaves the declaration", async () => {
    native = { providers: { mine: { baseURL: 'http://x' } } }
    await removeOpencodeProvider('mine', 'credential')

    expect(removeVendorAuth).toHaveBeenCalledWith('mine')
    expect(writeNative.mock.calls[0][0].providers).toEqual({ mine: { baseURL: 'http://x' } })
  })

  it("'declaration' deletes the declaration and leaves credentials alone", async () => {
    native = { providers: { mine: { baseURL: 'http://x' }, other: {} } }
    await removeOpencodeProvider('mine', 'declaration')

    expect(removeVendorAuth).not.toHaveBeenCalled()
    expect(writeNative.mock.calls[0][0].providers).toEqual({ other: {} })
  })

  it("'both' deletes the credential and the declaration in one config write", async () => {
    native = { providers: { mine: {} }, disabledProviders: ['mine'] }
    await removeOpencodeProvider('mine', 'both')

    expect(removeVendorAuth).toHaveBeenCalledWith('mine')
    // ONE write: a split write would leave a window where the declaration is
    // gone but disabled_providers still names it.
    expect(writeNative).toHaveBeenCalledTimes(1)
    const written = writeNative.mock.calls[0][0]
    expect(written.providers).toEqual({})
    expect(written.disabledProviders).toEqual([])
  })
})

describe('removeOpencodeProvider — a provider an enabled shared route delivers', () => {
  it.each(['credential', 'declaration', 'both', 'settings'] as const)(
    'refuses a %s removal before any credential call or config write',
    async (kind) => {
      claimed = new Set(['openai'])
      native = { providers: { openai: {} }, disabledProviders: ['openai'] }
      engineConfig = { opencodeConfig: { modelAllowlist: { openai: ['gpt-5.5'] } } }
      await expect(removeOpencodeProvider('openai', kind)).rejects.toThrow(
        'ClaudeUI’s own provider delivers this one now. Refresh Settings before removing it.'
      )
      // The claim was the only thing consulted: nothing deleted, written or invalidated.
      expect(calls).toEqual(['claims'])
      expect(removeVendorAuth).not.toHaveBeenCalled()
      expect(writeNative).not.toHaveBeenCalled()
      expect(saveEngine).not.toHaveBeenCalled()
      expect(invalidate).not.toHaveBeenCalled()
    }
  )

  it('a provider no route claims goes through, claim check first and credential before config', async () => {
    claimed = new Set(['openai'])
    await removeOpencodeProvider('mine', 'both')
    expect(calls).toEqual(['claims', 'credential mine', 'config'])
  })
})

describe('removeOpencodeProvider — the live credential read', () => {
  it('a vetoed provider with a key row is removed as a credential: the key AND the veto go; a settings-only removal is refused', async () => {
    // The row resolves `credential` (was `settings`): deleting only the veto
    // would resurrect a provider that still has its key.
    native = { disabledProviders: ['mine', 'other'] }
    credentials = { mine: 'api' }
    await expect(removeOpencodeProvider('mine', 'settings')).rejects.toThrow('no longer a stale')
    expect(writeNative).not.toHaveBeenCalled()
    await removeOpencodeProvider('mine', 'credential')
    expect(removeVendorAuth).toHaveBeenCalledWith('mine')
    expect(writeNative.mock.calls[0][0].disabledProviders).toEqual(['other'])
  })

  it('a failed read of the credential table fails the settings removal — never a fallback to a record', async () => {
    native = { disabledProviders: ['mine'] }
    rowsRead = async () => {
      throw new Error('server down')
    }
    await expect(removeOpencodeProvider('mine', 'settings')).rejects.toThrow('server down')
    expect(writeNative).not.toHaveBeenCalled()
    expect(saveEngine).not.toHaveBeenCalled()
  })

  it('a credential removal clears the veto and the allowlist together', async () => {
    native = { disabledProviders: ['mine'] }
    engineConfig = { opencodeConfig: { modelAllowlist: { mine: ['m'] } } }
    await removeOpencodeProvider('mine', 'credential')
    expect(writeNative.mock.calls[0][0].disabledProviders).toEqual([])
    expect(saveEngine).toHaveBeenCalledTimes(1)
  })
})

describe('removeOpencodeProvider — model allowlist cleanup', () => {
  it("drops the removed provider's allowlist entry and keeps the others", async () => {
    engineConfig = {
      opencodeConfig: { modelAllowlist: { openai: ['gpt-5.5'], openrouter: ['kimi'] } }
    }
    await removeOpencodeProvider('openai', 'credential')

    expect(saveEngine).toHaveBeenCalledTimes(1)
    const [engineId, cfg] = saveEngine.mock.calls[0] as [string, typeof engineConfig]
    expect(engineId).toBe('opencode')
    expect(cfg.opencodeConfig?.modelAllowlist).toEqual({ openrouter: ['kimi'] })
  })

  it('collapses an emptied allowlist to undefined rather than leaving {}', async () => {
    engineConfig = { opencodeConfig: { modelAllowlist: { openai: [] } } }
    await removeOpencodeProvider('openai', 'credential')
    const [, cfg] = saveEngine.mock.calls[0] as [string, typeof engineConfig]
    expect(cfg.opencodeConfig?.modelAllowlist).toBeUndefined()
  })

  it('skips the config write when the provider had no allowlist entry', async () => {
    engineConfig = { opencodeConfig: { modelAllowlist: { openrouter: ['kimi'] } } }
    await removeOpencodeProvider('openai', 'credential')
    expect(saveEngine).not.toHaveBeenCalled()
  })
})

describe('removeOpencodeProvider — cache invalidation', () => {
  it('invalidates the discovery cache AFTER the credential delete and config write, so the next read sees the removal', async () => {
    await removeOpencodeProvider('openai', 'credential')
    expect(invalidate).toHaveBeenCalledTimes(1)
    // Invalidating first would let a concurrent read re-fill the cache with the
    // row that is about to disappear.
    const invalidated = invalidate.mock.invocationCallOrder[0]
    expect(invalidated).toBeGreaterThan(removeVendorAuth.mock.invocationCallOrder[0])
    expect(invalidated).toBeGreaterThan(writeNative.mock.invocationCallOrder[0])
  })

  it('propagates a credential-delete failure instead of half-removing', async () => {
    removeVendorAuth.mockRejectedValueOnce(new Error('server spawn failed'))
    native = { providers: { openai: {} } }
    await expect(removeOpencodeProvider('openai', 'both')).rejects.toThrow('server spawn failed')
    // The declaration must survive a failed credential delete — otherwise a
    // transient spawn error silently destroys config the user can't get back.
    expect(writeNative).not.toHaveBeenCalled()
  })
})
