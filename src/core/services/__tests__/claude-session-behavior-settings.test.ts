/**
 * @vitest-environment node
 *
 * The `--settings` flag settings a Claude session spawns with carry the Claude
 * engine's two behaviour switches (engines/claude.json `claudeConfig`), read
 * fresh at spawn time so a change binds the next session start:
 *
 *  - `idleCompaction` — cli.js's 200K+ idle-conversation summariser
 *    (`claude-desktop` entrypoint). ClaudeUI's default is OFF; cli.js's own
 *    default is ON, so without this the app would compact behind the user.
 *  - `enabledPlugins["cc-plugin-privacy@builtin"]` — the built-in email-address
 *    privacy check. ClaudeUI states it explicitly (default ON) so the toggle is
 *    ClaudeUI's and not whatever ~/.claude/settings.json says.
 *
 * Mock scaffold mirrors `claude-session-resume-missing.test.ts`; `loadEngineConfig`
 * is the module mock the spawn-time read goes through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

const { mockQuery, mockLoadEngineConfig } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLoadEngineConfig: vi.fn(() => ({}))
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})
vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    setServerStartedHook: () => {},
    isBinaryAvailable: (): boolean => false
  }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: mockLoadEngineConfig
}))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 }))
}))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../../../main/services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../../main/auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'

const live: ClaudeSession[] = []

beforeEach(() => {
  mockLoadEngineConfig.mockReturnValue({})
})

afterEach(() => {
  for (const s of live.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
  vi.clearAllMocks()
})

/** Construct, run one prompt, and return the `settings` object cli.js was spawned with. */
async function spawnSettings(): Promise<Record<string, unknown>> {
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      yield* []
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }))
  const win = {
    isDestroyed: () => false,
    webContents: { send: (): void => {} }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  const session = new ClaudeSession('behavior', win, '/tmp/proj')
  live.push(session)
  await session.run('go')
  expect(mockQuery).toHaveBeenCalled()
  // The most recent spawn (the third test spawns twice in one test).
  const [{ options }] = mockQuery.mock.calls.at(-1) as [{ options: Record<string, unknown> }]
  return options.settings as Record<string, unknown>
}

describe('ClaudeSession — behaviour switches in the spawn `settings`', () => {
  it('compaction OFF and the privacy check ON by default, beside the UI allow rules', async () => {
    const settings = await spawnSettings()
    expect(settings.idleCompaction).toBe(false)
    expect(settings.enabledPlugins).toEqual({ 'cc-plugin-privacy@builtin': true })
    // The existing permissions object is untouched by the merge.
    expect(settings.permissions).toEqual({
      allow: ['Edit(/tmp/proj/.claude/ui/**)', 'Write(/tmp/proj/.claude/ui/**)']
    })
  })

  it('flipped values when engines/claude.json says so — read at spawn time', async () => {
    mockLoadEngineConfig.mockReturnValue({
      claudeConfig: { defaultModel: 'sonnet', idleCompaction: true, privacyEmailCheck: false }
    })
    const settings = await spawnSettings()
    expect(settings.idleCompaction).toBe(true)
    expect(settings.enabledPlugins).toEqual({ 'cc-plugin-privacy@builtin': false })
  })

  it('reads the claude engine config at every spawn, so the next session start picks up a change', async () => {
    await spawnSettings()
    expect(mockLoadEngineConfig).toHaveBeenCalledWith('claude')
    mockLoadEngineConfig.mockReturnValue({ claudeConfig: { idleCompaction: true } })
    const settings = await spawnSettings()
    expect(settings.idleCompaction).toBe(true)
  })
})
