/**
 * @vitest-environment node
 *
 * The shared classifier trust lists — storage + the one-time migration out of
 * `engines/<engine>.json#autoMode` (ADR-065 § Shared trust lists).
 *
 * This drives the REAL `ui-config.ts` against real files: `os.homedir()` is
 * redirected into a temp tree by a hoisted mock (the `pi-native-raw.test.ts`
 * trick) and the module is re-imported per test with `vi.resetModules()`,
 * because `CONFIG_DIR` is a module-level constant AND the migration's run-once
 * flag is module state — a fresh import is exactly what "the next app run" is.
 * The developer's real `~/.claude/ui` is never read or written.
 *
 * (Deliberately NOT the shape of `main/services/__tests__/ui-config-migration.test.ts`,
 * which re-implements the migration inline and therefore cannot fail when the
 * implementation is wrong.)
 *
 * Guards:
 * - union across BOTH engines, existing shared entries first, order preserved
 * - exact-string dedupe, and entries are never dropped
 * - the three keys are stripped from every engine file, siblings untouched
 * - a second run (fresh module = next app start) writes nothing
 * - a fresh install creates NO automode.json
 * - an engine file without an `autoMode` block is left byte-identical
 * - save: an empty list becomes an ABSENT key; load: absent file → {}
 * - `loadSettings()` also triggers the migration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

// The DB and the sync funnel are irrelevant here and would drag a driver / an
// event bus into a pure filesystem test.
vi.mock('../db', () => ({
  allSessionMeta: () => [],
  setSessionMeta: vi.fn(),
  deleteSessionMeta: vi.fn(),
  importSessionEnginesOnce: vi.fn()
}))
vi.mock('../sync-host', () => ({ emitEvent: vi.fn() }))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

type UiConfig = typeof import('../ui-config')

let testHome: string

const uiDir = (): string => join(testHome, '.claude', 'ui')
const enginesDir = (): string => join(uiDir(), 'engines')
const sharedFile = (): string => join(uiDir(), 'automode.json')
const engineFile = (id: string): string => join(enginesDir(), `${id}.json`)

/** A fresh module instance — i.e. the next app start, migration flag cleared. */
async function freshModule(): Promise<UiConfig> {
  vi.resetModules()
  return await import('../ui-config')
}

function writeEngine(id: string, data: unknown): void {
  mkdirSync(enginesDir(), { recursive: true })
  writeFileSync(engineFile(id), JSON.stringify(data, null, 2))
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'claudeui-shared-automode-'))
  homedirHolder.current = testHome
  mkdirSync(uiDir(), { recursive: true })
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
  vi.resetModules()
})

