import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineModelGroup } from '../../../shared/types'

/**
 * The catalog is answered locally by the pinned binary, so `discoverCodexModels`
 * memoises it per binary identity. These tests own that memo: the service seam is
 * mocked (nothing spawns), and the identity is a real temp file so `statSync` sees
 * a size and an mtime that the tests can move — the vendored binary is never read.
 */
const mocks = vi.hoisted(() => ({
  available: true,
  /** The located binary path; null stands for "no install". */
  binary: null as string | null,
  /** One entry per `CodexService` construction, i.e. per would-be app-server. */
  spawns: 0,
  models: vi.fn(),
  config: vi.fn(),
  dispose: vi.fn(),
  /** The vault's active ChatGPT account id, null for a native-only login. */
  activeId: 'acct-1' as string | null
}))

vi.mock('../codex-locate', () => ({
  codexBinaryAvailable: () => mocks.available,
  locateCodexBinary: () => mocks.binary
}))
vi.mock('../codex-auth-hook', () => ({ codexAuthHook: () => ({}) }))
vi.mock('../../auth/vault/CredentialSync', () => ({
  credentialSync: { getStatus: async () => ({ activeId: mocks.activeId }) }
}))
vi.mock('../CodexService', () => ({
  CodexService: class {
    constructor() {
      mocks.spawns += 1
    }
    models = mocks.models
    effectiveConfig = mocks.config
    dispose = mocks.dispose
  }
}))

const home = mkdtempSync(join(tmpdir(), 'codex-discovery-'))
const binary = join(home, 'codex-fixture')

const catalog = [
  {
    model: 'native',
    displayName: 'Native',
    description: 'Native model',
    hidden: false,
    inputModalities: ['text'],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium'
  }
]

type Discover = (options?: { refresh?: boolean }) => Promise<EngineModelGroup[]>

/** A fresh module instance, so every test starts with an empty memo. */
async function loadDiscovery(): Promise<Discover> {
  vi.resetModules()
  return (await import('../model-discovery')).discoverCodexModels
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.available = true
  mocks.spawns = 0
  mocks.binary = binary
  writeFileSync(binary, 'pinned')
  mocks.activeId = 'acct-1'
  mocks.models.mockResolvedValue(catalog)
  mocks.config.mockResolvedValue({ model_provider: 'openai', model: 'native' })
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('discoverCodexModels memo', () => {
  it('answers a second call from the memo without spawning', async () => {
    const discover = await loadDiscovery()
    const first = await discover()
    const second = await discover()
    expect(first[0].models[0].value).toBe('native')
    expect(second).toEqual(first)
    expect(mocks.spawns).toBe(1)
    expect(mocks.models).toHaveBeenCalledOnce()
  })

  it('collapses concurrent callers onto one discovery', async () => {
    const discover = await loadDiscovery()
    let release: (value: typeof catalog) => void = () => {}
    mocks.models.mockReturnValue(
      new Promise<typeof catalog>((resolve) => {
        release = resolve
      })
    )
    const both = Promise.all([discover(), discover()])
    // The account lookup is one await ahead of the spawn; the reservation is not.
    await new Promise((resolve) => setImmediate(resolve))
    expect(mocks.spawns).toBe(1)
    release(catalog)
    const [left, right] = await both
    expect(right).toEqual(left)
    expect(mocks.spawns).toBe(1)
  })

  it('retries after a failed discovery', async () => {
    const discover = await loadDiscovery()
    mocks.models.mockRejectedValueOnce(new Error('app-server died'))
    await expect(discover()).rejects.toThrow('app-server died')
    expect(await discover()).toHaveLength(1)
    expect(mocks.spawns).toBe(2)
  })

  it('never memoises an empty catalog', async () => {
    const discover = await loadDiscovery()
    mocks.models.mockResolvedValueOnce([])
    expect(await discover()).toEqual([])
    expect(await discover()).toHaveLength(1)
    expect(mocks.spawns).toBe(2)
  })

  it('re-discovers when the binary changes size or mtime', async () => {
    const discover = await loadDiscovery()
    await discover()
    appendFileSync(binary, '-revendored')
    await discover()
    expect(mocks.spawns).toBe(2)
  })

  it('re-discovers on refresh', async () => {
    const discover = await loadDiscovery()
    await discover()
    await discover({ refresh: true })
    expect(mocks.spawns).toBe(2)
    await discover()
    expect(mocks.spawns).toBe(2)
  })

  it('re-discovers when the active account changes, and memoises per account', async () => {
    // Codex refreshes its catalog ONLINE when uncached, under the identity the
    // process was injected with, so a switched account may see a different list.
    const discover = await loadDiscovery()
    await discover()
    mocks.activeId = 'acct-2'
    await discover()
    expect(mocks.spawns).toBe(2)
    await discover()
    expect(mocks.spawns).toBe(2)
    mocks.activeId = null
    await discover()
    expect(mocks.spawns).toBe(3)
  })

  it('spawns nothing for an unavailable installation', async () => {
    const discover = await loadDiscovery()
    mocks.available = false
    expect(await discover()).toEqual([])
    expect(mocks.spawns).toBe(0)
  })

  it('discovers without memoising when the binary identity cannot be read', async () => {
    const discover = await loadDiscovery()
    mocks.binary = join(home, 'absent')
    await discover()
    await discover()
    expect(mocks.spawns).toBe(2)
  })
})
