/**
 * @vitest-environment node
 *
 * `permissions.blockReadsOutsideWorkingDirectories` (pi path containment, R9): the loader reads
 * it (only an exact `true` counts) and `saveClaudePermissions` — which rebuilds `permissions`
 * from scratch — keeps it from disk, so editing a rule in the UI never lifts the fence.
 *
 * Same strategy as claude-settings-automode-flags.test.ts: `os.homedir()` points at a scratch
 * tmpdir, so the real exported functions run against a real file.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')
  const realOs = require('os') as typeof import('os')
  const realPath = require('path') as typeof import('path')
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-read-block-'))
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

import {
  loadClaudePermissions,
  saveClaudePermissions
} from '../../../core/services/claude-settings'

const USER_SETTINGS = path.join(hoisted.TEST_HOME, '.claude', 'settings.json')

function writeJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj))
}

const readBack = (): Record<string, unknown> => JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8'))

describe('permissions.blockReadsOutsideWorkingDirectories', () => {
  beforeEach(() => {
    if (fs.existsSync(USER_SETTINGS)) fs.unlinkSync(USER_SETTINGS)
  })

  afterAll(() => {
    fs.rmSync(hoisted.TEST_HOME, { recursive: true, force: true })
  })

  it('is absent when the file is missing or the key is unset', () => {
    expect(loadClaudePermissions('user').blockReadsOutsideWorkingDirectories).toBeUndefined()
    writeJson(USER_SETTINGS, { permissions: { allow: ['Read'] } })
    expect(loadClaudePermissions('user').blockReadsOutsideWorkingDirectories).toBeUndefined()
  })

  it('is true only for an exact boolean true', () => {
    writeJson(USER_SETTINGS, { permissions: { blockReadsOutsideWorkingDirectories: true } })
    expect(loadClaudePermissions('user').blockReadsOutsideWorkingDirectories).toBe(true)
    for (const bad of [false, 'true', 1, null]) {
      writeJson(USER_SETTINGS, { permissions: { blockReadsOutsideWorkingDirectories: bad } })
      expect(loadClaudePermissions('user').blockReadsOutsideWorkingDirectories).toBeUndefined()
    }
  })

  it('survives a permission edit: save keeps the fence from disk and the rest of the file', () => {
    writeJson(USER_SETTINGS, {
      model: 'x',
      permissions: { allow: ['Read'], blockReadsOutsideWorkingDirectories: true }
    })
    const loaded = loadClaudePermissions('user')
    saveClaudePermissions('user', { ...loaded, allow: ['Read', 'Bash(git status)'] })
    const saved = readBack()
    expect(saved.model).toBe('x')
    expect(saved.permissions).toMatchObject({
      allow: ['Read', 'Bash(git status)'],
      blockReadsOutsideWorkingDirectories: true
    })
    expect(loadClaudePermissions('user').blockReadsOutsideWorkingDirectories).toBe(true)
  })

  it('save does not invent the fence when the file never had it', () => {
    writeJson(USER_SETTINGS, { permissions: { allow: ['Read'] } })
    saveClaudePermissions('user', { ...loadClaudePermissions('user'), deny: ['Bash(rm:*)'] })
    expect(readBack().permissions).not.toHaveProperty('blockReadsOutsideWorkingDirectories')
  })

  it('a fence-only permissions object is not dropped as "empty"', () => {
    writeJson(USER_SETTINGS, {
      permissions: { allow: ['Read'], blockReadsOutsideWorkingDirectories: true }
    })
    saveClaudePermissions('user', { ...loadClaudePermissions('user'), allow: [] })
    expect(readBack().permissions).toEqual({ blockReadsOutsideWorkingDirectories: true })
  })
})
