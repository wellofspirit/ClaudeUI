/**
 * @vitest-environment node
 *
 * The shared sandbox setting: the `sandbox` block of Claude Code's user settings file. The file
 * lives in a temp CLAUDE_CONFIG_DIR; `ui-config` is an in-memory stand-in (only the pending
 * migration rule reads the old copy from it).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DEFAULT_SANDBOX } from '../../../shared/types'
import type { SandboxSettings } from '../../../shared/types'

const store = vi.hoisted(() => ({ claude: {} as Record<string, unknown> }))
vi.mock('../ui-config', () => ({
  ensureConfigPlaneMigrated: vi.fn(),
  loadEngineConfig: vi.fn(() => structuredClone(store.claude)),
  saveEngineConfig: vi.fn((_id: string, c: unknown) => {
    store.claude = JSON.parse(JSON.stringify(c))
  })
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  applySandboxViewToBlock,
  claudeSandboxFlags,
  claudeSandboxScopes,
  claudeSandboxSupported,
  claudeUserSettingsPath,
  parseSandboxPatch,
  readClaudeSandboxState,
  sandboxViewFromBlock,
  saveClaudeSandbox
} from '../claude-sandbox-settings'

let dir: string
const prevEnv = process.env.CLAUDE_CONFIG_DIR
const settingsFile = (): string => path.join(dir, 'settings.json')
const writeFile = (data: unknown): void => fs.writeFileSync(settingsFile(), JSON.stringify(data))
const readFile = (): Record<string, any> => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sandbox-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  store.claude = {}
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevEnv
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const view = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({
  ...structuredClone(DEFAULT_SANDBOX),
  ...over
})

describe('sandboxViewFromBlock', () => {
  it('a missing, non-object or empty block is the defaults', () => {
    for (const block of [undefined, null, 'on', ['x'], 3, {}]) {
      expect(sandboxViewFromBlock(block)).toEqual(DEFAULT_SANDBOX)
    }
  })

  it('an enabled block that does not state the two switches reads them as on', () => {
    const v = sandboxViewFromBlock({ enabled: true })
    expect(v.enabled).toBe(true)
    expect(v.autoAllowBashIfSandboxed).toBe(true)
    expect(v.allowUnsandboxedCommands).toBe(true)
  })

  it('a block that is not enabled reads absent switches as off, stated ones as stated', () => {
    expect(sandboxViewFromBlock({ enabled: 'true' })).toEqual(DEFAULT_SANDBOX)
    const v = sandboxViewFromBlock({ enabled: false, autoAllowBashIfSandboxed: true })
    expect(v.autoAllowBashIfSandboxed).toBe(true)
    expect(v.allowUnsandboxedCommands).toBe(false)
  })

  it('restrictNetwork follows the presence of allowedDomains, an empty list included', () => {
    expect(sandboxViewFromBlock({ network: {} }).network.restrictNetwork).toBe(false)
    const empty = sandboxViewFromBlock({ network: { allowedDomains: [] } })
    expect(empty.network.restrictNetwork).toBe(true)
    expect(empty.network.allowedDomains).toEqual([])
    expect(sandboxViewFromBlock({ network: { allowedDomains: ['a.com'] } }).network).toMatchObject({
      restrictNetwork: true,
      allowedDomains: ['a.com']
    })
  })

  it('booleans are exactly true; lists are arrays of strings, else empty', () => {
    const v = sandboxViewFromBlock({
      excludedCommands: 'docker',
      network: { allowLocalBinding: 1, allowUnixSockets: ['/s', 4] },
      filesystem: { allowWrite: ['/w'], denyRead: {} }
    })
    expect(v.excludedCommands).toEqual([])
    expect(v.network.allowLocalBinding).toBe(false)
    expect(v.network.allowUnixSockets).toEqual(['/s'])
    expect(v.filesystem).toEqual({ allowWrite: ['/w'], denyWrite: [], denyRead: [] })
  })
})

describe('applySandboxViewToBlock', () => {
  it('keeps keys the page does not know, at the top and inside network and filesystem', () => {
    const block = applySandboxViewToBlock(
      {
        enabled: true,
        failIfUnavailable: true,
        ignoreViolations: { '*': ['/tmp'] },
        network: { deniedDomains: ['bad.com'], allowedDomains: ['a.com'] },
        filesystem: { allowRead: ['/r'] }
      },
      view({
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        network: { ...DEFAULT_SANDBOX.network, restrictNetwork: true, allowedDomains: ['a.com'] },
        filesystem: { allowWrite: ['/w'], denyWrite: [], denyRead: [] }
      })
    )
    expect(block).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      failIfUnavailable: true,
      ignoreViolations: { '*': ['/tmp'] },
      network: { deniedDomains: ['bad.com'], allowedDomains: ['a.com'], allowLocalBinding: false },
      filesystem: { allowRead: ['/r'], allowWrite: ['/w'] }
    })
  })

  it('enabled is an explicit boolean; turning on writes both switches', () => {
    expect(applySandboxViewToBlock(undefined, view({ enabled: true }))).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false
    })
  })

  it('an off block that never stated the switches does not get them; a stated or true one does', () => {
    expect(applySandboxViewToBlock({}, view())).toEqual({ enabled: false })
    expect(applySandboxViewToBlock({ allowUnsandboxedCommands: true }, view())).toEqual({
      enabled: false,
      allowUnsandboxedCommands: false
    })
    expect(applySandboxViewToBlock({}, view({ autoAllowBashIfSandboxed: true }))).toEqual({
      enabled: false,
      autoAllowBashIfSandboxed: true
    })
  })

  it('empty lists and empty sub-objects leave the file', () => {
    const block = applySandboxViewToBlock(
      {
        enabled: true,
        excludedCommands: ['x'],
        network: { allowUnixSockets: ['/s'], allowAllUnixSockets: true },
        filesystem: { denyRead: ['/d'] }
      },
      view({ enabled: true })
    )
    expect(block).not.toHaveProperty('excludedCommands')
    expect(block).not.toHaveProperty('network')
    expect(block).not.toHaveProperty('filesystem')
  })

  it('allowedDomains leaves the file with the restriction off; with it on an empty list is written', () => {
    const off = applySandboxViewToBlock(
      { network: { allowedDomains: ['a.com'], deniedDomains: ['b.com'] } },
      view({ network: { ...DEFAULT_SANDBOX.network, allowedDomains: ['a.com'] } })
    )
    expect(off.network).toEqual({ deniedDomains: ['b.com'] })
    const on = applySandboxViewToBlock(
      {},
      view({ network: { ...DEFAULT_SANDBOX.network, restrictNetwork: true } })
    )
    expect(on.network).toEqual({ allowedDomains: [], allowLocalBinding: false })
  })

  it('allowLocalBinding is explicit beside a domain list, otherwise true or absent', () => {
    const n = (over: Partial<SandboxSettings['network']>): SandboxSettings['network'] => ({
      ...DEFAULT_SANDBOX.network,
      ...over
    })
    const net = (v: Partial<SandboxSettings['network']>): unknown =>
      applySandboxViewToBlock({}, view({ network: n(v) })).network
    expect(net({ restrictNetwork: true, allowLocalBinding: true })).toMatchObject({
      allowLocalBinding: true
    })
    expect(net({ allowLocalBinding: true })).toEqual({ allowLocalBinding: true })
    expect(net({ allowLocalBinding: false })).toBeUndefined()
  })

  it('does not mutate the block it was given', () => {
    const existing = { enabled: true, excludedCommands: ['x'], network: { allowedDomains: ['a'] } }
    const snapshot = structuredClone(existing)
    applySandboxViewToBlock(existing, view())
    expect(existing).toEqual(snapshot)
  })
})

describe('saveClaudeSandbox and readClaudeSandboxState', () => {
  it('resolves the file through CLAUDE_CONFIG_DIR', () => {
    expect(claudeUserSettingsPath()).toBe(settingsFile())
  })

  it('a missing file reads as the defaults and is created with only the block', () => {
    expect(readClaudeSandboxState()).toEqual({
      settings: DEFAULT_SANDBOX,
      supported: claudeSandboxSupported()
    })
    saveClaudeSandbox({ excludedCommands: ['docker'] })
    expect(readFile()).toEqual({ sandbox: { enabled: false, excludedCommands: ['docker'] } })
  })

  it('the file with no block reads as the defaults', () => {
    writeFile({ theme: 'dark' })
    expect(readClaudeSandboxState()?.settings).toEqual(DEFAULT_SANDBOX)
  })

  it('keeps the file’s other top-level keys and the block’s unknown keys', () => {
    writeFile({
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'] },
      sandbox: { enabled: true, failIfUnavailable: true }
    })
    saveClaudeSandbox({ filesystem: { denyRead: ['~/.ssh'] } })
    expect(readFile()).toEqual({
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        filesystem: { denyRead: ['~/.ssh'] }
      }
    })
  })

  it('a patch applies to a strict re-read: a key changed in the file after the caller looked survives', () => {
    writeFile({ sandbox: { enabled: true, excludedCommands: ['a'] } })
    const stale = readClaudeSandboxState()!.settings
    expect(stale.excludedCommands).toEqual(['a'])
    // Someone else edits the file after the caller took its view.
    writeFile({
      sandbox: {
        enabled: true,
        excludedCommands: ['a', 'b'],
        network: { allowedDomains: ['x.com'] }
      }
    })
    saveClaudeSandbox({ network: { allowLocalBinding: true } })
    expect(readFile().sandbox).toMatchObject({
      excludedCommands: ['a', 'b'],
      network: { allowedDomains: ['x.com'], allowLocalBinding: true }
    })
  })

  it('a file that is not valid JSON, or not an object, is refused and left byte-identical', () => {
    for (const text of ['{ "sandbox": ', '[1]', '"x"']) {
      fs.writeFileSync(settingsFile(), text)
      expect(() => saveClaudeSandbox({ enabled: false })).toThrow(
        /not valid JSON|not a JSON object/
      )
      expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(text)
      expect(readClaudeSandboxState()).toBeNull()
    }
  })

  describe('on a host that cannot run the sandbox (A9)', () => {
    const unsupported = (): void => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    }

    it('turning it on is refused with a sentence naming the host, and the file is untouched', () => {
      unsupported()
      writeFile({ theme: 'dark' })
      const before = fs.readFileSync(settingsFile(), 'utf-8')
      expect(() => saveClaudeSandbox({ enabled: true })).toThrow(
        /cannot run on this host \(win32\)/
      )
      expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(before)
    })

    it('turning it off, and editing while the file has it on, work', () => {
      unsupported()
      writeFile({ sandbox: { enabled: true } })
      saveClaudeSandbox({ excludedCommands: ['x'] })
      expect(readFile().sandbox).toMatchObject({ enabled: true, excludedCommands: ['x'] })
      saveClaudeSandbox({ enabled: true, excludedCommands: ['y'] })
      saveClaudeSandbox({ enabled: false })
      expect(readFile().sandbox.enabled).toBe(false)
      // Off now: turning it back on is refused again.
      expect(() => saveClaudeSandbox({ enabled: true })).toThrow()
    })

    it('claudeSandboxSupported is macOS and Linux only', () => {
      expect(claudeSandboxSupported('darwin')).toBe(true)
      expect(claudeSandboxSupported('linux')).toBe(true)
      expect(claudeSandboxSupported('win32')).toBe(false)
    })
  })
})

describe('claudeSandboxFlags', () => {
  const on = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    enableWeakerNestedSandbox: true,
    network: { allowedDomains: ['a.com'] }
  }

  it('switch on: a session carries the validated block plus failIfUnavailable', () => {
    writeFile({ sandbox: on })
    expect(claudeSandboxFlags('session')).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ['a.com'], allowLocalBinding: false },
      failIfUnavailable: true
    })
  })

  it('a key of the block the page does not know is not carried at flag priority', () => {
    writeFile({
      sandbox: { enabled: true, enableWeakerNestedSandbox: true, ignoreViolations: { '*': ['/t'] } }
    })
    const flags = claudeSandboxFlags('session')!
    expect(flags).not.toHaveProperty('enableWeakerNestedSandbox')
    expect(flags).not.toHaveProperty('ignoreViolations')
  })

  it('a wrongly typed known key leaves a well formed block', () => {
    writeFile({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: 'yes',
        allowUnsandboxedCommands: 1,
        excludedCommands: 'docker',
        network: { allowedDomains: 'a.com' },
        filesystem: { denyRead: 'x' }
      }
    })
    expect(claudeSandboxFlags('session')).toEqual({ enabled: true, failIfUnavailable: true })
  })

  it('a switch the block does not state is absent; a stated one is carried either way', () => {
    writeFile({ sandbox: { enabled: true } })
    const unstated = claudeSandboxFlags('session')!
    expect(unstated).not.toHaveProperty('autoAllowBashIfSandboxed')
    expect(unstated).not.toHaveProperty('allowUnsandboxedCommands')
    writeFile({
      sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true }
    })
    expect(claudeSandboxFlags('session')).toMatchObject({
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: true
    })
  })

  it('switch on: a run and a target also never auto-approve, over a true or an unstated key', () => {
    for (const block of [on, { enabled: true }]) {
      writeFile({ sandbox: block })
      for (const kind of ['run', 'target'] as const) {
        expect(claudeSandboxFlags(kind)).toMatchObject({
          enabled: true,
          autoAllowBashIfSandboxed: false,
          failIfUnavailable: true
        })
      }
    }
  })

  it('a failIfUnavailable false in the block does not survive', () => {
    writeFile({ sandbox: { enabled: true, failIfUnavailable: false } })
    expect(claudeSandboxFlags('session')).toEqual({ enabled: true, failIfUnavailable: true })
  })

  it('switch off: a session and a target carry nothing, a run only the inert gate key', () => {
    for (const file of [
      undefined,
      {},
      { sandbox: { enabled: false } },
      { sandbox: { enabled: 'true' } }
    ]) {
      if (file) writeFile(file)
      expect(claudeSandboxFlags('session')).toBeUndefined()
      expect(claudeSandboxFlags('target')).toBeUndefined()
      expect(claudeSandboxFlags('run')).toEqual({ autoAllowBashIfSandboxed: false })
    }
  })

  it('no path ever yields enabled false', () => {
    const files = [undefined, { sandbox: { enabled: false } }, { sandbox: on }]
    for (const file of files) {
      if (file) writeFile(file)
      for (const kind of ['session', 'run', 'target'] as const) {
        expect(claudeSandboxFlags(kind)?.enabled).not.toBe(false)
      }
    }
  })

  it('a pending migration (unparsable file, enabled old copy) yields the old copy’s mapping', () => {
    fs.writeFileSync(settingsFile(), '{ broken')
    store.claude = {
      sandbox: {
        ...structuredClone(DEFAULT_SANDBOX),
        enabled: true,
        autoAllowBashIfSandboxed: true,
        excludedCommands: ['docker'],
        network: {
          ...DEFAULT_SANDBOX.network,
          restrictNetwork: true,
          allowedDomains: ['a.com']
        }
      }
    }
    expect(claudeSandboxFlags('session')).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ['docker'],
      network: { allowedDomains: ['a.com'], allowLocalBinding: false },
      failIfUnavailable: true
    })
    expect(claudeSandboxFlags('run')?.autoAllowBashIfSandboxed).toBe(false)
  })

  it('after the file is mended, the next read completes the migration and returns the block', () => {
    fs.writeFileSync(settingsFile(), '{ broken')
    store.claude = {
      claudeConfig: { idleCompaction: true },
      sandbox: { ...structuredClone(DEFAULT_SANDBOX), enabled: true, excludedCommands: ['docker'] }
    }
    expect(claudeSandboxFlags('session')).toMatchObject({ enabled: true })
    expect(store.claude).toHaveProperty('sandbox')

    writeFile({ theme: 'dark' })
    expect(claudeSandboxFlags('session')).toMatchObject({
      enabled: true,
      excludedCommands: ['docker'],
      failIfUnavailable: true
    })
    expect(readFile()).toMatchObject({ theme: 'dark', sandbox: { enabled: true } })
    expect(store.claude).toEqual({ claudeConfig: { idleCompaction: true } })
  })

  it('an unparsable file with no old copy, or a disabled one, is the switch off', () => {
    fs.writeFileSync(settingsFile(), '{ broken')
    expect(claudeSandboxFlags('session')).toBeUndefined()
    store.claude = { sandbox: structuredClone(DEFAULT_SANDBOX) }
    expect(claudeSandboxFlags('session')).toBeUndefined()
  })
})

describe('readClaudeSandboxState with a migration pending', () => {
  it('returns the waiting copy’s view while the file is broken, null without an enabled copy', () => {
    fs.writeFileSync(settingsFile(), '{ broken')
    expect(readClaudeSandboxState()).toBeNull()
    store.claude = {
      sandbox: { ...structuredClone(DEFAULT_SANDBOX), enabled: true, excludedCommands: ['docker'] }
    }
    const state = readClaudeSandboxState()
    expect(state?.settings.enabled).toBe(true)
    expect(state?.settings.excludedCommands).toEqual(['docker'])
  })
})

describe('claudeSandboxScopes', () => {
  let project: string
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sandbox-proj-'))
    fs.mkdirSync(path.join(project, '.claude'))
  })
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('names the project and local files that set enabled to true, nothing otherwise', () => {
    expect(claudeSandboxScopes(project)).toEqual([])
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { enabled: true } })
    )
    expect(claudeSandboxScopes(project)).toEqual(['project'])
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { enabled: true } })
    )
    expect(claudeSandboxScopes(project)).toEqual(['project', 'local'])
  })

  it('an empty or relative directory names nothing, whatever the host’s own directory holds', () => {
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { enabled: true } })
    )
    const prev = process.cwd()
    process.chdir(path.dirname(project))
    try {
      expect(claudeSandboxScopes(path.basename(project))).toEqual([])
      expect(claudeSandboxScopes('')).toEqual([])
    } finally {
      process.chdir(prev)
    }
  })

  it('a value that is not exactly true names nothing; the user file is not a scope', () => {
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { enabled: 'true' } })
    )
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { enabled: false } })
    )
    writeFile({ sandbox: { enabled: true } })
    expect(claudeSandboxScopes(project)).toEqual([])
  })
})

describe('parseSandboxPatch', () => {
  it('passes known keys of the right kind and returns a copy', () => {
    const input = {
      enabled: true,
      excludedCommands: ['a'],
      network: { restrictNetwork: true, allowedDomains: ['x.com'] },
      filesystem: { denyRead: ['/d'] }
    }
    const out = parseSandboxPatch(input)
    expect(out).toEqual(input)
    expect(out.excludedCommands).not.toBe(input.excludedCommands)
    expect(parseSandboxPatch({})).toEqual({})
  })

  it('throws on a non-object, an unknown key, a wrong type or a list with a non-string', () => {
    for (const bad of [
      null,
      'x',
      [],
      { bogus: true },
      { enabled: 'yes' },
      { excludedCommands: 'a' },
      { excludedCommands: ['a', 1] },
      { network: 'x' },
      { network: { allowedDomains: [1] } },
      { network: { restrictNetwork: 1 } },
      { network: { deniedDomains: [] } },
      { filesystem: { enabled: true } },
      { filesystem: { allowWrite: [{}] } }
    ]) {
      expect(() => parseSandboxPatch(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('an own __proto__ key is unknown, not a prototype write', () => {
    expect(() => parseSandboxPatch(JSON.parse('{"__proto__":{"enabled":true}}'))).toThrow()
    expect(({} as Record<string, unknown>).enabled).toBeUndefined()
  })
})
