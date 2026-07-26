/**
 * @vitest-environment node
 *
 * Guard tests for resume seeding (Slice A fix 2): a ClaudeSession constructed
 * with a resumeSessionId must seed its in-memory accumulators from the resume
 * target's transcript (via the shared reconcile path) at construction, so the
 * turn-start status-line emission never publishes zeros over the renderer's
 * history-loaded statusLine — the "backwards jump at prompt-send" regression.
 *
 * Pre-fix behavior these tests guard against: no computeTokenMetrics call at
 * construction, so the first `session:status-line` after run() carried
 * all-zero accumulators for resumed sessions.
 *
 * Mock scaffold mirrors claude-session-collab-gating.component.test.ts —
 * everything touching disk/processes is stubbed; only construction is driven.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StatusLineData } from '../../../shared/types'

const { mockComputeTokenMetrics } = vi.hoisted(() => ({
  mockComputeTokenMetrics: vi.fn()
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: vi.fn(),
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({ saveSlashCommands: vi.fn(), loadEngineConfig: vi.fn(() => ({})) }))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: mockComputeTokenMetrics,
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))
vi.mock('../auto-classifier', () => ({
  getClassifier: vi.fn(),
  stopClassifier: vi.fn(),
  isSafeTool: vi.fn(() => false),
  buildTranscript: vi.fn(() => '')
}))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'

function makeWin(): { win: BrowserWindow; sent: Array<[string, string, unknown]> } {
  const sent: Array<[string, string, unknown]> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, routingId: string, data: unknown): void => {
        sent.push([channel, routingId, data])
      }
    }
  } as unknown as BrowserWindow
  return { win, sent }
}

/** Flush the async reconcile (computeTokenMetrics promise + .then chain). */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const FIXTURE_METRICS: StatusLineData = {
  totalCostUsd: 0.42,
  totalDurationMs: 123_000,
  totalApiDurationMs: 0,
  totalInputTokens: 100,
  totalOutputTokens: 200,
  cachedTokens: 300,
  totalTokens: 600,
  contextWindowSize: 5_000,
  usedPercentage: 3,
  remainingPercentage: 97
}

beforeEach(() => {
  vi.clearAllMocks()
  mockComputeTokenMetrics.mockResolvedValue(FIXTURE_METRICS)
})

describe('ClaudeSession — resume seeding of accumulators', () => {
  it('seeds from the resume transcript at construction and emits the seeded status line', async () => {
    const { win, sent } = makeWin()
    new ClaudeSession('routing-seed', win, '/tmp/proj', { resumeSessionId: 'sess-123' })
    await tick()

    // Reconcile ran once, against the resume target's transcript path
    // (projectKey derivation: cwd with / and . replaced by -).
    expect(mockComputeTokenMetrics).toHaveBeenCalledTimes(1)
    const calledPath = String(mockComputeTokenMetrics.mock.calls[0][0])
    expect(calledPath).toContain('sess-123.jsonl')
    expect(calledPath).toContain('-tmp-proj')

    // The seeded accumulators reached the renderer as a status line — no
    // all-zero emission can now clobber the history-loaded values.
    const statusLines = sent.filter(([c]) => c === 'session:status-line')
    expect(statusLines.length).toBeGreaterThan(0)
    const data = statusLines[statusLines.length - 1][2] as StatusLineData
    expect(data.totalDurationMs).toBe(123_000)
    expect(data.totalInputTokens).toBe(100)
    expect(data.totalOutputTokens).toBe(200)
    expect(data.cachedTokens).toBe(300)
    expect(data.contextWindowSize).toBe(5_000)
    // No turn in flight at construction.
    expect(data.turnStartedAtMs).toBeNull()
  })

  it('derives the on-disk projectKey from a WINDOWS cwd (drive colon + backslashes → -)', async () => {
    // Real disk layout: cwd D:\WorkPlace\ClaudeUI → projects/D--WorkPlace-ClaudeUI.
    // The pre-fix derivation only replaced / and ., producing a nonexistent
    // path for every Windows cwd — the seed (and all reconciliation) silently
    // no-opped on Windows while POSIX cwds worked.
    const { win } = makeWin()
    new ClaudeSession('routing-win', win, 'D:\\Work\\Proj', { resumeSessionId: 'sess-win' })
    await tick()

    expect(mockComputeTokenMetrics).toHaveBeenCalledTimes(1)
    const calledPath = String(mockComputeTokenMetrics.mock.calls[0][0])
    expect(calledPath).toContain('sess-win.jsonl')
    expect(calledPath).toContain('D--Work-Proj')
  })

  it('does not seed a fresh (non-resume) session', async () => {
    const { win } = makeWin()
    new ClaudeSession('routing-fresh', win, '/tmp/proj')
    await tick()
    expect(mockComputeTokenMetrics).not.toHaveBeenCalled()
  })

  it('does not seed a fork — the source transcript over-counts past the anchor', async () => {
    const { win } = makeWin()
    new ClaudeSession('routing-fork', win, '/tmp/proj', {
      resumeSessionId: 'sess-src',
      resumeSessionAt: 'uuid-anchor',
      forkSession: true
    })
    await tick()
    expect(mockComputeTokenMetrics).not.toHaveBeenCalled()
  })

  it('skips seeding when the transcript yields nothing (empty metrics)', async () => {
    mockComputeTokenMetrics.mockResolvedValue({
      ...FIXTURE_METRICS,
      totalCostUsd: 0,
      totalTokens: 0
    })
    const { win, sent } = makeWin()
    new ClaudeSession('routing-empty', win, '/tmp/proj', { resumeSessionId: 'sess-gone' })
    await tick()
    // Reconcile was attempted but bailed on the emptiness guard — no
    // status-line emission from the seed path.
    expect(mockComputeTokenMetrics).toHaveBeenCalledTimes(1)
    expect(sent.filter(([c]) => c === 'session:status-line')).toHaveLength(0)
  })
})
