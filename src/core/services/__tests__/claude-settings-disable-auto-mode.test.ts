/**
 * @vitest-environment node
 *
 * `saveClaudeDisableAutoMode`: the strict writer behind the Claude page's "Disable auto mode"
 * control. Runs against a scratch home (os.homedir() is moved), never the real ~/.claude.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')
  const realOs = require('os') as typeof import('os')
  const realPath = require('path') as typeof import('path')
  return {
    TEST_HOME: realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-disable-auto-test-'))
  }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => hoisted.TEST_HOME },
    homedir: () => hoisted.TEST_HOME
  }
})

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import {
  loadClaudePermissions,
  saveClaudeDisableAutoMode,
  saveClaudePermissions
} from '../claude-settings'

const SETTINGS_PATH = path.join(hoisted.TEST_HOME, '.claude', 'settings.json')

function writeRaw(text: string): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, text)
}
const writeSettings = (obj: unknown): void => writeRaw(JSON.stringify(obj, null, 2))
const readSettings = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))

describe('saveClaudeDisableAutoMode', () => {
  beforeEach(() => {
    fs.rmSync(path.join(hoisted.TEST_HOME, '.claude'), { recursive: true, force: true })
  })
  afterAll(() => {
    fs.rmSync(hoisted.TEST_HOME, { recursive: true, force: true })
  })

  it('on from a missing file creates it with the nested form', () => {
    saveClaudeDisableAutoMode(true)
    expect(readSettings()).toEqual({ permissions: { disableAutoMode: 'disable' } })
    expect(fs.readFileSync(SETTINGS_PATH, 'utf-8').endsWith('\n')).toBe(true)
  })

  it('on keeps every other key, top-level and inside permissions', () => {
    writeSettings({
      model: 'opus',
      env: { A: '1' },
      permissions: { allow: ['Bash(ls)'], defaultMode: 'plan' }
    })
    saveClaudeDisableAutoMode(true)
    expect(readSettings()).toEqual({
      model: 'opus',
      env: { A: '1' },
      permissions: { allow: ['Bash(ls)'], defaultMode: 'plan', disableAutoMode: 'disable' }
    })
  })

  it('off removes the nested flag and drops a permissions object left empty', () => {
    writeSettings({ model: 'opus', permissions: { disableAutoMode: 'disable' } })
    saveClaudeDisableAutoMode(false)
    expect(readSettings()).toEqual({ model: 'opus' })
  })

  it('off keeps a permissions object that still has other keys', () => {
    writeSettings({ permissions: { allow: ['Read'], disableAutoMode: 'disable' } })
    saveClaudeDisableAutoMode(false)
    expect(readSettings()).toEqual({ permissions: { allow: ['Read'] } })
  })

  it('off removes the top-level flag too, since cli.js honours either', () => {
    writeSettings({ disableAutoMode: 'disable', model: 'opus' })
    saveClaudeDisableAutoMode(false)
    expect(readSettings()).toEqual({ model: 'opus' })
    expect(loadClaudePermissions('user').disableAutoMode).toBeUndefined()
  })

  it('off with both forms present clears both', () => {
    writeSettings({ disableAutoMode: 'disable', permissions: { disableAutoMode: 'disable' } })
    saveClaudeDisableAutoMode(false)
    expect(readSettings()).toEqual({})
  })

  it('off leaves a value other than "disable" alone', () => {
    writeSettings({ disableAutoMode: 'other', permissions: { disableAutoMode: 'x' } })
    saveClaudeDisableAutoMode(false)
    expect(readSettings()).toEqual({
      disableAutoMode: 'other',
      permissions: { disableAutoMode: 'x' }
    })
  })

  it('accepts a BOM-prefixed file', () => {
    writeRaw('﻿' + JSON.stringify({ model: 'opus' }))
    saveClaudeDisableAutoMode(true)
    expect(readSettings()).toEqual({ model: 'opus', permissions: { disableAutoMode: 'disable' } })
  })

  it('accepts an empty or whitespace-only file', () => {
    writeRaw('  \n')
    saveClaudeDisableAutoMode(true)
    expect(readSettings()).toEqual({ permissions: { disableAutoMode: 'disable' } })
  })

  it.each(['{ "model": ', '[1, 2]', 'null', '"text"'])(
    'refuses %s with a readable error and leaves the file byte-identical',
    (text) => {
      writeRaw(text)
      expect(() => saveClaudeDisableAutoMode(true)).toThrow(/settings\.json is not/)
      expect(fs.readFileSync(SETTINGS_PATH, 'utf-8')).toBe(text)
    }
  )

  it('a later saveClaudePermissions keeps the flag', () => {
    saveClaudeDisableAutoMode(true)
    saveClaudePermissions('user', {
      allow: ['Bash(ls)'],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    })
    expect(readSettings()).toEqual({
      permissions: { allow: ['Bash(ls)'], disableAutoMode: 'disable' }
    })
  })
})
