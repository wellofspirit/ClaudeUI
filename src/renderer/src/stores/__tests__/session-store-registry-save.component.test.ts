/**
 * Layer 2: the registry actions in session-store save only the keys they changed.
 *
 * A save that carried the whole registry from one client's snapshot reverted anything the
 * host (a generated title, worktree info) or another client wrote a moment earlier,
 * because the host merges per key. The lost-update test runs the real
 * `session:user-message` path on a client whose snapshot is behind, against the host's
 * real per-key merge (`ui-config.saveSessionConfig` on a temp home).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'

const home = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', async () => import('@test/stubs/electron-shim'))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  // ui-config reads the home directory at import time, so it is made inside the factory.
  const fsActual = await vi.importActual<typeof import('fs')>('fs')
  const pathActual = await vi.importActual<typeof import('path')>('path')
  home.dir = fsActual.mkdtempSync(pathActual.join(actual.tmpdir(), 'registry-save-'))
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } }
})

import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { useClaudeEvents } from '../../hooks/useClaudeEvents'
import { useSessionStore } from '../session-store'
import { saveSessionConfig as hostSaveSessionConfig } from '../../../../core/services/ui-config'

const store = () => useSessionStore.getState()
let saveSpy: ReturnType<typeof vi.spyOn>

let app: TestApp

function EventHarness(): null {
  useClaudeEvents()
  return null
}

function readDisk(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(nodePath.join(home.dir, '.claude', 'ui', 'sessions.json'), 'utf8')
  )
}

beforeEach(async () => {
  fs.mkdirSync(nodePath.join(home.dir, '.claude', 'ui'), { recursive: true })
  app = await bootTestApp()
  // The host: the real per-key merge, then the echo the harness's default handler sends.
  app.bridge.ipcMain.handle('config:save-sessions', async (_e: unknown, config: any) => {
    hostSaveSessionConfig(config)
    app.emit('config:sessions-changed', config)
    return null
  })
  useSessionStore.setState({
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: []
  })
  mirrorStoreIntoReplica()
  render(createElement(EventHarness))
  saveSpy = vi.spyOn(window.api, 'saveSessionConfig')
})

afterEach(() => {
  cleanup()
  app.teardown()
  fs.rmSync(nodePath.join(home.dir, '.claude'), { recursive: true, force: true })
})

describe('lost update on a user message', () => {
  it('keeps a title the host wrote that this client has not received yet', () => {
    // The host persists a generated title; its echo has not reached this client.
    hostSaveSessionConfig({ customTitles: { s1: 'Host title' } })
    expect(store().customTitles).toEqual({})

    app.emit('session:user-message', 's1', { id: 'm1', role: 'user', content: [], timestamp: 1 })

    expect(store().recentSessionIds).toEqual(['s1'])
    expect(readDisk().customTitles).toEqual({ s1: 'Host title' })
    expect(readDisk().recentSessions).toEqual(['s1'])
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(Object.keys(saveSpy.mock.calls[0][0] as object)).toEqual(['recentSessions'])
  })

  it('sends nothing when the session is already first in recents', () => {
    store().addRecentSession('s1')
    saveSpy.mockClear()
    app.emit('session:user-message', 's1', { id: 'm1', role: 'user', content: [], timestamp: 1 })
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('sends nothing for a pinned session', () => {
    store().pinSession('s1')
    saveSpy.mockClear()
    app.emit('session:user-message', 's1', { id: 'm1', role: 'user', content: [], timestamp: 1 })
    expect(saveSpy).not.toHaveBeenCalled()
  })
})

describe('each action sends exactly its changed keys', () => {
  const keysOf = (): string[] =>
    Object.keys((saveSpy.mock.calls.at(-1)?.[0] ?? {}) as object).sort()

  beforeEach(() => {
    useSessionStore.setState({
      recentSessionIds: ['a', 'b'],
      pinnedSessionIds: ['p1', 'p2'],
      customTitles: { a: 'A' },
      hiddenSessionIds: ['h'],
      hiddenProjectKeys: ['hp']
    })
    mirrorStoreIntoReplica()
  })

  const cases: Array<[string, () => void, string[]]> = [
    ['addRecentSession', () => store().addRecentSession('b'), ['recentSessions']],
    ['removeRecentSession', () => store().removeRecentSession('a'), ['recentSessions']],
    ['setCustomTitle', () => store().setCustomTitle('b', 'B'), ['customTitles']],
    ['setCustomTitle (clear)', () => store().setCustomTitle('a', ''), ['customTitles']],
    [
      'pinSession (was recent)',
      () => store().pinSession('a'),
      ['pinnedSessions', 'recentSessions']
    ],
    ['pinSession (not recent)', () => store().pinSession('x'), ['pinnedSessions']],
    ['unpinSession', () => store().unpinSession('p1'), ['pinnedSessions', 'recentSessions']],
    [
      'reorderPinnedSessions',
      () => store().reorderPinnedSessions(['p2', 'p1']),
      ['pinnedSessions']
    ],
    ['hideSession', () => store().hideSession('s'), ['hiddenSessions']],
    ['unhideSession', () => store().unhideSession('h'), ['hiddenSessions']],
    ['hideProject', () => store().hideProject('k'), ['hiddenProjects']],
    ['unhideProject', () => store().unhideProject('hp'), ['hiddenProjects']]
  ]

  it.each(cases)('%s', (_name, act, keys) => {
    saveSpy.mockClear()
    act()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(keysOf()).toEqual(keys)
  })

  const noops: Array<[string, () => void]> = [
    ['addRecentSession (already first)', () => store().addRecentSession('a')],
    ['removeRecentSession (absent)', () => store().removeRecentSession('zzz')],
    ['setCustomTitle (same)', () => store().setCustomTitle('a', 'A')],
    ['setCustomTitle (clear unset)', () => store().setCustomTitle('zzz', '')],
    ['pinSession (already pinned)', () => store().pinSession('p1')],
    ['reorderPinnedSessions (same order)', () => store().reorderPinnedSessions(['p1', 'p2'])],
    ['hideSession (already hidden)', () => store().hideSession('h')],
    ['unhideSession (not hidden)', () => store().unhideSession('zzz')],
    ['hideProject (already hidden)', () => store().hideProject('hp')],
    ['unhideProject (not hidden)', () => store().unhideProject('zzz')]
  ]

  it.each(noops)('%s sends nothing', (_name, act) => {
    saveSpy.mockClear()
    act()
    expect(saveSpy).not.toHaveBeenCalled()
  })
})
