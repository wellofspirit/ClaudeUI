/**
 * @vitest-environment node
 *
 * A session’s ref follows its rekey (slice 1b), through the real funnel and the
 * real `SessionManager`: the stored ref row takes the engine’s session id, a link
 * still `starting` goes live, and the replicated ref map moves with the session —
 * all from the one `session:status` that carries the engine’s id, with no client
 * involved. DB isolated via an os.homedir() redirect to temp, as the engine-row
 * rekey test does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import type { SessionStatus } from '../../../shared/types'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})
vi.mock('../../../core/services/session-history', () => ({
  loadSessionHistory: vi.fn(async () => ({ messages: [] }))
}))
vi.mock('../../../core/providers/register-engines', () => ({}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ref-rekey-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

function status(sessionId: string): SessionStatus {
  return {
    state: 'running',
    sessionId,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'pi',
    account: null
  } as SessionStatus
}

async function fresh(): Promise<{
  db: typeof import('../../../core/services/db')
  links: typeof import('../../../core/services/session-links')
  manager: InstanceType<typeof import('../../../core/services/session-manager').SessionManager>
  emitEvent: typeof import('../../../core/services/sync-host').emitEvent
  syncCore: typeof import('../../../core/services/sync-host').syncCore
}> {
  vi.resetModules()
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const links = await import('../../../core/services/session-links')
  const { SessionManager } = await import('../../../core/services/session-manager')
  const { emitEvent, syncCore } = await import('../../../core/services/sync-host')
  syncCore.resetCanonicalForTests()
  const manager = new SessionManager()
  // Live session objects under the temporary ids, without spawning an engine.
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.set('parent-1', { routingId: 'parent-1' })
  sessions.set('temp-1', { routingId: 'temp-1' })
  return { db, links, manager, emitEvent, syncCore }
}

// `fresh()` re-imports the session-manager graph; a loaded machine can pass the 5 s default.
describe('a session ref follows a rekey (host-side)', { timeout: 30_000 }, () => {
  it('rebinds the stored ref, the replicated ref map and the child link to the engine id', async () => {
    const { db, links, manager, emitEvent, syncCore } = await fresh()
    try {
      emitEvent('session:created', ['parent-1', { cwd: '/x', engineId: 'pi' }])
      emitEvent('session:created', ['temp-1', { cwd: '/x', engineId: 'pi' }])
      const { childRef } = links.linkChild({
        parent: 'parent-1',
        childRoutingId: 'temp-1',
        engine: 'pi',
        kind: 'started',
        createdBy: 'agent',
        grouped: true
      })
      expect(db.getSessionLink(childRef)?.state).toBe('starting')
      expect(db.getSessionRef(childRef)).toMatchObject({ routingId: 'temp-1', sessionId: null })

      emitEvent('session:status', ['temp-1', status('thread-9')])

      expect(db.getSessionRef(childRef)).toMatchObject({
        routingId: 'thread-9',
        sessionId: 'thread-9'
      })
      expect(db.findSessionRef('temp-1')).toBeUndefined()
      expect(db.getSessionLink(childRef)?.state).toBe('live')
      const canonical = syncCore.getCanonicalState()
      expect(canonical.sessionRefs['thread-9']).toBe(childRef)
      expect(canonical.sessionRefs['temp-1']).toBeUndefined()
      expect(canonical.sessionLinks[childRef].state).toBe('live')
      expect(links.resolveRef(childRef)).toMatchObject({ ok: true, id: 'thread-9' })
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })

  it('mints nothing when the old id had no ref', async () => {
    const { db, manager, emitEvent } = await fresh()
    try {
      emitEvent('session:created', ['temp-1', { cwd: '/x' }])
      emitEvent('session:status', ['temp-1', status('thread-9')])
      expect(db.findSessionRef('thread-9')).toBeUndefined()
      expect(db.allSessionRefs()).toEqual([])
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })

  it('moves the custom title to the new id on disk, with no client saving anything', async () => {
    const { db, manager, emitEvent } = await fresh()
    try {
      const config = await import('../../../core/services/ui-config')
      // A session another session's tool started is named before its engine reports an id.
      config.saveSessionConfig({ customTitles: { 'temp-1': 'Fix the flaky test', other: 'Other' } })
      emitEvent('session:created', ['temp-1', { cwd: '/x' }])

      emitEvent('session:status', ['temp-1', status('thread-9')])

      expect(config.loadSessionConfig().customTitles).toEqual({
        'thread-9': 'Fix the flaky test',
        other: 'Other'
      })
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })

  it('keeps a title already under the new id, and does nothing for an untitled session', async () => {
    const { db, manager, emitEvent } = await fresh()
    try {
      const config = await import('../../../core/services/ui-config')
      config.saveSessionConfig({ customTitles: { 'temp-1': 'Old', 'thread-9': 'Chosen' } })
      emitEvent('session:created', ['temp-1', { cwd: '/x' }])
      emitEvent('session:status', ['temp-1', status('thread-9')])
      expect(config.loadSessionConfig().customTitles).toEqual({ 'thread-9': 'Chosen' })

      config.saveSessionConfig({ customTitles: { other: 'Other' } })
      emitEvent('session:created', ['temp-2', { cwd: '/x' }])
      ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('temp-2', {
        routingId: 'temp-2'
      })
      emitEvent('session:status', ['temp-2', status('thread-10')])
      expect(config.loadSessionConfig().customTitles).toEqual({ other: 'Other' })
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })
})
