/**
 * @vitest-environment node
 *
 * The directories detection searches: this process's PATH (with the quirks
 * seen on real machines, ADR-082 research §1-2) and the fresh PATH.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  currentPathEntries,
  expandPathEntry,
  freshPathEntries,
  loginShellArgs,
  parseRegQueryPath,
  parseShellPath,
  searchPathEntries,
  splitPathList
} from '../path-entries'
import type { RunFn, RunResult } from '../run'

const ok = (stdout: string): RunResult => ({ stdout, code: 0, timedOut: false })

describe('Windows PATH', () => {
  const env = {
    NVM_HOME: 'C:\\nvm4w\\nvm',
    NVM_SYMLINK: 'C:\\nvm4w\\nodejs',
    TOOLS: '%TOOLS_ROOT%\\bin',
    TOOLS_ROOT: 'D:\\tools',
    LOOP: '%LOOP%'
  }

  it('expands %VAR% entries the OS left literal', () => {
    expect(expandPathEntry('%NVM_HOME%', env, 'win32')).toBe('C:\\nvm4w\\nvm')
    expect(expandPathEntry('%NVM_SYMLINK%\\', env, 'win32')).toBe('C:\\nvm4w\\nodejs')
  })

  it('expands one level of nesting', () => {
    expect(expandPathEntry('%TOOLS%', env, 'win32')).toBe('D:\\tools\\bin')
  })

  it('skips an entry that stays literal (unknown or self-referential)', () => {
    expect(expandPathEntry('%NOPE%\\bin', env, 'win32')).toBeNull()
    expect(expandPathEntry('%LOOP%', env, 'win32')).toBeNull()
  })

  it('strips a stray trailing quote and quoted entries', () => {
    expect(expandPathEntry('C:\\Program Files\\PowerShell\\7"', env, 'win32')).toBe(
      'C:\\Program Files\\PowerShell\\7'
    )
    expect(expandPathEntry('"C:\\a;b"', env, 'win32')).toBe('C:\\a;b')
  })

  it('skips empty and relative entries', () => {
    expect(expandPathEntry('', env, 'win32')).toBeNull()
    expect(expandPathEntry('   ', env, 'win32')).toBeNull()
    expect(expandPathEntry('.\\bin', env, 'win32')).toBeNull()
  })

  it('splits, skips and de-duplicates case-insensitively', () => {
    const value = 'C:\\Windows;;%NVM_HOME%;c:\\windows\\;%NOPE%;C:\\Program Files\\PowerShell\\7";'
    expect(splitPathList(value, env, 'win32')).toEqual([
      'C:\\Windows',
      'C:\\nvm4w\\nvm',
      'C:\\Program Files\\PowerShell\\7'
    ])
  })

  it('reads PATH case-insensitively from an injected env', () => {
    expect(
      currentPathEntries({ env: { Path: 'C:\\a;%X%', x: 'C:\\b' }, platform: 'win32' })
    ).toEqual(['C:\\a', 'C:\\b'])
  })
})

describe('POSIX PATH', () => {
  const env = { HOME: '/home/u', BREW: '/opt/homebrew' }

  it('expands $VAR, ${VAR} and a leading ~', () => {
    expect(expandPathEntry('$HOME/.local/bin', env, 'linux')).toBe('/home/u/.local/bin')
    expect(expandPathEntry('${BREW}/bin/', env, 'darwin')).toBe('/opt/homebrew/bin')
    expect(expandPathEntry('~/bin', env, 'linux')).toBe('/home/u/bin')
  })

  it('skips unexpanded, empty and relative entries', () => {
    expect(splitPathList('/usr/bin::$NOPE/bin:bin:/usr/bin/', env, 'linux')).toEqual(['/usr/bin'])
  })
})

describe('fresh PATH on Windows', () => {
  const HKLM = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\nodejs\\',
    ''
  ].join('\r\n')
  const HKCU = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_SZ    C:\\Users\\u\\AppData\\Roaming\\npm;%NVM_HOME%',
    ''
  ].join('\r\n')

  it('parses reg.exe output', () => {
    expect(parseRegQueryPath(HKLM)).toBe('%SystemRoot%\\system32;C:\\Program Files\\nodejs\\')
    expect(
      parseRegQueryPath('ERROR: The system was unable to find the specified registry key')
    ).toBeNull()
  })

  it('reads machine then user Path through reg.exe and expands them', async () => {
    const run = vi.fn<RunFn>(async (_cmd, args) =>
      ok(String(args[1]).startsWith('HKLM') ? HKLM : HKCU)
    )
    const env = { SystemRoot: 'C:\\Windows', NVM_HOME: 'C:\\nvm4w\\nvm' }
    await expect(freshPathEntries({ env, platform: 'win32', run })).resolves.toEqual([
      'C:\\Windows\\system32',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\u\\AppData\\Roaming\\npm',
      'C:\\nvm4w\\nvm'
    ])
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0][0]).toBe('C:\\Windows\\System32\\reg.exe')
    expect(run.mock.calls[0][2].timeoutMs).toBe(5000)
  })

  it('a failed or throwing query contributes nothing', async () => {
    const run = vi.fn<RunFn>(async (_cmd, args) =>
      String(args[1]).startsWith('HKLM') ? { stdout: '', code: 1, timedOut: false } : ok(HKCU)
    )
    await expect(freshPathEntries({ env: {}, platform: 'win32', run })).resolves.toEqual([
      'C:\\Users\\u\\AppData\\Roaming\\npm'
    ])
    const throwing = vi.fn<RunFn>(async () => {
      throw new Error('boom')
    })
    await expect(freshPathEntries({ env: {}, platform: 'win32', run: throwing })).resolves.toEqual(
      []
    )
  })
})

describe('fresh PATH on macOS/Linux', () => {
  it('runs the login shell once and reads PATH between the markers', async () => {
    const run = vi.fn<RunFn>(async () =>
      ok('Welcome!\n__CLAUDEUI_PATH__/opt/homebrew/bin:/usr/bin:$HOME/.cargo/bin__CLAUDEUI_PATH__')
    )
    const env = { SHELL: '/bin/zsh', HOME: '/Users/u' }
    await expect(freshPathEntries({ env, platform: 'darwin', run })).resolves.toEqual([
      '/opt/homebrew/bin',
      '/usr/bin',
      '/Users/u/.cargo/bin'
    ])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toBe('/bin/zsh')
    expect(run.mock.calls[0][1]).toEqual(loginShellArgs('/bin/zsh'))
  })

  it('uses fish syntax for fish', () => {
    expect(loginShellArgs('/usr/local/bin/fish')[1]).toContain('string join : $PATH')
    expect(loginShellArgs('/bin/bash')[1]).toContain('"$PATH"')
  })

  it('needs both markers', () => {
    expect(parseShellPath('__CLAUDEUI_PATH__/usr/bin')).toBeNull()
    expect(parseShellPath('x__CLAUDEUI_PATH____CLAUDEUI_PATH__')).toBe('')
  })

  it('contributes nothing without SHELL, on failure or on timeout', async () => {
    const run = vi.fn<RunFn>(async () => ({ stdout: '', code: null, timedOut: true }))
    await expect(freshPathEntries({ env: {}, platform: 'linux', run })).resolves.toEqual([])
    expect(run).not.toHaveBeenCalled()
    await expect(
      freshPathEntries({ env: { SHELL: '/bin/bash' }, platform: 'linux', run })
    ).resolves.toEqual([])
  })
})

describe('searchPathEntries', () => {
  it('keeps the process PATH first and appends fresh directories it lacks', async () => {
    const run = vi.fn<RunFn>(async () => ok('__CLAUDEUI_PATH__/usr/bin:/new/bin__CLAUDEUI_PATH__'))
    const env = { PATH: '/usr/local/bin:/usr/bin', SHELL: '/bin/sh' }
    await expect(searchPathEntries({ env, platform: 'linux', run })).resolves.toEqual([
      '/usr/local/bin',
      '/usr/bin',
      '/new/bin'
    ])
  })
})
