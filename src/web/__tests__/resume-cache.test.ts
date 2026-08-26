/**
 * @vitest-environment jsdom
 *
 * The `sessionStorage` half of the passkey resumption token (ADR-063).
 *
 * Small on purpose: the value of this file is the two properties that are easy
 * to lose in a refactor and expensive to lose in production — a malformed cached
 * value is never presented, and every accessor survives storage being
 * unavailable (private mode, disabled site data) by degrading to "run the
 * ceremony every time" rather than throwing on the page's bootstrap path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  clearCachedResumeToken,
  readCachedResumeToken,
  writeCachedResumeToken
} from '../resume-cache'

const TOKEN = 'ab'.repeat(32)

describe('resume-cache', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips a well-formed token and clears it again', () => {
    expect(readCachedResumeToken()).toBeNull()
    writeCachedResumeToken(TOKEN)
    expect(readCachedResumeToken()).toBe(TOKEN)
    clearCachedResumeToken()
    expect(readCachedResumeToken()).toBeNull()
  })

  it('ignores anything not shaped like a 32-byte hex token', () => {
    for (const bad of [
      '',
      'not-a-token',
      'ab'.repeat(31),
      'ab'.repeat(33),
      `${TOKEN} `,
      'zz'.repeat(32)
    ]) {
      sessionStorage.setItem('claudeui-remote-resume', bad)
      expect(readCachedResumeToken(), bad).toBeNull()
    }
  })

  it('accepts uppercase hex — the regex is the shape test, not a canonical form', () => {
    sessionStorage.setItem('claudeui-remote-resume', TOKEN.toUpperCase())
    expect(readCachedResumeToken()).toBe(TOKEN.toUpperCase())
  })

  it('degrades rather than throwing when storage is unavailable', () => {
    // Private mode / disabled site data: the accessors themselves throw. The
    // page bootstrap reads this before anything is on screen, so a throw here
    // would be a blank tab rather than a sign-in screen.
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('storage disabled')
      })
    }
    expect(readCachedResumeToken()).toBeNull()
    expect(() => writeCachedResumeToken(TOKEN)).not.toThrow()
    expect(() => clearCachedResumeToken()).not.toThrow()
  })
})
