/**
 * @vitest-environment node
 *
 * The persisted engine/model row follows a rekey on the HOST.
 *
 * It used to move only as a side effect of a CLIENT's full-map `saveSessionConfig`
 * (the renamed map lacked the old id, so the host's delete-absent loop dropped the
 * row). That loop is gone — a client's map is a snapshot, not the registry — so the
 * rekey itself (core's `syncCore.onRekey` → `SessionManager.rekey`) moves the row.
 *
 * Drives the real funnel + the real DB (through the driver seam); no client save is
 * made anywhere in this file. DB + sessions.json are isolated via an os.homedir()
 * redirect to temp.
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
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'meta-rekey-'))
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
    engineId: 'codex',
    account: null
  } as SessionStatus
}

async function fresh(): Promise<{
  db: typeof import('../../../core/services/db')
  manager: InstanceType<typeof import('../../../core/services/session-manager').SessionManager>
  emitEvent: typeof import('../../../core/services/sync-host').emitEvent
}> {
  vi.resetModules()
  // The seam has no default engine and `resetModules` hands back a fresh one:
  // install the driver on THIS instance, right where the fresh `db` is imported.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const { SessionManager } = await import('../../../core/services/session-manager')
  const { emitEvent, syncCore } = await import('../../../core/services/sync-host')
  syncCore.resetCanonicalForTests()
  const manager = new SessionManager()
  // Inject a session object under the temp id without spawning an engine.
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('temp-1', {
    routingId: 'temp-1'
  })
  return { db, manager, emitEvent }
}

// `fresh()` re-imports the session-manager graph; a loaded machine can pass the 5 s default.
describe('engine row follows a rekey (host-side, no client save)', { timeout: 30_000 }, () => {
  it('moves the row from the temporary routing id to the engine session id', async () => {
    const { db, manager, emitEvent } = await fresh()
    try {
      db.setSessionMeta('temp-1', {
        engineId: 'codex',
        model: { engineId: 'codex', vendorId: 'openai', modelId: 'gpt-5' }
      })
      emitEvent('session:created', ['temp-1', { cwd: '/x' }])

      emitEvent('session:status', ['temp-1', status('thread-9')])

      expect(db.getSessionMeta('temp-1')).toBeUndefined()
      expect(db.getSessionMeta('thread-9')?.engineId).toBe('codex')
      expect(db.getSessionMeta('thread-9')?.model?.modelId).toBe('gpt-5')
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })

  it('keeps the row the engine already wrote under its stable id', async () => {
    const { db, manager, emitEvent } = await fresh()
    try {
      db.setSessionMeta('temp-1', { engineId: 'codex' })
      db.setSessionMeta('thread-9', {
        engineId: 'codex',
        model: { engineId: 'codex', vendorId: 'openai', modelId: 'gpt-real' }
      })
      emitEvent('session:created', ['temp-1', { cwd: '/x' }])

      emitEvent('session:status', ['temp-1', status('thread-9')])

      expect(db.getSessionMeta('temp-1')).toBeUndefined()
      expect(db.getSessionMeta('thread-9')?.model?.modelId).toBe('gpt-real')
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })

  it('mints nothing when the old id had no row', async () => {
    const { db, manager, emitEvent } = await fresh()
    try {
      emitEvent('session:created', ['temp-1', { cwd: '/x' }])

      emitEvent('session:status', ['temp-1', status('thread-9')])

      expect(db.allSessionMeta()).toEqual({})
    } finally {
      manager.disposeRekeyObserver()
      db.closeDb()
    }
  })
})
