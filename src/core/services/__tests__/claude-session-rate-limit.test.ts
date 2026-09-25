/**
 * @vitest-environment node
 *
 * The native `rate_limit_event` reaches the usage meter.
 *
 * ClaudeSession used to read only `header_utilization`, a field the retired
 * `rate-limit-relay` patch added, so on Anthropic's own binary every native
 * event was dropped and the meter moved only on the 30-minute poll. The native
 * frame carries every window under `rate_limit_info.unifiedWindows`
 * (docs/protocol-cc/03-inbound-messages.md §3.11).
 *
 * Mock scaffold mirrors `claude-session-agent-resume.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

const { mockQuery, mockUpdateWindows } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockUpdateWindows: vi.fn()
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
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
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
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitWindows: mockUpdateWindows, fetch: vi.fn(async () => null) }
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

/** Verbatim: probes/rate-limit-relay/official.three-turn.jsonl:7 (official 2.1.280). */
const NATIVE_FRAME = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1790209200,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled_until',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.77, resetsAt: 1790209200 },
      seven_day: { utilization: 0.29, resetsAt: 1790398800 }
    }
  },
  uuid: '589ef592-9a89-465a-9264-d244c510e990',
  session_id: '4352acdd-b0f1-414b-943a-12025adc465b'
}

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
})

async function runWire(routingId: string, wire: Array<Record<string, unknown>>): Promise<void> {
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const m of wire) yield m
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
  const session = new ClaudeSession(routingId, win, '/tmp/proj')
  liveSessions.push(session)
  await session.run('go')
}

describe('ClaudeSession — native rate_limit_event', () => {
  it('hands unifiedWindows to the usage fetcher', async () => {
    await runWire('routing-rate-limit', [NATIVE_FRAME])
    expect(mockUpdateWindows).toHaveBeenCalledTimes(1)
    expect(mockUpdateWindows).toHaveBeenCalledWith(NATIVE_FRAME.rate_limit_info.unifiedWindows)
  })

  it('ignores an event without windows (API-key, Bedrock and Vertex sessions)', async () => {
    await runWire('routing-rate-limit-none', [
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }
    ])
    expect(mockUpdateWindows).not.toHaveBeenCalled()
  })
})
