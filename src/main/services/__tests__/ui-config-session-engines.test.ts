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
  db: typeof import('../db')
  ui: typeof import('../ui-config')
}> {
  vi.resetModules()
  const db = await import('../db')
  const ui = await import('../ui-config')
  return { db, ui }
}

describe('saveSessionConfig — sessionEngines durability (H15)', () => {
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

  it('a NON-EMPTY map still prunes entries absent from it (rekey cleanup preserved)', async () => {
    const { db, ui } = await fresh()
    try {
      db.setSessionMeta('client-old', { engineId: 'claude' })
      db.setSessionMeta('real-1', { engineId: 'opencode', model: OPENCODE_MODEL })

      // A complete (desktop) save that no longer contains the ephemeral client id.
      ui.saveSessionConfig({
        sessionEngines: { 'real-1': { engineId: 'opencode', model: OPENCODE_MODEL } }
      })

      expect(Object.keys(db.allSessionMeta())).toEqual(['real-1'])
    } finally {
      db.closeDb()
    }
  })
})
