/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveredKeyFingerprints, keyFingerprint } from '../delivered-keys'

const KEY = 'sk-or-v1-fingerprint-fixture-0000'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delivered-keys-'))
  file = join(dir, 'ui', 'delivered-key-fingerprints.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('fingerprints of delivered keys (ADR-082 §8, S7d)', () => {
  it('records a SHA-256 per harness slot, never the key, and survives a new instance', () => {
    const store = deliveredKeyFingerprints(file)
    expect(store.matches('pi', 'openrouter', KEY)).toBe(false) // no record: an older install
    expect(existsSync(file)).toBe(false)
    store.record('pi', 'openrouter', KEY)

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(KEY)
    expect(JSON.parse(raw)).toEqual({ pi: { openrouter: keyFingerprint(KEY) } })
    const again = deliveredKeyFingerprints(file)
    expect(again.matches('pi', 'openrouter', KEY)).toBe(true)
    expect(again.matches('opencode', 'openrouter', KEY)).toBe(false)
    expect(again.matches('pi', 'openrouter', `${KEY}x`)).toBe(false)

    again.forget('pi', 'openrouter')
    expect(deliveredKeyFingerprints(file).matches('pi', 'openrouter', KEY)).toBe(false)
  })
})
