/**
 * @vitest-environment node
 *
 * The splitter behind the chunked `sync-full`: the pieces must rejoin to exactly
 * the input, stay within the size, and never cut a surrogate pair.
 */

import { describe, it, expect } from 'vitest'
import { SYNC_FULL_CHUNK_CHARS, splitSyncFullJson } from '../sync-full-chunks'

describe('splitSyncFullJson', () => {
  it('cuts at exact boundaries and rejoins to the input', () => {
    const json = 'abcdefghij'
    expect(splitSyncFullJson(json, 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(splitSyncFullJson(json, 5)).toEqual(['abcde', 'fghij'])
  })

  it('returns ONE piece for input at or under the size, and for empty input', () => {
    expect(splitSyncFullJson('abc', 3)).toEqual(['abc'])
    expect(splitSyncFullJson('abc', 100)).toEqual(['abc'])
    expect(splitSyncFullJson('', 8)).toEqual([''])
  })

  it('does not split a surrogate pair that straddles the boundary', () => {
    const json = 'ab😀cd' // 😀 is code units 2 and 3
    const parts = splitSyncFullJson(json, 3)
    expect(parts).toEqual(['ab', '😀c', 'd'])
    expect(parts.join('')).toBe(json)
    for (const p of parts) expect(p).toBe(p.toWellFormed())
  })

  it('still makes progress when the size is smaller than a pair', () => {
    const json = '😀😀'
    const parts = splitSyncFullJson(json, 1)
    expect(parts.join('')).toBe(json)
    expect(parts.length).toBe(4)
  })

  it('every piece is within the size and a large input rejoins exactly', () => {
    const json = JSON.stringify({ text: 'x😀y'.repeat(SYNC_FULL_CHUNK_CHARS) })
    const parts = splitSyncFullJson(json, SYNC_FULL_CHUNK_CHARS)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => p.length <= SYNC_FULL_CHUNK_CHARS)).toBe(true)
    expect(parts.join('')).toBe(json)
  })

  it('rejects a size below 1', () => {
    expect(() => splitSyncFullJson('abc', 0)).toThrow(RangeError)
    expect(() => splitSyncFullJson('abc', 1.5)).toThrow(RangeError)
  })
})
