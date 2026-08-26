/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for isWorkspaceTrusted() in claude-settings.ts.
 *
 * Trust decides whether cli.js honors a workspace's project/local ALLOW rules
 * at all, so a key-normalization miss reads as "untrusted" and would put a
 * false warning in front of the user (or hide a real one).
 *
 * Strategy: same hoisted os.homedir() override as claude-settings-cleanup.test
 * — a FIXTURE ~/.claude.json in a scratch tmpdir. The real ~/.claude.json is
 * never read: it holds account data, and its contents would make the
 * assertions machine-dependent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')
  const realOs = require('os') as typeof import('os')
  const realPath = require('path') as typeof import('path')
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-trust-test-'))
  return { TEST_HOME: home }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => hoisted.TEST_HOME },
    homedir: () => hoisted.TEST_HOME
  }
})

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import { isWorkspaceTrusted } from '../../../core/services/claude-settings'

const CLAUDE_JSON = path.join(hoisted.TEST_HOME, '.claude.json')

function writeClaudeJson(projects: Record<string, unknown>): void {
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ projects, numStartups: 3 }, null, 2))
}

describe('isWorkspaceTrusted', () => {
  beforeEach(() => {
    fs.rmSync(CLAUDE_JSON, { force: true })
  })

  afterEach(() => {
    fs.rmSync(CLAUDE_JSON, { force: true })
  })

  it('returns false when ~/.claude.json does not exist', () => {
    expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(false)
  })

  it('returns false when the file has no projects map', () => {
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ numStartups: 1 }))
    expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(false)
  })

  it('returns false for a malformed file rather than throwing', () => {
    fs.writeFileSync(CLAUDE_JSON, '{ not json')
    expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(false)
  })

  it('returns true on an exact key match with hasTrustDialogAccepted', () => {
    writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: true } })
    expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(true)
  })

  it('returns false for an unknown workspace', () => {
    writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: true } })
    expect(isWorkspaceTrusted('D:/WorkPlace/Other')).toBe(false)
  })

  it('returns false when the entry exists but trust was never accepted', () => {
    writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: false } })
    expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(false)
    writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { allowedTools: [] } })
    expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(false)
  })

  // The real file on Windows carries BOTH spellings (cli.js keys by the cwd
  // string as its shell handed it over), so neither may be assumed.
  describe('Windows path-key normalization', () => {
    it('matches a backslash key from a forward-slash cwd', () => {
      writeClaudeJson({ 'D:\\WorkPlace\\ClaudeUI': { hasTrustDialogAccepted: true } })
      expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(true)
    })

    it('matches a forward-slash key from a backslash cwd', () => {
      writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: true } })
      expect(isWorkspaceTrusted('D:\\WorkPlace\\ClaudeUI')).toBe(true)
    })

    it('matches across drive-letter case', () => {
      writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: true } })
      expect(isWorkspaceTrusted('d:/WorkPlace/ClaudeUI')).toBe(true)
    })

    it('ignores a trailing separator on the cwd', () => {
      writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: true } })
      expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI/')).toBe(true)
      expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI\\')).toBe(true)
    })

    it('does not fall through from a matched untrusted entry to a trusted spelling', () => {
      // Both spellings present with opposite verdicts: the first candidate
      // (the cwd exactly as given) must decide, not "any true wins".
      writeClaudeJson({
        'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: false },
        'D:\\WorkPlace\\ClaudeUI': { hasTrustDialogAccepted: true }
      })
      expect(isWorkspaceTrusted('D:/WorkPlace/ClaudeUI')).toBe(false)
      expect(isWorkspaceTrusted('D:\\WorkPlace\\ClaudeUI')).toBe(true)
    })

    it('handles POSIX cwds unchanged', () => {
      writeClaudeJson({ '/home/dev/repo': { hasTrustDialogAccepted: true } })
      expect(isWorkspaceTrusted('/home/dev/repo')).toBe(true)
      expect(isWorkspaceTrusted('/home/dev/other')).toBe(false)
    })
  })

  it('returns false for an empty cwd', () => {
    writeClaudeJson({ 'D:/WorkPlace/ClaudeUI': { hasTrustDialogAccepted: true } })
    expect(isWorkspaceTrusted('')).toBe(false)
  })
})
