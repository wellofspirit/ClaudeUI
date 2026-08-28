/**
 * @vitest-environment node
 *
 * Tests for pi-native-raw.ts — the raw reader / leaf-patch writer for pi's own
 * global settings file. Real files under a temp directory: `os.homedir()` is
 * redirected there via a hoisted mock (same trick as pi-session-list.test.ts) so
 * `piAgentDir()` — and therefore `~/.pi/agent/settings.json` — resolves inside
 * the fixture tree. The REAL home directory is never read or written.
 *
 * Guards:
 * - read: absent / unparseable → `{}` + the resolved path, file never created
 * - read: a BOM'd file still parses
 * - patch: a leaf set preserves siblings AND the untouched bytes verbatim
 * - patch: nested leaves create intermediate objects
 * - patch: delete removes exactly one key; delete-of-missing is a NO-OP; the
 *   now-empty parent is left alone
 * - create-on-first-patch: mkdir'd parent, 2-space indent, trailing newline
 * - CRLF and BOM survive a patch
 * - byte no-op patch sets never touch the file (mtime unchanged)
 * - path validation rejections (empty, bad segment type, prototype hops)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as jsoncParse } from 'jsonc-parser'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

import { readPiNativeRaw, patchPiNativeRaw, piSettingsFile } from '../pi-native-raw'

let testHome: string

/** The fixture's `~/.pi/agent/settings.json`. */
function settingsPath(): string {
  return join(testHome, '.pi', 'agent', 'settings.json')
}

/** Write a settings.json fixture (creating `~/.pi/agent`), returning its path. */
function writeSettings(text: string): string {
  const p = settingsPath()
  mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true })
  writeFileSync(p, text, 'utf-8')
  return p
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'pi-native-raw-test-'))
  homedirHolder.current = testHome
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('readPiNativeRaw', () => {
  it('returns {} and the resolved path when no file exists, and does NOT create it', () => {
    const { config, path } = readPiNativeRaw()
    expect(config).toEqual({})
    expect(path).toBe(settingsPath())
    expect(path).toBe(piSettingsFile())
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(testHome, '.pi'))).toBe(false)
  })

  it('returns the parsed settings verbatim (no projection)', () => {
    writeSettings(
      `{
  "theme": "light",
  "defaultThinkingLevel": "high",
  "compaction": { "enabled": true, "reserveTokens": 8192 },
  "someFutureKey": [1, 2, 3]
}`
    )
    const { config } = readPiNativeRaw()
    expect(config.theme).toBe('light')
    expect(config.defaultThinkingLevel).toBe('high')
    expect(config.compaction).toEqual({ enabled: true, reserveTokens: 8192 })
    expect(config.someFutureKey).toEqual([1, 2, 3])
  })

  it('returns {} for an unparseable file (and leaves it alone)', () => {
    const p = writeSettings('{ this is not json at all ')
    const { config } = readPiNativeRaw()
    expect(config).toEqual({})
    expect(readFileSync(p, 'utf-8')).toBe('{ this is not json at all ')
  })

  it('returns {} when the top level is not an object', () => {
    writeSettings('[1, 2, 3]')
    expect(readPiNativeRaw().config).toEqual({})
  })

  it('parses a file carrying a UTF-8 BOM', () => {
    writeSettings('\uFEFF{ "theme": "dark" }')
    expect(readPiNativeRaw().config).toEqual({ theme: 'dark' })
  })
})

