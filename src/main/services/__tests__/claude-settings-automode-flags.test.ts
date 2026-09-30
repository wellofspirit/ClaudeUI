/**
 * @vitest-environment node
 *
 * ADR-085 §4 — `loadClaudeAutoModeFlags`: the user's
 * `autoMode.classifyAllShell`, read from the USER settings file only (cli.js
 * ignores project/local for this flag), and only an exact `true` counts.
 *
 * Same strategy as claude-settings-cleanup.test.ts: `os.homedir()` points at
 * a scratch tmpdir, so the real exported function runs against a real file.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')
  const realOs = require('os') as typeof import('os')
  const realPath = require('path') as typeof import('path')
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-automode-flags-'))
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

import { loadClaudeAutoModeFlags } from '../../../core/services/claude-settings'

const USER_SETTINGS = path.join(hoisted.TEST_HOME, '.claude', 'settings.json')

function writeJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj))
}

describe('loadClaudeAutoModeFlags', () => {
  beforeEach(() => {
    if (fs.existsSync(USER_SETTINGS)) fs.unlinkSync(USER_SETTINGS)
  })

  afterAll(() => {
    fs.rmSync(hoisted.TEST_HOME, { recursive: true, force: true })
  })

  it('false when there is no user settings file', () => {
    expect(loadClaudeAutoModeFlags()).toEqual({ classifyAllShell: false })
  })

  it('true only for an exact `true` under autoMode', () => {
    writeJson(USER_SETTINGS, { autoMode: { classifyAllShell: true } })
    expect(loadClaudeAutoModeFlags()).toEqual({ classifyAllShell: true })
    for (const value of ['true', 1, 'yes', {}, null, false]) {
      writeJson(USER_SETTINGS, { autoMode: { classifyAllShell: value } })
      expect(loadClaudeAutoModeFlags(), JSON.stringify(value)).toEqual({ classifyAllShell: false })
    }
    // Top-level, not under autoMode: not the setting.
    writeJson(USER_SETTINGS, { classifyAllShell: true })
    expect(loadClaudeAutoModeFlags()).toEqual({ classifyAllShell: false })
  })

  it('reads the file fresh on every call', () => {
    writeJson(USER_SETTINGS, { autoMode: { classifyAllShell: true } })
    expect(loadClaudeAutoModeFlags().classifyAllShell).toBe(true)
    writeJson(USER_SETTINGS, { autoMode: {} })
    expect(loadClaudeAutoModeFlags().classifyAllShell).toBe(false)
  })

  it('a malformed file reads as false', () => {
    writeJson(USER_SETTINGS, '{ not json')
    expect(loadClaudeAutoModeFlags()).toEqual({ classifyAllShell: false })
  })

  it('only the user file: a project/local settings file cannot set it', () => {
    // The function takes no cwd — there is no way for a repository's
    // `.claude/settings*.json` to reach it. Pin the signature.
    expect(loadClaudeAutoModeFlags.length).toBe(0)
    const project = path.join(hoisted.TEST_HOME, 'proj', '.claude')
    writeJson(path.join(project, 'settings.json'), { autoMode: { classifyAllShell: true } })
    writeJson(path.join(project, 'settings.local.json'), { autoMode: { classifyAllShell: true } })
    expect(loadClaudeAutoModeFlags()).toEqual({ classifyAllShell: false })
  })
})
