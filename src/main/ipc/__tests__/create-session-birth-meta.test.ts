/**
 * @vitest-environment node
 *
 * `prepareAndCreateSession` records the session's BIRTH engine/model in the
 * persisted registry (`session_meta`) on the host, and replicates it.
 *
 * Before this, only the creating client's own save wrote the row. A session
 * created by anything else — a remote `session:create`, which has no
 * `createNewSession` behind it — had none until a model-bearing `session:status`:
 * every other
 * client rendered it as Claude, and any client's next registry save could then
 * revert it.
 *
 * Real DB (through the driver seam) + the real funnel; only the engine sessions
 * and spawn preps are stubbed. DB + sessions.json are isolated via an
 * os.homedir() redirect to temp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})
// The preps are registered by the test (below) instead of by the real engine wiring.
vi.mock('../../../core/providers/register-engines', () => ({}))
vi.mock('../../../core/services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveSessionConfig: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'create-birth-meta-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

const RID = 'rid-birth'

async function fresh(): Promise<{
  db: typeof import('../../../core/services/db')
  syncCore: typeof import('../../../core/services/sync-host').syncCore
  create: (
    extra: Partial<import('../../../core/ipc/create-session').CreateSessionArgs>
  ) => Promise<void>
}> {
  vi.resetModules()
  // The seam has no default engine and `resetModules` hands back a fresh one:
  // install the driver on THIS instance, right where the fresh `db` is imported.
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const { syncCore } = await import('../../../core/services/sync-host')
  const { spawnPrepRegistry } = await import('../../../core/providers/SpawnPrepRegistry')
  for (const id of ['claude', 'opencode', 'pi'] as const)
    spawnPrepRegistry.register(id, async (model?: string) => ({ resolvedModel: model }))
  const { prepareAndCreateSession } = await import('../../../core/ipc/create-session')
  syncCore.resetCanonicalForTests()
  const manager = { create: vi.fn(), get: () => undefined } as never
  return {
    db,
    syncCore,
    create: (extra) =>
      prepareAndCreateSession(manager, null, { routingId: RID, cwd: '/r/repo', ...extra })
  }
}

// `fresh()` re-imports the whole create-session graph; a loaded machine can pass the 5 s default.
describe('prepareAndCreateSession — birth identity', { timeout: 30_000 }, () => {
  it('records a session at once, with no model when none resolved, and replicates it', async () => {
    const { db, syncCore, create } = await fresh()
    try {
      await create({ engineId: 'pi' })

      expect(db.getSessionMeta(RID)).toEqual({ engineId: 'pi' })
      // Canonical carries it too, so every connected and late-joining client reads pi.
      expect(syncCore.getCanonicalState().sessionEngines[RID]).toEqual({ engineId: 'pi' })
      expect(syncCore.getSnapshot().sessionEngines?.[RID]).toEqual({ engineId: 'pi' })
    } finally {
      db.closeDb()
    }
  })

  it('records the resolved model for opencode, as the renderer would', async () => {
    const { db, create } = await fresh()
    try {
      await create({ engineId: 'opencode', model: 'openai/gpt-5' })

      expect(db.getSessionMeta(RID)).toEqual({
        engineId: 'opencode',
        model: { engineId: 'opencode', vendorId: 'openai', modelId: 'gpt-5' }
      })
    } finally {
      db.closeDb()
    }
  })

  it('records Claude too (every engine, not only the lazy ones)', async () => {
    const { db, create } = await fresh()
    try {
      await create({ engineId: 'claude', model: 'claude-opus-4-8' })

      expect(db.getSessionMeta(RID)?.engineId).toBe('claude')
      expect(db.getSessionMeta(RID)?.model?.modelId).toBe('claude-opus-4-8')
    } finally {
      db.closeDb()
    }
  })

  it('does not overwrite a row that is already there (a respawn after a model pick)', async () => {
    const { db, create } = await fresh()
    try {
      db.setSessionMeta(RID, {
        engineId: 'opencode',
        model: { engineId: 'opencode', vendorId: 'anthropic', modelId: 'picked' }
      })

      await create({ engineId: 'opencode', model: 'openai/gpt-5' })

      expect(db.getSessionMeta(RID)?.model?.modelId).toBe('picked')
    } finally {
      db.closeDb()
    }
  })
})
