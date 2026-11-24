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
 * The third switch, `stopKeepsBackgroundAgents` (default ON), is not a settings
 * key: it rides the query options as `perTaskStopAffordance` (the initialize
 * capability that makes cli.js's interrupt spare running background agents), and
 * `interrupt()` follows what the process was spawned with: declared, it denies
 * only the main thread's pending approvals and leaves a subagent's card to cli.js;
 * not declared, it denies every card, as before.
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

/** Parked runs (see `startParked`) to let go of before their session is cancelled. */
const parkedRuns: Array<() => void> = []

afterEach(() => {
  for (const release of parkedRuns.splice(0)) release()
  for (const s of live.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
  vi.clearAllMocks()
})

/** Construct, run one prompt, and return the options cli.js was spawned with. */
async function spawnOptions(): Promise<Record<string, unknown>> {
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
  return options
}

/** The `settings` object cli.js was spawned with. */
async function spawnSettings(): Promise<Record<string, unknown>> {
  return (await spawnOptions()).settings as Record<string, unknown>
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

describe('ClaudeSession — perTaskStopAffordance at spawn (Stop keeps background agents)', () => {
  it('is declared by default: an absent key means ON', async () => {
    const options = await spawnOptions()
    expect(options.perTaskStopAffordance).toBe(true)
  })

  it('is not declared when engines/claude.json turns it off', async () => {
    mockLoadEngineConfig.mockReturnValue({ claudeConfig: { stopKeepsBackgroundAgents: false } })
    const options = await spawnOptions()
    expect(options.perTaskStopAffordance).toBe(false)
  })

  it('is read at every spawn, so a change binds the next session start', async () => {
    mockLoadEngineConfig.mockReturnValue({ claudeConfig: { stopKeepsBackgroundAgents: false } })
    expect((await spawnOptions()).perTaskStopAffordance).toBe(false)
    mockLoadEngineConfig.mockReturnValue({})
    expect((await spawnOptions()).perTaskStopAffordance).toBe(true)
  })
})

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseId?: string; agentId?: string }
) => Promise<{ behavior: string; message?: string }>

/**
 * A session whose cli.js run stays live (its message loop parked), so
 * `interrupt()` has an active query to act on. `sent` collects
 * `[channel, data]` for every event the session broadcast.
 */
async function startParked(): Promise<{
  session: ClaudeSession
  canUseTool: CanUseTool
  queryInterrupt: ReturnType<typeof vi.fn>
  sent: Array<[string, unknown]>
}> {
  let release!: () => void
  const parked = new Promise<void>((r) => {
    release = r
  })
  parkedRuns.push(release)
  const queryInterrupt = vi.fn(async () => {})
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      // Parked until the test lets go: the run stays live with no message.
      await parked
      yield* []
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: queryInterrupt
  }))
  const sent: Array<[string, unknown]> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, _routingId: string, data: unknown): void => {
        sent.push([channel, data])
      }
    }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  const session = new ClaudeSession('stop-spares', win, '/tmp/proj')
  live.push(session)
  void session.run('go')
  await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled())
  // Let run() reach `this.activeQuery = q` before driving interrupt().
  await new Promise<void>((r) => setTimeout(r, 0))
  const [{ options }] = mockQuery.mock.calls.at(-1) as [{ options: { canUseTool: CanUseTool } }]
  return { session, canUseTool: options.canUseTool, queryInterrupt, sent }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** One main-thread approval and one subagent approval, both left pending. */
async function twoPendingApprovals(
  canUseTool: CanUseTool,
  sent: Array<[string, unknown]>
): Promise<{
  main: { result: Promise<{ behavior: string }>; requestId: string; settled: () => boolean }
  sub: { result: Promise<{ behavior: string }>; requestId: string; settled: () => boolean }
}> {
  const track = (
    result: Promise<{ behavior: string }>
  ): { result: Promise<{ behavior: string }>; settled: () => boolean } => {
    let done = false
    void result.then(() => {
      done = true
    })
    return { result, settled: () => done }
  }
  const main = track(
    canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseId: 'tu-main' }
    )
  )
  const sub = track(
    canUseTool(
      'Bash',
      { command: 'pwd' },
      { signal: new AbortController().signal, toolUseId: 'tu-sub', agentId: 'agent-1' }
    )
  )
  await tick()
  const requests = sent
    .filter(([c]) => c === 'session:approval-request')
    .map(([, d]) => d as { requestId: string; toolUseId: string })
  const idOf = (toolUseId: string): string =>
    requests.find((r) => r.toolUseId === toolUseId)!.requestId
  return {
    main: { ...main, requestId: idOf('tu-main') },
    sub: { ...sub, requestId: idOf('tu-sub') }
  }
}

const dismissed = (sent: Array<[string, unknown]>): string[] =>
  sent
    .filter(([c]) => c === 'session:approval-dismiss')
    .map(([, d]) => (d as { requestId: string }).requestId)

describe('ClaudeSession.interrupt() — which pending approvals a Stop denies', () => {
  it('with the affordance: denies and dismisses the main thread’s card, leaves a subagent’s', async () => {
    const { session, canUseTool, queryInterrupt, sent } = await startParked()
    const { main, sub } = await twoPendingApprovals(canUseTool, sent)

    await session.interrupt()
    await tick()

    expect(queryInterrupt).toHaveBeenCalledTimes(1)
    expect(await main.result).toMatchObject({ behavior: 'deny' })
    expect(dismissed(sent)).toContain(main.requestId)
    // The subagent's card is cli.js's to cancel (its agent may be a background
    // one the Stop spared): still pending, still answerable.
    expect(sub.settled()).toBe(false)
    expect(dismissed(sent)).not.toContain(sub.requestId)
    session.resolveApproval(sub.requestId, 'allow')
    expect(await sub.result).toMatchObject({ behavior: 'allow' })
  })

  it('without the affordance: denies and dismisses every card, as before', async () => {
    mockLoadEngineConfig.mockReturnValue({ claudeConfig: { stopKeepsBackgroundAgents: false } })
    const { session, canUseTool, queryInterrupt, sent } = await startParked()
    const { main, sub } = await twoPendingApprovals(canUseTool, sent)

    await session.interrupt()

    expect(queryInterrupt).toHaveBeenCalledTimes(1)
    expect(await main.result).toMatchObject({ behavior: 'deny' })
    expect(await sub.result).toMatchObject({ behavior: 'deny' })
    expect(dismissed(sent)).toEqual(expect.arrayContaining([main.requestId, sub.requestId]))
  })

  it('follows what the process was spawned with, not a setting changed since', async () => {
    const { session, canUseTool, sent } = await startParked()
    const { sub } = await twoPendingApprovals(canUseTool, sent)
    // Turned off after this process declared the affordance: cli.js still spares.
    mockLoadEngineConfig.mockReturnValue({ claudeConfig: { stopKeepsBackgroundAgents: false } })

    await session.interrupt()
    await tick()

    expect(sub.settled()).toBe(false)
  })
})
