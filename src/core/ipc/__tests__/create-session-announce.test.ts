/**
 * @vitest-environment node
 *
 * `session:created` announces the effort / thinking mode the spawning client
 * hands every replica as the session's OWN (`announce`).
 *
 * Canonical `effort` is null only before a session's first spawn; at spawn the
 * resolved starting effort freezes into the session, so a later change to the
 * per-model starting effort cannot re-label one already running. A Claude/opencode
 * pick (a local write plus a respawn) and a pre-spawn session have no setter that
 * emits `session:config-changed`, so the birth event is the one place either
 * replicates.
 *
 * Drives the real `prepareAndCreateSession` + reducer and reads canonical state;
 * only the engine sessions and spawn preps are stubbed.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'

const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'create-announce-picks-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('../../services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../../providers/claude-spawn-prep', () => ({
  claudeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../opencode/opencode-spawn-prep', () => ({
  opencodeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../pi/pi-spawn-prep', () => ({
  piSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../services/claude-settings', () => ({ saveCleanupPeriodDays: vi.fn() }))
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveSessionConfig: vi.fn()
}))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), stopDispatch: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: () => false
}))
vi.mock('../../services/db', () => ({
  getSessionMeta: () => undefined,
  setSessionMeta: vi.fn()
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../services/sync-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sync-host')>()
  return { ...actual, emitEvent: vi.fn(actual.emitEvent) }
})

// Import AFTER mocks.
import { prepareAndCreateSession, type CreateSessionArgs } from '../create-session'
import { emitEvent, syncCore } from '../../services/sync-host'
import type { SessionManager } from '../../services/session-manager'

const RID = 'rid-announce'

function create(extra: Partial<CreateSessionArgs>): {
  done: Promise<void>
  manager: SessionManager
} {
  const manager = { create: vi.fn(), get: () => undefined } as unknown as SessionManager
  return {
    manager,
    // The RESOLVED spawn effort is always sent, as the renderer does.
    done: prepareAndCreateSession(manager, null, {
      routingId: RID,
      cwd: '/r/repo',
      engineId: 'claude',
      ...extra,
      config: { effort: 'medium', thinkingMode: 'adaptive', ...extra.config }
    })
  }
}

const canonical = (): { effort: string | null; thinkingMode: string | null } => {
  const s = syncCore.getCanonicalState().sessions[RID]
  return { effort: s.effort, thinkingMode: s.thinkingMode }
}

afterEach(() => {
  syncCore.resetCanonicalForTests()
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(TEMP_HOME, { recursive: true, force: true })
})

describe('session:created announce', () => {
  it('announces the POSITIONAL spawn effort (what the process runs) and the raw thinking mode', async () => {
    // The host takes the effort from the spawn arg, not from what the client put
    // in `announce`: 'low' says "announce the effort", 'medium' is what spawns.
    await create({ announce: { effort: 'low', thinkingMode: 'disabled' } }).done
    expect(canonical()).toEqual({ effort: 'medium', thinkingMode: 'disabled' })
  })

  it('announces the positional effort even when announce names a different rung (GUARD)', async () => {
    await create({ config: { effort: 'high' }, announce: { effort: 'low', thinkingMode: null } })
      .done
    expect(canonical().effort).toBe('high')
  })

  it('announces null when announce.effort is null (a model that takes no effort)', async () => {
    await create({ announce: { effort: null, thinkingMode: null } }).done
    expect(canonical()).toEqual({ effort: null, thinkingMode: null })
  })

  it('announces null when the host has no positional effort to stand behind', async () => {
    await create({
      config: { effort: undefined },
      announce: { effort: 'high', thinkingMode: null }
    }).done
    expect(canonical().effort).toBeNull()
  })

  it('an announce with null fields CLEARS what canonical holds (GUARD)', async () => {
    await create({ announce: { effort: 'high', thinkingMode: 'disabled' } }).done
    await create({ announce: { effort: null, thinkingMode: null } }).done
    expect(canonical()).toEqual({ effort: null, thinkingMode: null })
  })

  describe('an UNKNOWN model (client sent no effort) announces no effort at all', () => {
    // The client's catalog is empty / failed / curated: it knows nothing about the
    // model, and a `null` here would CLEAR a pick the process is still running at.
    const held = async (): Promise<void> => {
      await create({ config: { effort: 'high' }, announce: { effort: 'high', thinkingMode: null } })
        .done
      expect(canonical().effort).toBe('high')
    }

    it('announce.effort undefined leaves canonical effort alone (GUARD)', async () => {
      await held()
      await create({
        config: { effort: 'low' },
        announce: { effort: undefined, thinkingMode: null }
      }).done
      expect(canonical().effort).toBe('high')
    })

    it('an announce object lacking the key leaves it alone (GUARD)', async () => {
      await held()
      await create({ config: { effort: 'low' }, announce: { thinkingMode: 'disabled' } }).done
      expect(canonical()).toEqual({ effort: 'high', thinkingMode: 'disabled' })
    })

    it('a WS-shaped JSON roundtrip of the same (the undefined key is dropped) leaves it alone (GUARD)', async () => {
      await held()
      const wire = JSON.parse(JSON.stringify({ effort: undefined, thinkingMode: null }))
      expect('effort' in wire).toBe(false)
      await create({ config: { effort: 'low' }, announce: wire }).done
      expect(canonical().effort).toBe('high')
    })

    it('thinkingMode is still announced alongside the omitted effort', async () => {
      await create({ announce: { effort: undefined, thinkingMode: 'enabled' } }).done
      expect(canonical()).toEqual({ effort: null, thinkingMode: 'enabled' })
    })
  })

  it('an old client that omits `announce` carries neither field and leaves canonical alone', async () => {
    await create({ announce: { effort: 'high', thinkingMode: 'enabled' } }).done
    const before = canonical()
    await create({}).done
    expect(canonical()).toEqual(before)
    // And on a fresh session: nothing announced, so nothing set.
    syncCore.resetCanonicalForTests()
    await create({}).done
    expect(canonical()).toEqual({ effort: null, thinkingMode: null })
  })

  it('a WS client sending `announce: null` is an old client too', async () => {
    await create({ announce: null as unknown as undefined }).done
    expect(canonical()).toEqual({ effort: null, thinkingMode: null })
  })

  it('still spawns with the resolved spawn args', async () => {
    const { manager, done } = create({ announce: { effort: 'high', thinkingMode: null } })
    await done
    const spawn = (manager.create as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(spawn[3]).toMatchObject({ effort: 'medium', thinkingMode: 'adaptive' })
  })
})

describe('a spawn config that carries a reasoning variant', () => {
  const configChanged = (): unknown[] =>
    vi
      .mocked(emitEvent)
      .mock.calls.filter(([channel]) => channel === 'session:config-changed')
      .map(([, args]) => args)

  it('tells every client the way a live change does', async () => {
    await create({ config: { reasoningVariant: 'high' } }).done
    expect(configChanged()).toEqual([[RID, { reasoningVariant: 'high' }]])
  })

  it('emits nothing when the config has none', async () => {
    await create({}).done
    expect(configChanged()).toEqual([])
  })
})