describe('patchPiNativeRaw — leaf writes', () => {
  it('sets a leaf while preserving sibling keys and the untouched bytes verbatim', () => {
    const p = writeSettings(
      `{
  "theme": "dark",
  "thinkingBudgets": {
    "minimal": 1024,
    "high": 32768
  },
  "externalEditor": "code --wait"
}`
    )
    patchPiNativeRaw([{ path: ['theme'], value: 'light' }])
    const text = readFileSync(p, 'utf-8')
    // Every region except the edited leaf is byte-identical.
    expect(text).toContain(`  "thinkingBudgets": {\n    "minimal": 1024,\n    "high": 32768\n  },`)
    expect(text).toContain(`  "externalEditor": "code --wait"`)
    const parsed = jsoncParse(text)
    expect(parsed.theme).toBe('light')
    expect(parsed.thinkingBudgets).toEqual({ minimal: 1024, high: 32768 })
    expect(parsed.externalEditor).toBe('code --wait')
  })

  it('preserves a comment in an untouched region (jsonc modify, not a reserialize)', () => {
    // pi's own loader takes plain JSON; nothing here ADDS a comment, but a
    // hand-annotated file must survive an edit rather than be reformatted away.
    const p = writeSettings(
      `{
  // hand-written note
  "theme": "dark",
  "quietStartup": true
}`
    )
    patchPiNativeRaw([{ path: ['quietStartup'], value: false }])
    const text = readFileSync(p, 'utf-8')
    expect(text).toContain('// hand-written note')
    expect(jsoncParse(text)).toEqual({ theme: 'dark', quietStartup: false })
  })

  it('creates intermediate objects for a nested leaf', () => {
    const p = writeSettings(`{ "theme": "dark" }`)
    patchPiNativeRaw([{ path: ['compaction', 'reserveTokens'], value: 8192 }])
    const parsed = jsoncParse(readFileSync(p, 'utf-8'))
    expect(parsed).toEqual({ theme: 'dark', compaction: { reserveTokens: 8192 } })
  })

  it('applies several patches in one call', () => {
    const p = writeSettings(`{ "theme": "dark" }`)
    patchPiNativeRaw([
      { path: ['compaction', 'enabled'], value: false },
      { path: ['compaction', 'reserveTokens'], value: 4096 },
      { path: ['defaultProvider'], value: 'anthropic' }
    ])
    expect(jsoncParse(readFileSync(p, 'utf-8'))).toEqual({
      theme: 'dark',
      compaction: { enabled: false, reserveTokens: 4096 },
      defaultProvider: 'anthropic'
    })
  })
})

describe('patchPiNativeRaw — deletes', () => {
  it('deletes exactly the named leaf, preserving siblings', () => {
    const p = writeSettings(
      `{ "compaction": { "enabled": true, "reserveTokens": 8192 }, "theme": "dark" }`
    )
    patchPiNativeRaw([{ path: ['compaction', 'reserveTokens'] }])
    const parsed = jsoncParse(readFileSync(p, 'utf-8'))
    expect(parsed.compaction).toEqual({ enabled: true })
    expect(parsed.theme).toBe('dark')
  })

  it('treats `value: undefined` as a delete', () => {
    const p = writeSettings(`{ "theme": "dark", "quietStartup": true }`)
    patchPiNativeRaw([{ path: ['quietStartup'], value: undefined }])
    expect(jsoncParse(readFileSync(p, 'utf-8'))).toEqual({ theme: 'dark' })
  })

  it('deleting a MISSING leaf is a no-op, not a throw — file untouched', () => {
    const p = writeSettings(`{ "theme": "dark" }`)
    const before = readFileSync(p, 'utf-8')
    expect(() => patchPiNativeRaw([{ path: ['compaction', 'reserveTokens'] }])).not.toThrow()
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })

  it('deleting a leaf under a MISSING parent is a no-op (the modify() invariant)', () => {
    const p = writeSettings(`{ "theme": "dark" }`)
    expect(() => patchPiNativeRaw([{ path: ['a', 'b', 'c'] }])).not.toThrow()
    expect(jsoncParse(readFileSync(p, 'utf-8'))).toEqual({ theme: 'dark' })
  })

  it('deleting a missing leaf never creates the file', () => {
    expect(() => patchPiNativeRaw([{ path: ['theme'] }])).not.toThrow()
    expect(existsSync(settingsPath())).toBe(false)
  })

  it('deleting the LAST child leaves the now-empty parent in place', () => {
    // Collapsing an empty branch is the panes' decision, not the writer's.
    const p = writeSettings(`{ "compaction": { "reserveTokens": 8192 } }`)
    patchPiNativeRaw([{ path: ['compaction', 'reserveTokens'] }])
    const parsed = jsoncParse(readFileSync(p, 'utf-8'))
    expect(parsed).toEqual({ compaction: {} })
    expect('compaction' in parsed).toBe(true)
  })
})

describe('patchPiNativeRaw — file creation', () => {
  it('creates the file (and its parent dir) on the first patch, 2-space + trailing newline', () => {
    expect(existsSync(settingsPath())).toBe(false)
    patchPiNativeRaw([{ path: ['compaction', 'reserveTokens'], value: 8192 }])
    const text = readFileSync(settingsPath(), 'utf-8')
    expect(text).toBe('{\n  "compaction": {\n    "reserveTokens": 8192\n  }\n}\n')
    expect(readPiNativeRaw().config).toEqual({ compaction: { reserveTokens: 8192 } })
  })

  it('an EMPTY patch array never creates the file', () => {
    patchPiNativeRaw([])
    expect(existsSync(settingsPath())).toBe(false)
  })

  it('refuses to overwrite a settings.json that EXISTS but cannot be read', () => {
    // A directory at the settings path is the portable stand-in for "present,
    // unreadable" (no chmod on Windows): existsSync says yes, readFileSync
    // throws EISDIR. Without the guard this would seed from `{}` and clobber.
    mkdirSync(settingsPath(), { recursive: true })
    expect(() => patchPiNativeRaw([{ path: ['theme'], value: 'light' }])).toThrow(
      /Refusing to overwrite unreadable pi settings file/
    )
  })
})

