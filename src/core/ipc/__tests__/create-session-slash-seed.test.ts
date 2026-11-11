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

const { loadSlashCommands, resolveClaudeSkillCatalog } = vi.hoisted(() => ({
  loadSlashCommands: vi.fn((): Array<{ name: string }> => []),
  resolveClaudeSkillCatalog: vi.fn((_cwd: string) => ({
    entries: [] as Array<{ name: string; description: string; userInvocable: boolean }>,
    skipped: []
  }))
}))

vi.mock('../../services/claude-skill-catalog', () => ({ resolveClaudeSkillCatalog }))

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
  saveSessionConfig: vi.fn(),
  loadSlashCommands
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

// Import AFTER mocks.
import { prepareAndCreateSession } from '../create-session'
import { syncCore } from '../../services/sync-host'
import type { SessionManager } from '../../services/session-manager'

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

  it("adds the new session's folder skills to the cache, the cache winning a clash", async () => {
    loadSlashCommands.mockReturnValue([{ name: '/compact' }, { name: '/deploy' }])
    resolveClaudeSkillCatalog.mockReturnValueOnce({
      entries: [
        { name: 'deploy', description: 'folder', userInvocable: true },
        { name: 'review', description: 'Review it', userInvocable: true },
        { name: 'hidden', description: 'x', userInvocable: false }
      ],
      skipped: []
    })

    await create('claude-4', 'claude')

    expect(resolveClaudeSkillCatalog).toHaveBeenCalledWith('/r/repo')
    expect(menu('claude-4')).toEqual([
      { name: '/compact' },
      { name: '/deploy' },
      { name: '/review', description: 'Review it' }
    ])
  })

  it('a failing catalog still seeds the cache', async () => {
    loadSlashCommands.mockReturnValue([{ name: '/compact' }])
    resolveClaudeSkillCatalog.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await create('claude-5', 'claude')
    expect(menu('claude-5')).toEqual([{ name: '/compact' }])
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
