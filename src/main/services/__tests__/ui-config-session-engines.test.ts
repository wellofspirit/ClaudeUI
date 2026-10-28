/**
 * @vitest-environment node
 *
 * H15 guard — saveSessionConfig must never wipe the DB session_meta map from an
 * impoverished (empty / missing) sessionEngines payload. A remote/web client's
 * snapshot didn't carry sessionEngines, so its saves round-tripped `{}` and the
 * old unconditional delete-loop erased every session's engine/model mapping,
 * reopening all opencode/pi sessions as Claude.
 *
 * DB + sessions.json are isolated per test via an os.homedir() redirect to temp.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import type { ModelRef } from '../../../shared/types'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'uiconfig-se-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

const OPENCODE_MODEL: ModelRef = { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-5' }

async function fresh(): Promise<{
  db: typeof import('../../../core/services/db')
  ui: typeof import('../../../core/services/ui-config')
}> {
  vi.resetModules()
  // `vi.resetModules()` hands back a fresh `sqlite-driver` module too, and the
  // seam deliberately has no default engine (S3 stage 1) — so the driver the
  // setup file installed is not on THIS instance of it. Install it again, right
  // where the fresh `db` is imported: the two are one act.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const ui = await import('../../../core/services/ui-config')
  return { db, ui }
}

describe('saveSessionConfig — sessionEngines durability (H15)', () => {
  it('drops a client entry naming an engine this build does not ship, and keeps the rest', async () => {
    const { db, ui } = await fresh()
    try {
      ui.saveSessionConfig({
        sessionEngines: {
          stale: { engineId: 'codex' as never },
          fresh: { engineId: 'pi' }
        }
      })
      expect(db.getSessionMeta('stale')).toBeUndefined()
      expect(db.getSessionMeta('fresh')?.engineId).toBe('pi')
    } finally {
      db.closeDb()
    }
  })
  it('an EMPTY sessionEngines map does NOT delete existing DB meta', async () => {
    const { db, ui } = await fresh()
    try {
      db.setSessionMeta('s-opencode', { engineId: 'opencode', model: OPENCODE_MODEL })
      db.setSessionMeta('s-pi', { engineId: 'pi' })
      expect(Object.keys(db.allSessionMeta()).sort()).toEqual(['s-opencode', 's-pi'])

      // Web/remote impoverished save: full config but empty engine map.
      ui.saveSessionConfig({ recentSessions: ['s-opencode'], sessionEngines: {} })

      const after = db.allSessionMeta()
      expect(Object.keys(after).sort()).toEqual(['s-opencode', 's-pi'])
      expect(after['s-opencode'].engineId).toBe('opencode')
      expect(after['s-pi'].engineId).toBe('pi')
    } finally {
      db.closeDb()
    }
  })

  it('a payload MISSING sessionEngines leaves DB meta intact', async () => {
    const { db, ui } = await fresh()
    try {
      db.setSessionMeta('s-opencode', { engineId: 'opencode', model: OPENCODE_MODEL })
      ui.saveSessionConfig({ pinnedSessions: ['whatever'] })
      expect(Object.keys(db.allSessionMeta())).toEqual(['s-opencode'])
    } finally {
      db.closeDb()
    }
  })

  it('a NON-EMPTY map lacking a session KEEPS its row (a snapshot is not the registry)', async () => {
    const { db, ui } = await fresh()
    try {
      // A session another client / core created: the saving client's snapshot
      // predates it, so its map names other sessions and not this one.
      db.setSessionMeta('remote-pi', { engineId: 'pi' })
      db.setSessionMeta('real-1', { engineId: 'opencode', model: OPENCODE_MODEL })

      ui.saveSessionConfig({
        sessionEngines: { 'real-1': { engineId: 'opencode', model: OPENCODE_MODEL } }
      })

      expect(Object.keys(db.allSessionMeta()).sort()).toEqual(['real-1', 'remote-pi'])
      expect(db.getSessionMeta('remote-pi')?.engineId).toBe('pi')
    } finally {
      db.closeDb()
    }
  })

  describe('sessions.json is merged per key, not replaced', () => {
    const SESSIONS_FILE = (): string => nodePath.join(TEMP_HOME, '.claude', 'ui', 'sessions.json')
    const onDisk = (): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf-8'))

    it('a payload carrying only sessionEngines keeps every other stored key', async () => {
      const { db, ui } = await fresh()
      try {
        // What the history loader sends: `{ sessionEngines }` and nothing else.
        fs.writeFileSync(
          SESSIONS_FILE(),
          JSON.stringify({
            recentSessions: ['a', 'b'],
            pinnedSessions: ['a'],
            customTitles: { a: 'Title' },
            worktreeInfoMap: { b: { path: '/wt' } },
            hiddenSessions: ['c'],
            hiddenProjects: ['p']
          })
        )

        ui.saveSessionConfig({ sessionEngines: { a: { engineId: 'pi' } } })

        expect(onDisk()).toEqual({
          recentSessions: ['a', 'b'],
          pinnedSessions: ['a'],
          customTitles: { a: 'Title' },
          worktreeInfoMap: { b: { path: '/wt' } },
          hiddenSessions: ['c'],
          hiddenProjects: ['p']
        })
        expect(db.getSessionMeta('a')?.engineId).toBe('pi')
      } finally {
        db.closeDb()
      }
    })

    it('a key the payload does carry replaces the stored one (including an emptied list)', async () => {
      const { db, ui } = await fresh()
      try {
        fs.writeFileSync(
          SESSIONS_FILE(),
          JSON.stringify({ recentSessions: ['a', 'b'], pinnedSessions: ['a'] })
        )

        ui.saveSessionConfig({ recentSessions: ['b'], pinnedSessions: [] })

        expect(onDisk()).toEqual({ recentSessions: ['b'], pinnedSessions: [] })
      } finally {
        db.closeDb()
      }
    })
  })
})