describe('patchPiNativeRaw — encoding preservation', () => {
  it('keeps a CRLF file on CRLF', () => {
    const p = writeSettings('{\r\n  "theme": "dark"\r\n}\r\n')
    patchPiNativeRaw([{ path: ['quietStartup'], value: true }])
    const text = readFileSync(p, 'utf-8')
    expect(text).toContain('\r\n')
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    expect(jsoncParse(text)).toEqual({ theme: 'dark', quietStartup: true })
  })

  it('keeps a leading BOM after a patch', () => {
    const p = writeSettings('\uFEFF{\n  "theme": "dark"\n}\n')
    patchPiNativeRaw([{ path: ['theme'], value: 'light' }])
    const text = readFileSync(p, 'utf-8')
    expect(text.startsWith('\uFEFF')).toBe(true)
    // Exactly one BOM, and it did not leak into the parsed body.
    expect(text.indexOf('\uFEFF', 1)).toBe(-1)
    expect(jsoncParse(text.slice(1))).toEqual({ theme: 'light' })
  })

  it('does NOT add a BOM to a file that had none', () => {
    const p = writeSettings('{\n  "theme": "dark"\n}\n')
    patchPiNativeRaw([{ path: ['theme'], value: 'light' }])
    expect(readFileSync(p, 'utf-8').startsWith('\uFEFF')).toBe(false)
  })

  it('keeps an existing trailing newline and does not add a second one', () => {
    const p = writeSettings('{\n  "theme": "dark"\n}\n')
    patchPiNativeRaw([{ path: ['quietStartup'], value: true }])
    const text = readFileSync(p, 'utf-8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('}\n\n')).toBe(false)
  })
})

describe('patchPiNativeRaw — write gate', () => {
  it('a patch whose value is already present does not rewrite the file', async () => {
    const p = writeSettings(`{\n  "theme": "dark",\n  "quietStartup": true\n}\n`)
    const before = readFileSync(p, 'utf-8')
    const mtimeBefore = statSync(p).mtimeMs
    // Ensure a rewrite WOULD be observable in mtime.
    await new Promise((r) => setTimeout(r, 10))
    patchPiNativeRaw([{ path: ['theme'], value: 'dark' }])
    expect(readFileSync(p, 'utf-8')).toBe(before)
    expect(statSync(p).mtimeMs).toBe(mtimeBefore)
  })

  it('a delete of an absent leaf does not rewrite the file', async () => {
    const p = writeSettings(`{\n  "theme": "dark"\n}\n`)
    const mtimeBefore = statSync(p).mtimeMs
    await new Promise((r) => setTimeout(r, 10))
    patchPiNativeRaw([{ path: ['quietStartup'] }])
    expect(statSync(p).mtimeMs).toBe(mtimeBefore)
  })
})

describe('patchPiNativeRaw — path validation', () => {
  it('rejects an empty path and writes nothing', () => {
    const p = writeSettings(`{ "theme": "dark" }`)
    const before = readFileSync(p, 'utf-8')
    expect(() => patchPiNativeRaw([{ path: [], value: 1 }])).toThrow(/empty path/)
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })

  it('rejects a non-string/number path segment', () => {
    expect(() =>
      patchPiNativeRaw([{ path: ['compaction', null as unknown as string], value: 1 }])
    ).toThrow(/segment 1 is not a string or number/)
    expect(() =>
      patchPiNativeRaw([{ path: [{ evil: true } as unknown as string], value: 1 }])
    ).toThrow(/segment 0 is not a string or number/)
  })

  it('rejects prototype-polluting segments', () => {
    for (const seg of ['__proto__', 'constructor', 'prototype']) {
      expect(() => patchPiNativeRaw([{ path: [seg, 'x'], value: 1 }])).toThrow(/prototype segment/)
      expect(() => patchPiNativeRaw([{ path: ['compaction', seg], value: 1 }])).toThrow(
        /prototype segment/
      )
    }
    expect(existsSync(settingsPath())).toBe(false)
    // The prototype is intact.
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('rejects the WHOLE set when one patch is invalid (nothing partially applied)', () => {
    const p = writeSettings(`{ "theme": "dark" }`)
    const before = readFileSync(p, 'utf-8')
    expect(() =>
      patchPiNativeRaw([
        { path: ['quietStartup'], value: true },
        { path: [], value: 1 }
      ])
    ).toThrow(/empty path/)
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })
})
