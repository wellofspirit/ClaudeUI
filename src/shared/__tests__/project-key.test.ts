/**
 * Unit tests for cwdToProjectKey.
 *
 * Core guarantee: Windows paths with '/' and '\\' BOTH map to the same key.
 * This is what allows opencode (which stores cwd with forward slashes on Windows)
 * and Claude (which reads real dir names from ~/.claude/projects/) to collapse to
 * the same sidebar group.
 */
import { describe, it, expect } from 'vitest'
import { cwdToProjectKey } from '../project-key'

describe('cwdToProjectKey', () => {
  it('maps empty string to empty string', () => {
    expect(cwdToProjectKey('')).toBe('')
  })

  it('maps a Windows path with forward slashes to the Claude-format key', () => {
    expect(cwdToProjectKey('D:/WorkPlace/ClaudeUI')).toBe('D--WorkPlace-ClaudeUI')
  })

  it('maps the SAME Windows path with backslashes to the IDENTICAL key', () => {
    expect(cwdToProjectKey('D:\\WorkPlace\\ClaudeUI')).toBe('D--WorkPlace-ClaudeUI')
  })

  it('forward-slash and backslash variants of the same path produce the same key', () => {
    const forward = cwdToProjectKey('D:/WorkPlace/ClaudeUI')
    const back = cwdToProjectKey('D:\\WorkPlace\\ClaudeUI')
    expect(forward).toBe(back)
  })

  it('maps D:/WorkPlace/tools-auggie correctly', () => {
    expect(cwdToProjectKey('D:/WorkPlace/tools-auggie')).toBe('D--WorkPlace-tools-auggie')
  })

  it('maps a POSIX path correctly', () => {
    expect(cwdToProjectKey('/home/u/proj')).toBe('-home-u-proj')
  })

  it('replaces colons and all non-alphanumeric chars', () => {
    expect(cwdToProjectKey('C:/foo bar/baz.ts')).toBe('C--foo-bar-baz-ts')
  })

  it('preserves alphanumeric characters unchanged', () => {
    expect(cwdToProjectKey('abc123')).toBe('abc123')
  })
})
