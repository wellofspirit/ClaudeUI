/**
 * Layer 1: the renderer's ONE provider-auth view (ADR-068 §3, Slice 6).
 *
 * `providerAuth` has two writers with disjoint keys — `setVendorAuth` derives
 * the Anthropic half from the engine auth probe, `refreshProviderAuth` reads the
 * ChatGPT half off `provider-registry:list` — and three moments it must be
 * refreshed at: boot, the sign-in dialog closing, and a settings write that
 * re-lists the registry (that third one is asserted in ProviderList's own test
 * surface; here we pin the action and the two store-owned callers).
 *
 * Pure store transitions with a stubbed `window.api`; no React, no IPC bridge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, hydrateConfigFromDisk } from '../session-store'
import { UNKNOWN_PROVIDER_AUTH } from '../../utils/sign-in-provider'
import type { ProviderEntry, ProviderRegistrySnapshot } from '../../../../shared/provider-registry'
import { resetReplicaSeam } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const chatgptEntry = (patch: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: 'chatgpt',
  name: 'ChatGPT',
  origin: 'shared',
  credential: 'connected',
  engines: { pi: { enabled: true }, opencode: { enabled: false } },
  ...patch
})

const snapshot = (...entries: ProviderEntry[]): ProviderRegistrySnapshot => ({
  entries,
  opencodeInstalled: true
})

/** Exactly what `hydrateConfigFromDisk` + `refreshProviderAuth` read. */
function stubWindowApi(listProviderRegistry: () => Promise<ProviderRegistrySnapshot>): void {
  ;(globalThis as unknown as { window: Window }).window = globalThis.window || ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadSettings: vi.fn().mockResolvedValue({}),
    loadSessionConfig: vi.fn().mockResolvedValue({}),
    loadSlashCommands: vi.fn().mockResolvedValue([]),
    loadEngineConfig: vi.fn().mockResolvedValue({}),
    loadOpencodeSettings: vi.fn().mockResolvedValue({}),
    loadClaudePermissions: vi.fn().mockResolvedValue(null),
    saveSettings: vi.fn(),
    saveSessionConfig: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    listProviderRegistry: vi.fn(listProviderRegistry)
  }
}

beforeEach(() => {
  resetReplicaSeam()
  stubWindowApi(async () => snapshot(chatgptEntry()))
  useSessionStore.setState({ providerAuth: UNKNOWN_PROVIDER_AUTH, vendorAuth: null })
})

describe('refreshProviderAuth', () => {
  it('starts unknown — nothing has been read yet', () => {
    expect(store().providerAuth).toEqual({
      anthropic: 'unknown',
      chatgpt: 'unknown',
      chatgptRoutes: {}
    })
  })

  it('maps a connected snapshot to authenticated + its per-engine routes', async () => {
    await store().refreshProviderAuth()
    expect(store().providerAuth.chatgpt).toBe('authenticated')
    expect(store().providerAuth.chatgptRoutes).toEqual({ pi: true, opencode: false })
  })

  it('maps credential "none" to unauthenticated', async () => {
    stubWindowApi(async () => snapshot(chatgptEntry({ credential: 'none' })))
    await store().refreshProviderAuth()
    expect(store().providerAuth.chatgpt).toBe('unauthenticated')
  })

  it('maps an active account needing re-auth to unauthenticated', async () => {
    stubWindowApi(async () =>
      snapshot(
        chatgptEntry({
          accounts: { activeId: 'a1', perSession: false, list: [{ id: 'a1', needsReauth: true }] }
        })
      )
    )
    await store().refreshProviderAuth()
    expect(store().providerAuth.chatgpt).toBe('unauthenticated')
  })

  it('leaves ChatGPT unknown when the read fails — never "signed out"', async () => {
    stubWindowApi(async () => {
      throw new Error('no vault')
    })
    await store().refreshProviderAuth()
    expect(store().providerAuth.chatgpt).toBe('unknown')
  })

  it('accepts a snapshot the caller already read instead of reading again', async () => {
    await store().refreshProviderAuth(snapshot(chatgptEntry({ credential: 'none' })))
    expect(store().providerAuth.chatgpt).toBe('unauthenticated')
    expect(window.api.listProviderRegistry).not.toHaveBeenCalled()
  })

  it('does not disturb the Anthropic half', async () => {
    store().setVendorAuth({ anthropic: { authState: 'unauthenticated', billingType: 'unknown' } })
    await store().refreshProviderAuth()
    expect(store().providerAuth.anthropic).toBe('unauthenticated')
  })
})

describe('setVendorAuth derives the Anthropic half', () => {
  it('mirrors the probe', () => {
    store().setVendorAuth({ anthropic: { authState: 'unauthenticated', billingType: 'unknown' } })
    expect(store().providerAuth.anthropic).toBe('unauthenticated')
    store().setVendorAuth({
      anthropic: { authState: 'authenticated', billingType: 'subscription' }
    })
    expect(store().providerAuth.anthropic).toBe('authenticated')
  })

  it('stays unknown for a probe that says nothing about anthropic', () => {
    store().setVendorAuth({
      'openai-codex': { authState: 'authenticated', billingType: 'unknown' }
    })
    expect(store().providerAuth.anthropic).toBe('unknown')
  })

  it('does not disturb the ChatGPT half', async () => {
    await store().refreshProviderAuth()
    store().setVendorAuth({ anthropic: { authState: 'unauthenticated', billingType: 'unknown' } })
    expect(store().providerAuth.chatgpt).toBe('authenticated')
    expect(store().providerAuth.chatgptRoutes).toEqual({ pi: true, opencode: false })
  })
})

describe('the refresh callers', () => {
  it('closeSignIn re-reads — the dialog outcome is what changed the answer', async () => {
    stubWindowApi(async () => snapshot(chatgptEntry({ credential: 'none' })))
    store().openSignIn({ providerId: 'chatgpt', mode: 'reauth' })
    store().closeSignIn()
    expect(store().signInDialog).toBeNull()
    await vi.waitFor(() => expect(store().providerAuth.chatgpt).toBe('unauthenticated'))
  })

  it('hydrateConfigFromDisk seeds it at boot', async () => {
    stubWindowApi(async () => snapshot(chatgptEntry({ credential: 'none' })))
    await hydrateConfigFromDisk()
    await vi.waitFor(() => expect(store().providerAuth.chatgpt).toBe('unauthenticated'))
  })
})
