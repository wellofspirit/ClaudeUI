/**
 * @vitest-environment node
 *
 * `harness.ts` (what the spawned Claude Code binary carries) and the
 * `CLAUDEUI_CLAUDE_CLI` override in `locate.ts`.
 *
 * The rule under test: when in doubt, the harness is unpatched. A missing,
 * unreadable or malformed version.json must switch patch-gated surfaces OFF,
 * never on, and the override must never fail a spawn outright.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readHarnessInfo, harnessHasPatch, getCliVersion } from '../harness'
import { locateBunClaude, CLAUDE_CLI_OVERRIDE_ENV } from '../locate'

const BIN = process.platform === 'win32' ? 'bun-claude.exe' : 'bun-claude'

let dirs: string[] = []
const savedOverride = process.env[CLAUDE_CLI_OVERRIDE_ENV]

/** A temp dir holding a fake binary and, when given, a version.json beside it. */
function fakeHarness(versionJson?: string | object, binName = BIN): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'))
  dirs.push(dir)
  const bin = path.join(dir, binName)
  fs.writeFileSync(bin, '')
  if (versionJson !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'version.json'),
      typeof versionJson === 'string' ? versionJson : JSON.stringify(versionJson)
    )
  }
  return bin
}

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

beforeEach(() => {
  delete process.env[CLAUDE_CLI_OVERRIDE_ENV]
  warnSpy.mockClear()
})

afterEach(() => {
  if (savedOverride === undefined) delete process.env[CLAUDE_CLI_OVERRIDE_ENV]
  else process.env[CLAUDE_CLI_OVERRIDE_ENV] = savedOverride
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('readHarnessInfo', () => {
  it('reads the version and the patch list beside the binary', () => {
    const info = readHarnessInfo(
      fakeHarness({ version: '2.1.280', patches: ['subagent-streaming', 'voice-server'] })
    )
    expect(info.version).toBe('2.1.280')
    expect([...info.patches]).toEqual(['subagent-streaming', 'voice-server'])
  })

  it('treats a binary with no version.json (the official one) as unknown and unpatched', () => {
    const info = readHarnessInfo(fakeHarness(undefined, 'claude.exe'))
    expect(info.version).toBe('unknown')
    expect(info.patches.size).toBe(0)
  })

  it('treats malformed JSON as unknown and unpatched', () => {
    const info = readHarnessInfo(fakeHarness('{"version": "2.1.280", "patches": ['))
    expect(info.version).toBe('unknown')
    expect(info.patches.size).toBe(0)
  })

  it('reads a build from before the patches field as unpatched but keeps its version', () => {
    const info = readHarnessInfo(fakeHarness({ version: '2.1.268', form: 'chunked' }))
    expect(info.version).toBe('2.1.268')
    expect(info.patches.size).toBe(0)
  })

  it('ignores a patches field that is not a list of names', () => {
    expect(
      readHarnessInfo(fakeHarness({ version: '1', patches: 'voice-server' })).patches.size
    ).toBe(0)
    const mixed = readHarnessInfo(fakeHarness({ version: 1, patches: ['voice-server', 7, null] }))
    expect([...mixed.patches]).toEqual(['voice-server'])
    expect(mixed.version).toBe('unknown')
    expect(readHarnessInfo(fakeHarness('null')).version).toBe('unknown')
  })

  it('re-reads the file once its mtime moves', () => {
    const bin = fakeHarness({ version: '1', patches: ['voice-server'] })
    const file = path.join(path.dirname(bin), 'version.json')
    expect(readHarnessInfo(bin).patches.has('voice-server')).toBe(true)

    fs.writeFileSync(file, JSON.stringify({ version: '2', patches: [] }))
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(file, later, later)
    const info = readHarnessInfo(bin)
    expect(info.version).toBe('2')
    expect(info.patches.has('voice-server')).toBe(false)

    fs.rmSync(file)
    expect(readHarnessInfo(bin).version).toBe('unknown')
  })
})

describe('CLAUDEUI_CLAUDE_CLI', () => {
  it('replaces the bundled binary, and the harness is read from beside the override', () => {
    const bin = fakeHarness({ version: '9.9.9', patches: ['voice-server'] })
    process.env[CLAUDE_CLI_OVERRIDE_ENV] = bin
    expect(locateBunClaude()).toBe(bin)
    expect(getCliVersion()).toBe('9.9.9')
    expect(harnessHasPatch('voice-server')).toBe(true)
    expect(harnessHasPatch('bash-output-streaming')).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('makes an official binary read as unpatched', () => {
    process.env[CLAUDE_CLI_OVERRIDE_ENV] = fakeHarness(undefined, 'claude-2.1.280-win32-x64.exe')
    expect(harnessHasPatch('voice-server')).toBe(false)
    expect(getCliVersion()).toBe('unknown')
  })

  it('resolves a relative value against the cwd', () => {
    const bin = fakeHarness({ version: '1' })
    process.env[CLAUDE_CLI_OVERRIDE_ENV] = path.relative(process.cwd(), bin)
    expect(locateBunClaude()).toBe(bin)
  })

  it('falls back to the bundled binary, warning once, when the file is missing', () => {
    const bundled = locateBunClaude()
    const missing = path.join(os.tmpdir(), `no-such-claude-${process.pid}`, BIN)
    process.env[CLAUDE_CLI_OVERRIDE_ENV] = missing
    expect(locateBunClaude()).toBe(bundled)
    expect(locateBunClaude()).toBe(bundled)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain(missing)
  })

  it('falls back when the value names a directory', () => {
    const bundled = locateBunClaude()
    process.env[CLAUDE_CLI_OVERRIDE_ENV] = path.dirname(fakeHarness({ version: '1' }))
    expect(locateBunClaude()).toBe(bundled)
  })
})
