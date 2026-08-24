/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for the cleanupPeriodDays helpers in claude-settings.ts.
 *
 * Strategy:
 *  - Override os.homedir() to a scratch tmpdir so settingsFilePath('user')
 *    resolves to ~/.claude/settings.json inside an area we own. The mock is
 *    hoisted so it lands before claude-settings.ts is imported.
 *  - Mock ./logger to avoid real log file side effects.
 *  - Exercise the real exported functions against the real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')

  const realOs = require('os') as typeof import('os')

  const realPath = require('path') as typeof import('path')
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-cleanup-test-'))
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
  loadCleanupPeriodDays,
  saveCleanupPeriodDays
} from '../../../core/services/claude-settings'

const SETTINGS_PATH = path.join(hoisted.TEST_HOME, '.claude', 'settings.json')

function writeSettings(obj: unknown): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2))
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
}

describe('cleanupPeriodDays helpers', () => {
  beforeEach(() => {
    fs.rmSync(path.join(hoisted.TEST_HOME, '.claude'), { recursive: true, force: true })
  })

  afterEach(() => {
    fs.rmSync(path.join(hoisted.TEST_HOME, '.claude'), { recursive: true, force: true })
  })

  describe('loadCleanupPeriodDays', () => {
    it('returns undefined when the file does not exist', () => {
      expect(loadCleanupPeriodDays()).toBeUndefined()
    })

    it('returns undefined when the key is absent', () => {
      writeSettings({ verbose: true })
      expect(loadCleanupPeriodDays()).toBeUndefined()
    })

    it('returns the stored numeric value', () => {
      writeSettings({ cleanupPeriodDays: 90 })
      expect(loadCleanupPeriodDays()).toBe(90)
    })

    it('returns undefined for a non-numeric value', () => {
      writeSettings({ cleanupPeriodDays: 'forever' })
      expect(loadCleanupPeriodDays()).toBeUndefined()
    })
  })

  describe('saveCleanupPeriodDays', () => {
    it('creates the file and writes the value', () => {
      saveCleanupPeriodDays(3650)
      expect(readSettings().cleanupPeriodDays).toBe(3650)
    })

    it('clamps values below 1 up to the upstream minimum', () => {
      // Upstream schema requires >= 1; the UI uses a large window (not 0) for
      // "never", so we never persist 0.
      saveCleanupPeriodDays(0)
      expect(readSettings().cleanupPeriodDays).toBe(1)
      saveCleanupPeriodDays(-5)
      expect(readSettings().cleanupPeriodDays).toBe(1)
    })

    it('rounds fractional days to an integer', () => {
      saveCleanupPeriodDays(30.7)
      expect(readSettings().cleanupPeriodDays).toBe(31)
    })

    it('preserves other top-level keys', () => {
      writeSettings({ verbose: true, permissions: { allow: ['Bash(ls:*)'] } })
      saveCleanupPeriodDays(45)
      const data = readSettings()
      expect(data.cleanupPeriodDays).toBe(45)
      expect(data.verbose).toBe(true)
      expect(data.permissions).toEqual({ allow: ['Bash(ls:*)'] })
    })

    it('round-trips through load', () => {
      saveCleanupPeriodDays(120)
      expect(loadCleanupPeriodDays()).toBe(120)
    })
  })
})
