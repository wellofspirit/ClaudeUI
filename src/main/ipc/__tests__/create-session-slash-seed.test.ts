/**
 * @vitest-environment node
 *
 * A new Claude session's slash menu before cli.js has started (it reports its
 * commands on the first prompt): the last list a Claude session cached, seeded into
 * THAT session only. Another engine's session never gets it.
 *
 * Drives the real `prepareAndCreateSession` + reducer and reads canonical state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { loadSlashCommands } = vi.hoisted(() => ({
  loadSlashCommands: vi.fn((): Array<{ name: string }> => [])
}))

vi.mock('../../../core/services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../../core/opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../../core/pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../../../core/providers/claude-spawn-prep', () => ({
  claudeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/opencode/opencode-spawn-prep', () => ({
  opencodeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/pi/pi-spawn-prep', () => ({
  piSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/services/claude-settings', () => ({ saveCleanupPeriodDays: vi.fn() }))
vi.mock('../../../core/services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveSessionConfig: vi.fn(),
  loadSlashCommands
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), stopDispatch: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: () => false
}))
vi.mock('../../../core/services/db', () => ({
  getSessionMeta: () => undefined,
  setSessionMeta: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// Import AFTER mocks.
import { prepareAndCreateSession } from '../../../core/ipc/create-session'
import { syncCore } from '../../../core/services/sync-host'
import type { SessionManager } from '../../../core/services/session-manager'

async function create(routingId: string, engineId: 'claude' | 'pi'): Promise<void> {
  const manager = { create: vi.fn(), get: () => undefined } as unknown as SessionManager
  await prepareAndCreateSession(manager, null, { routingId, cwd: '/r/repo', engineId })
}

const menu = (id: string): unknown => syncCore.getCanonicalState().sessions[id].slashCommands

afterEach(() => {
  syncCore.resetCanonicalForTests()
  vi.clearAllMocks()
})

describe('pre-spawn slash menu', () => {
  it('seeds a new Claude session from the cache, and only that session', async () => {
    loadSlashCommands.mockReturnValue([{ name: '/compact' }, { name: '/deploy' }])

    await create('claude-1', 'claude')
    await create('pi-1', 'pi')

    expect(menu('claude-1')).toEqual([{ name: '/compact' }, { name: '/deploy' }])
    expect(menu('pi-1')).toEqual([])
  })

  it('an empty or unreadable cache leaves the menu empty without failing the create', async () => {
    loadSlashCommands.mockReturnValueOnce([])
    await create('claude-2', 'claude')
    expect(menu('claude-2')).toEqual([])

    loadSlashCommands.mockImplementationOnce(() => {
      throw new Error('corrupt cache')
    })
    await create('claude-3', 'claude')
    expect(menu('claude-3')).toEqual([])
  })
})
