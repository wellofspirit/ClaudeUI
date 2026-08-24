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
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NativeOpencodeFields } from '../opencode-config'

const removeVendorAuth = vi.fn(async (_id: string): Promise<void> => {})
const writeNative = vi.fn<(fields: NativeOpencodeFields) => void>()
const invalidate = vi.fn()
const saveEngine = vi.fn()
let native: NativeOpencodeFields = {}
let engineConfig: { opencodeConfig?: { modelAllowlist?: Record<string, string[]> } } = {}

vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: {
    removeVendorAuth: (id: string) => removeVendorAuth(id)
  }
}))
vi.mock('../opencode-config', () => ({
  readOpencodeNativeConfig: () => native,
  writeOpencodeNativeConfig: (fields: NativeOpencodeFields) => writeNative(fields)
}))
vi.mock('../model-discovery', () => ({ invalidateOpencodeModelCache: () => invalidate() }))
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => engineConfig,
  saveEngineConfig: (id: string, cfg: unknown) => saveEngine(id, cfg)
}))
vi.mock('../../services/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const { removeOpencodeProvider, setOpencodeProviderDisabled } =
  await import('../provider-management')

beforeEach(() => {
  vi.clearAllMocks()
  native = {}
  engineConfig = {}
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
  it('invalidates the discovery cache so the row disappears on next read', async () => {
    await removeOpencodeProvider('openai', 'credential')
    expect(invalidate).toHaveBeenCalled()
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
