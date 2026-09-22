/**
 * Unit tests for displayCwd.
 *
 * The guarantee: a drive-lettered path reads with one separator style no
 * matter which engine stored it, and a POSIX path is never touched (a
 * backslash there is a legal filename character, not a separator).
 */
import { describe, it, expect } from 'vitest'
import { displayCwd } from '../display-path'

describe('displayCwd', () => {
  it('turns forward slashes into backslashes on a drive-lettered path', () => {
    expect(displayCwd('D:/WorkPlace/x')).toBe('D:\\WorkPlace\\x')
  })

  it('leaves a POSIX path unchanged', () => {
    expect(displayCwd('/home/me/x')).toBe('/home/me/x')
  })

  it('leaves an already-backslashed Windows path unchanged', () => {
    expect(displayCwd('D:\\already\\x')).toBe('D:\\already\\x')
  })

  it('normalizes a mixed path', () => {
    expect(displayCwd('D:\\a/b')).toBe('D:\\a\\b')
  })

  it('leaves the empty string unchanged', () => {
    expect(displayCwd('')).toBe('')
  })
})
