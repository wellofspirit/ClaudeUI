/**
 * @vitest-environment node
 *
 * Unit tests for the atomic JSON writer + corrupt-aware read (WS7 P1/R2).
 * Real fs against per-test temp dirs; the real home directory is never touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// A controllable fs mock: everything is the REAL fs (spread actual) except
// renameSync, which throws once when armed — the only way to simulate a crash
// between the temp write and the rename (ESM namespaces can't be vi.spyOn'd).
const renameControl = vi.hoisted(() => ({ failOnce: false }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameControl.failOnce) {
        renameControl.failOnce = false
        throw new Error('simulated crash between temp write and rename')
      }
      return actual.renameSync(...args)
    }
  }
})

import {
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeFileAtomicSync,
  readJsonFileForWrite
} from '../../../core/services/write-json-atomic'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'write-json-atomic-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic — serialization', () => {
  it('writes compact JSON when no indent is given (byte-identical to JSON.stringify(x))', () => {
    const target = join(dir, 'compact.json')
    const data = { a: 1, b: [2, 3] }
    writeJsonAtomic(target, data)
    expect(readFileSync(target, 'utf-8')).toBe(JSON.stringify(data))
  })

  it('writes 2-space indented JSON with no trailing newline for indent:2', () => {
    const target = join(dir, 'indented.json')
    const data = { a: 1 }
    writeJsonAtomic(target, data, { indent: 2 })
    expect(readFileSync(target, 'utf-8')).toBe(JSON.stringify(data, null, 2))
  })

  it('appends a trailing newline when trailingNewline is set (matches "... + \\n")', () => {
    const target = join(dir, 'nl.json')
    const data = { a: 1 }
    writeJsonAtomic(target, data, { indent: 2, trailingNewline: true })
    expect(readFileSync(target, 'utf-8')).toBe(JSON.stringify(data, null, 2) + '\n')
  })

  it('creates the parent directory if it does not exist', () => {
    const target = join(dir, 'nested', 'deep', 'file.json')
    writeJsonAtomic(target, { ok: true })
    expect(existsSync(target)).toBe(true)
  })

  it('leaves no .tmp files behind after a successful write', () => {
    const target = join(dir, 'clean.json')
    writeJsonAtomic(target, { a: 1 })
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  if (process.platform !== 'win32') {
    it('sets 0600 on the written file (POSIX)', () => {
      const target = join(dir, 'mode.json')
      writeJsonAtomic(target, { a: 1 })
      expect(statSync(target).mode & 0o777).toBe(0o600)
    })
  }

  it('async writer produces the same bytes as the sync writer', async () => {
    const target = join(dir, 'async.json')
    const data = { x: 'y' }
    await writeJsonAtomicAsync(target, data, { indent: 2 })
    expect(readFileSync(target, 'utf-8')).toBe(JSON.stringify(data, null, 2))
  })
})

describe('writeFileAtomicSync — atomicity (non-vacuity)', () => {
  it('a rename failure leaves the ORIGINAL file intact (no torn/truncated write) and cleans up the temp', () => {
    const target = join(dir, 'creds.json')
    // Pre-existing valid file that a plain writeFileSync would truncate on failure.
    writeFileSync(target, JSON.stringify({ vendorA: 'keep-me' }))

    renameControl.failOnce = true
    expect(() => writeFileAtomicSync(target, JSON.stringify({ vendorB: 'new' }))).toThrow(
      'simulated crash'
    )

    // Original untouched — the temp+rename design never truncated the target.
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ vendorA: 'keep-me' })
    // Abandoned temp cleaned up.
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('readJsonFileForWrite', () => {
  it('returns {} when the file is MISSING (fresh start)', () => {
    expect(readJsonFileForWrite(join(dir, 'nope.json'))).toEqual({})
  })

  it('returns the parsed object for a valid JSON object file', () => {
    const target = join(dir, 'valid.json')
    writeFileSync(target, JSON.stringify({ a: 1, b: 2 }))
    expect(readJsonFileForWrite(target)).toEqual({ a: 1, b: 2 })
  })

  it('THROWS and backs up once on a corrupt (unparseable) file — never degrades to {}', () => {
    const target = join(dir, 'corrupt.json')
    const corruptBytes = '{"vendorA":{"key":"secret"},"vendorB":' // truncated
    writeFileSync(target, corruptBytes)

    expect(() => readJsonFileForWrite(target)).toThrow(/Refusing to overwrite/)

    // Original left intact for recovery + a one-time .corrupt backup created.
    expect(readFileSync(target, 'utf-8')).toBe(corruptBytes)
    expect(readFileSync(`${target}.corrupt`, 'utf-8')).toBe(corruptBytes)
  })

  it('THROWS on a non-object top level (array / string)', () => {
    const target = join(dir, 'arr.json')
    writeFileSync(target, '[1,2,3]')
    expect(() => readJsonFileForWrite(target)).toThrow(/non-object/)
  })

  it('does not overwrite an existing .corrupt backup (keeps the first snapshot)', () => {
    const target = join(dir, 'c.json')
    writeFileSync(`${target}.corrupt`, 'FIRST')
    writeFileSync(target, '{bad')
    expect(() => readJsonFileForWrite(target)).toThrow()
    expect(readFileSync(`${target}.corrupt`, 'utf-8')).toBe('FIRST')
  })
})