describe('migrateSharedTrustLists', () => {
  it('unions both engines into automode.json and strips the keys from each', async () => {
    writeEngine('opencode', {
      autoMode: {
        enabled: true,
        judgeModel: 'openai/gpt-5',
        trustedDomains: ['files.acme.com'],
        trustedRegistries: ['https://npm.acme.internal']
      },
      opencodeConfig: { model: 'anthropic/x' }
    })
    writeEngine('pi', {
      autoMode: { twoStageMode: 'fast', trustedDomains: ['api.acme.com'] },
      piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
    })

    const mod = await freshModule()
    expect(mod.loadSharedAutoModeConfig()).toEqual({
      trustedDomains: ['files.acme.com', 'api.acme.com'],
      trustedRegistries: ['https://npm.acme.internal']
    })

    // Stripped from BOTH engine files; every sibling key survives.
    expect(readJsonFile(engineFile('opencode'))).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai/gpt-5' },
      opencodeConfig: { model: 'anthropic/x' }
    })
    expect(readJsonFile(engineFile('pi'))).toEqual({
      autoMode: { twoStageMode: 'fast' },
      piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
    })
  })

  it('dedupes exact strings and keeps shared → opencode → pi order', async () => {
    writeFileSync(sharedFile(), JSON.stringify({ protectedPatterns: ['acme-live-*'] }, null, 2))
    writeEngine('opencode', {
      autoMode: { protectedPatterns: ['acme-live-*', 'k8s://prod-cluster'] }
    })
    writeEngine('pi', {
      autoMode: { protectedPatterns: ['k8s://prod-cluster', 'db://payments'] }
    })

    const mod = await freshModule()
    expect(mod.loadSharedAutoModeConfig().protectedPatterns).toEqual([
      'acme-live-*',
      'k8s://prod-cluster',
      'db://payments'
    ])
  })

  it('never drops an entry when only ONE engine has the list', async () => {
    // The reason the migration unions instead of picking a winner: taking
    // opencode's (absent) list would silently make pi's judge stricter.
    writeEngine('opencode', { autoMode: { enabled: false } })
    writeEngine('pi', { autoMode: { trustedDomains: ['only.pi.example'] } })

    const mod = await freshModule()
    expect(mod.loadSharedAutoModeConfig()).toEqual({ trustedDomains: ['only.pi.example'] })
  })

  it('is a no-op on the next app start', async () => {
    writeEngine('opencode', { autoMode: { trustedDomains: ['files.acme.com'] } })

    const first = await freshModule()
    expect(first.loadSharedAutoModeConfig()).toEqual({ trustedDomains: ['files.acme.com'] })

    // The user then empties the list from the settings UI…
    first.saveSharedAutoModeConfig({})
    expect(readJsonFile(sharedFile())).toEqual({})

    // …and a later app start must NOT resurrect it: the engine file no longer
    // carries the key, so there is nothing to re-union.
    const second = await freshModule()
    expect(second.loadSharedAutoModeConfig()).toEqual({})
    expect(readJsonFile(engineFile('opencode'))).toEqual({ autoMode: {} })
  })

  it('creates no automode.json on a fresh install', async () => {
    const mod = await freshModule()
    expect(mod.loadSharedAutoModeConfig()).toEqual({})
    expect(existsSync(sharedFile())).toBe(false)
  })

  it('leaves an engine file with no autoMode block byte-identical', async () => {
    writeEngine('opencode', { dispatch: { defaultModel: 'openai/gpt-5' } })
    const before = readFileSync(engineFile('opencode'), 'utf-8')

    const mod = await freshModule()
    mod.loadSharedAutoModeConfig()

    expect(readFileSync(engineFile('opencode'), 'utf-8')).toBe(before)
    expect(existsSync(sharedFile())).toBe(false)
  })

  it('drops a hand-edited non-array value rather than carrying it forward', async () => {
    writeEngine('pi', { autoMode: { enabled: true, trustedDomains: 'files.acme.com' } })

    const mod = await freshModule()
    expect(mod.loadSharedAutoModeConfig()).toEqual({})
    // The key is dead once AutoModeConfig stops declaring it, so it goes too.
    expect(readJsonFile(engineFile('pi'))).toEqual({ autoMode: { enabled: true } })
  })

  it('runs from loadSettings() as well, not only from the trust-list read', async () => {
    writeFileSync(join(uiDir(), 'settings.json'), JSON.stringify({ theme: 'dark' }))
    writeEngine('pi', { autoMode: { trustedRegistries: ['https://npm.acme.internal'] } })

    const mod = await freshModule()
    expect(mod.loadSettings()).toEqual({ theme: 'dark' })
    expect(readJsonFile(sharedFile())).toEqual({
      trustedRegistries: ['https://npm.acme.internal']
    })
  })
})

describe('load/saveSharedAutoModeConfig', () => {
  it('writes an emptied list as an ABSENT key, never []', async () => {
    const mod = await freshModule()
    mod.saveSharedAutoModeConfig({
      trustedDomains: ['files.acme.com'],
      trustedRegistries: [],
      protectedPatterns: []
    })

    const onDisk = readJsonFile(sharedFile())!
    expect(onDisk).toEqual({ trustedDomains: ['files.acme.com'] })
    expect('trustedRegistries' in onDisk).toBe(false)
    expect('protectedPatterns' in onDisk).toBe(false)
  })

  it('round-trips through the file, not through memory', async () => {
    const first = await freshModule()
    first.saveSharedAutoModeConfig({ protectedPatterns: ['acme-live-*'] })

    const second = await freshModule()
    expect(second.loadSharedAutoModeConfig()).toEqual({ protectedPatterns: ['acme-live-*'] })
  })

  it('answers {} for an absent or unparseable file', async () => {
    const mod = await freshModule()
    expect(mod.loadSharedAutoModeConfig()).toEqual({})

    writeFileSync(sharedFile(), '{ not json')
    expect(mod.loadSharedAutoModeConfig()).toEqual({})
  })
})
