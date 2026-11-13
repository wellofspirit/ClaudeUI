/**
 * @vitest-environment node
 *
 * `config:save-engine-config` for the Claude engine drops a `sandbox` key (the sandbox is the
 * shared settings file's now; a client holding the old object must not write the private copy
 * back) and keeps every other key, `claudeConfig.sandboxRememberedDomains` included. Other
 * engines are saved as given.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
vi.mock('../../services/ui-config', () => uiConfigMocks)
vi.mock('../../opencode/model-discovery', () => ({ invalidateOpencodeModelCache: vi.fn() }))
vi.mock('../../pi/model-discovery', () => ({ invalidatePiModelCache: vi.fn() }))
vi.mock('../../opencode/opencode-config', () => ({
  readOpencodeNativeConfig: vi.fn(() => ({})),
  writeOpencodeNativeConfig: vi.fn(),
  migrateOpencodeConfigToNative: vi.fn()
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { configCommands } from '../config-commands'
import type { SessionManager } from '../../services/session-manager'

const save = configCommands({} as unknown as SessionManager).find(
  (c) => c.channel === 'config:save-engine-config'
)!.handler as (engineId: string, cfg: unknown) => unknown

beforeEach(() => {
  store.files = {}
})

describe('config:save-engine-config and the retired sandbox copy', () => {
  it('claude: drops `sandbox`, keeps every other key and the remembered domains', () => {
    save('claude', {
      sandbox: { enabled: true },
      proxy: { enabled: false },
      claudeConfig: { idleCompaction: true, sandboxRememberedDomains: ['example.com'] }
    })
    expect(store.files.claude).toEqual({
      proxy: { enabled: false },
      claudeConfig: { idleCompaction: true, sandboxRememberedDomains: ['example.com'] }
    })
  })

  it('claude: a copy waiting on disk for its migration survives a client save, with or without an incoming key', () => {
    const waiting = { enabled: true, excludedCommands: ['docker'] }
    store.files.claude = { sandbox: waiting }
    save('claude', { sandbox: { enabled: false }, claudeConfig: { idleCompaction: true } })
    expect(store.files.claude).toEqual({
      sandbox: waiting,
      claudeConfig: { idleCompaction: true }
    })
    save('claude', { claudeConfig: { idleCompaction: false } })
    expect(store.files.claude).toEqual({
      sandbox: waiting,
      claudeConfig: { idleCompaction: false }
    })
  })

  it('claude without a `sandbox` key is saved as given', () => {
    const cfg = { claudeConfig: { privacyEmailCheck: false } }
    save('claude', cfg)
    expect(store.files.claude).toEqual(cfg)
  })

  it('another engine keeps a key of that name', () => {
    save('pi', { sandbox: { enabled: true } })
    expect(store.files.pi).toEqual({ sandbox: { enabled: true } })
  })
})
