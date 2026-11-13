/**
 * @vitest-environment node
 *
 * The one-time move of `engines/claude.json#sandbox` into the shared user settings file (D8).
 * The engine config is an in-memory map behind a mocked `ui-config`; the settings file is a real
 * one in a temp CLAUDE_CONFIG_DIR.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DEFAULT_SANDBOX } from '../../../shared/types'
import type { SandboxSettings } from '../../../shared/types'

const store = vi.hoisted(() => ({ claude: {} as Record<string, unknown> }))
const uiConfig = vi.hoisted(() => ({
  ensureConfigPlaneMigrated: vi.fn(),
  loadEngineConfig: vi.fn(() => structuredClone(store.claude)),
  saveEngineConfig: vi.fn((_id: string, config: unknown) => {
    store.claude = structuredClone(config) as Record<string, unknown>
  })
}))
vi.mock('../ui-config', () => uiConfig)
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  migrateClaudeSandboxToSettingsFile,
  resetClaudeSandboxMemoryForTests
} from '../claude-sandbox-settings'

let dir: string
const prevEnv = process.env.CLAUDE_CONFIG_DIR
const file = (): string => path.join(dir, 'settings.json')
const writeFile = (data: unknown): void => fs.writeFileSync(file(), JSON.stringify(data))
const readFile = (): Record<string, any> => JSON.parse(fs.readFileSync(file(), 'utf-8'))

const copy = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({
  ...structuredClone(DEFAULT_SANDBOX),
  ...over
})

beforeEach(() => {
  resetClaudeSandboxMemoryForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sandbox-mig-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  store.claude = {}
  vi.clearAllMocks()
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevEnv
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('migrateClaudeSandboxToSettingsFile', () => {
  it('runs the older app-settings migration before it reads the engine config', () => {
    store.claude = { sandbox: copy() }
    migrateClaudeSandboxToSettingsFile()
    expect(uiConfig.ensureConfigPlaneMigrated.mock.invocationCallOrder[0]).toBeLessThan(
      uiConfig.loadEngineConfig.mock.invocationCallOrder[0]
    )
  })

  it('an enabled copy over an off file block unions the lists: the file’s entries first, then the copy’s', () => {
    writeFile({
      sandbox: {
        enabled: false,
        failIfUnavailable: true,
        excludedCommands: ['make'],
        filesystem: { denyRead: ['~/.ssh'] },
        network: { allowedDomains: ['file.com'] }
      }
    })
    store.claude = {
      sandbox: copy({
        enabled: true,
        excludedCommands: ['make', 'docker'],
        filesystem: { allowWrite: ['/data'], denyWrite: [], denyRead: ['~/.aws'] },
        network: { ...DEFAULT_SANDBOX.network, restrictNetwork: true, allowedDomains: ['copy.com'] }
      })
    }
    migrateClaudeSandboxToSettingsFile()
    const block = readFile().sandbox
    expect(block.enabled).toBe(true)
    expect(block.failIfUnavailable).toBe(true)
    expect(block.excludedCommands).toEqual(['make', 'docker'])
    expect(block.filesystem).toEqual({ allowWrite: ['/data'], denyRead: ['~/.ssh', '~/.aws'] })
    expect(block.network.allowedDomains).toEqual(['file.com', 'copy.com'])
  })

  it('the restriction stays when only the file restricts; a copy’s unrestricted list is not mixed in', () => {
    writeFile({ sandbox: { enabled: false, network: { allowedDomains: ['file.com'] } } })
    store.claude = {
      sandbox: copy({
        enabled: true,
        network: { ...DEFAULT_SANDBOX.network, allowedDomains: ['remembered.com'] }
      })
    }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile().sandbox.network.allowedDomains).toEqual(['file.com'])
    expect(store.claude).toEqual({ claudeConfig: { sandboxRememberedDomains: ['remembered.com'] } })
  })

  it('an enabled copy over a file block that is not enabled turns the block on and keeps its unknown keys', () => {
    writeFile({
      theme: 'dark',
      sandbox: { enabled: false, failIfUnavailable: true, ignoreViolations: { '*': ['/t'] } }
    })
    store.claude = { sandbox: copy({ enabled: true, excludedCommands: ['docker'] }) }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile()).toEqual({
      theme: 'dark',
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        excludedCommands: ['docker'],
        failIfUnavailable: true,
        ignoreViolations: { '*': ['/t'] }
      }
    })
    expect(store.claude).not.toHaveProperty('sandbox')
  })

  it('an enabled copy over a file with a non-object sandbox value still turns it on', () => {
    writeFile({ sandbox: 'off' })
    store.claude = { sandbox: copy({ enabled: true }) }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile().sandbox.enabled).toBe(true)
  })

  it('both enabled: lists united, the stricter switches win, the file’s unknown key survives', () => {
    writeFile({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        filesystem: { denyRead: ['~/.ssh'] },
        network: { allowLocalBinding: true, allowManagedDomainsOnly: false }
      }
    })
    store.claude = {
      sandbox: copy({
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
        filesystem: { allowWrite: [], denyWrite: [], denyRead: ['~/.aws'] },
        network: {
          ...DEFAULT_SANDBOX.network,
          allowLocalBinding: false,
          allowManagedDomainsOnly: true
        }
      })
    }
    migrateClaudeSandboxToSettingsFile()
    const block = readFile().sandbox
    expect(block.autoAllowBashIfSandboxed).toBe(false)
    expect(block.allowUnsandboxedCommands).toBe(true)
    expect(block.filesystem.denyRead).toEqual(['~/.ssh', '~/.aws'])
    expect(block.network.allowLocalBinding).toBeUndefined()
    expect(block.network.allowManagedDomainsOnly).toBe(true)
    expect(block.failIfUnavailable).toBe(true)
    expect(store.claude).toEqual({})
  })

  it('a disabled copy never changes a file block', () => {
    // A disabled copy never turns a file block off, nor on.
    writeFile({ sandbox: { enabled: false } })
    store.claude = { sandbox: copy({ enabled: false, excludedCommands: ['x'] }) }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile().sandbox).toEqual({ enabled: false })
    expect(store.claude).toEqual({})
  })

  it('with no file block a copy that differs from the defaults moves', () => {
    writeFile({ theme: 'dark' })
    store.claude = { sandbox: copy({ enabled: false, excludedCommands: ['docker'] }) }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile()).toEqual({
      theme: 'dark',
      sandbox: { enabled: false, excludedCommands: ['docker'] }
    })
    expect(store.claude).toEqual({})
  })

  it('an untouched copy writes nothing, not even a missing file, and is dropped', () => {
    store.claude = { sandbox: copy(), claudeConfig: { privacyEmailCheck: false } }
    migrateClaudeSandboxToSettingsFile()
    expect(fs.existsSync(file())).toBe(false)
    expect(store.claude).toEqual({ claudeConfig: { privacyEmailCheck: false } })
  })

  it('a domain list kept with the restriction off moves to the remembered list when the copy is written', () => {
    store.claude = {
      claudeConfig: { idleCompaction: true },
      sandbox: copy({
        enabled: true,
        network: { ...DEFAULT_SANDBOX.network, allowedDomains: ['a.com', 'b.com'] }
      })
    }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile().sandbox.network).toBeUndefined()
    expect(store.claude).toEqual({
      claudeConfig: { idleCompaction: true, sandboxRememberedDomains: ['a.com', 'b.com'] }
    })
  })

  it('the remembered list moves even when the file block wins over a disabled copy', () => {
    writeFile({ sandbox: { enabled: true } })
    store.claude = {
      sandbox: copy({ network: { ...DEFAULT_SANDBOX.network, allowedDomains: ['kept.com'] } })
    }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile().sandbox).toEqual({ enabled: true })
    expect(store.claude).toEqual({ claudeConfig: { sandboxRememberedDomains: ['kept.com'] } })
  })

  it('the waiting warning is logged once per process, not at every attempt', async () => {
    const { logger } = await import('../logger')
    vi.mocked(logger.warn).mockClear()
    fs.writeFileSync(file(), '{ broken')
    store.claude = { sandbox: copy({ enabled: true }) }
    migrateClaudeSandboxToSettingsFile()
    migrateClaudeSandboxToSettingsFile()
    migrateClaudeSandboxToSettingsFile()
    expect(
      vi.mocked(logger.warn).mock.calls.filter((c) => String(c[1]).includes('migration waits'))
    ).toHaveLength(1)
  })

  it('a restricted list goes into the file, and nothing is remembered', () => {
    store.claude = {
      sandbox: copy({
        enabled: true,
        network: { ...DEFAULT_SANDBOX.network, restrictNetwork: true, allowedDomains: ['a.com'] }
      })
    }
    migrateClaudeSandboxToSettingsFile()
    expect(readFile().sandbox.network.allowedDomains).toEqual(['a.com'])
    expect(store.claude).toEqual({})
  })

  it('a file that cannot be parsed changes nothing, and the copy stays for the next boot', () => {
    fs.writeFileSync(file(), '{ broken')
    const original = { sandbox: copy({ enabled: true }) }
    store.claude = structuredClone(original)
    migrateClaudeSandboxToSettingsFile()
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{ broken')
    expect(store.claude).toEqual(original)
    expect(uiConfig.saveEngineConfig).not.toHaveBeenCalled()
  })

  it('running it twice changes nothing more', () => {
    writeFile({ sandbox: { enabled: false } })
    store.claude = { sandbox: copy({ enabled: true }) }
    migrateClaudeSandboxToSettingsFile()
    const afterFirst = {
      file: fs.readFileSync(file(), 'utf-8'),
      config: structuredClone(store.claude)
    }
    uiConfig.saveEngineConfig.mockClear()
    migrateClaudeSandboxToSettingsFile()
    expect(fs.readFileSync(file(), 'utf-8')).toBe(afterFirst.file)
    expect(store.claude).toEqual(afterFirst.config)
    expect(uiConfig.saveEngineConfig).not.toHaveBeenCalled()
  })

  it('never throws, even when the engine config cannot be read', () => {
    uiConfig.loadEngineConfig.mockImplementationOnce(() => {
      throw new Error('disk')
    })
    expect(() => migrateClaudeSandboxToSettingsFile()).not.toThrow()
  })
})
