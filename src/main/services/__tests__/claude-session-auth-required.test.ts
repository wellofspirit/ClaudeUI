/**
 * @vitest-environment node
 *
 * Claude's half of the ONE auth-required event (ADR-068 §4, slice 3).
 *
 * cli.js surfaces a dead subscription as a synthetic assistant frame carrying a
 * top-level `error` code. The frame itself keeps going into the transcript as an
 * `api_error` block (that is the DATA, and reloaded transcripts render it the
 * same way); what slice 3 adds is that an `errorType: 'authentication'` frame
 * ALSO rings `session:auth-required { providerId: 'anthropic' }`, so the one row
 * and the one dialog serve Claude exactly as they serve ChatGPT.
 *
 * Exactly once per error, and never for a non-auth API error — a rate limit is
 * not a sign-in problem and must not offer one.
 *
 * Mock scaffold mirrors claude-session-thinking-span.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../../core/services/sync-host'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/services/ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../../../core/services/session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../../core/services/voice-capture', () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}))
vi.mock('../../../core/services/voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../../../core/services/context-window', () => ({
  getContextWindowSize: vi.fn(() => 200000)
}))
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: { fetch: vi.fn(async () => null) }
}))
vi.mock('../../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../../../core/services/claude-session'
import type { BrowserWindow } from 'electron'

// Every `makeWin()` registers a funnel subscriber; drop them per test so a long
// file does not fan every event out to hundreds of dead stubs.
afterEach(() => {
  clearSyncSubscribersForTests()
})

function makeFakeQueryHandle(
  messages: Array<Record<string, unknown>>
): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const m of messages) yield m
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
}

/**
 * A stub window that is also a CLIENT (SyncCore phase 4c).
 *
 * A session's events reach every SUBSCRIBER now, not a privileged window, so the
 * stub subscribes to the funnel and replays each delivery into `sent` — the same
 * `[channel, routingId, data]` shape every assertion below already reads.
 */
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
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  return { win, sent }
}

/** A cli.js synthetic API-error frame (the live shape: a top-level `error`). */
const apiErrorFrame = (error: string, text: string): Record<string, unknown> => ({
  type: 'assistant',
  uuid: 'u-err-1',
  error,
  message: {
    id: 'msg_err_1',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }]
  }
})

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

describe('ClaudeSession — authentication api_error rings session:auth-required', () => {
  it('emits { providerId: "anthropic" } exactly once, beside the transcript block', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([
        apiErrorFrame(
          'authentication_failed',
          'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'
        )
      ])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-auth-required', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    const authRequired = sent.filter(([c]) => c === 'session:auth-required')
    expect(authRequired).toHaveLength(1)
    // ADR-070 §1: the block's own words ride on the event too, so the row's
    // disclosure reads cli.js's text on Claude exactly as it reads the vendor's
    // on the other three engines.
    expect(authRequired[0][2]).toEqual({
      providerId: 'anthropic',
      message: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'
    })

    // And no companion `session:error` — the duplicate ADR-070 §1 forbids. Claude
    // never sent one on THIS path (its duplicate was the api_error block, which is
    // transcript DATA and stays), so this arm pins that it does not acquire one.
    expect(sent.filter(([c]) => c === 'session:error')).toEqual([])

    // The block carries the error AND the provider: `authRequired` is nulled as
    // soon as the failure settles, so a row reading the name only from the
    // session said "the credential was rejected" about Claude for the rest of
    // that transcript's life (ADR-070 §4).
    const messages = sent
      .filter(([c]) => c === 'session:message')
      .map(
        ([, , d]) =>
          d as { content: Array<{ type: string; errorType?: string; providerId?: string }> }
      )
    expect(messages.at(-1)!.content[0]).toMatchObject({
      type: 'api_error',
      errorType: 'authentication',
      providerId: 'anthropic'
    })
  })

  it('does NOT ring for a non-auth API error', async () => {
    mockQuery.mockImplementation(() =>
      makeFakeQueryHandle([apiErrorFrame('rate_limit_error', 'API Error: 429 rate limit exceeded')])
    )

    const { win, sent } = makeWin()
    const session = new ClaudeSession('routing-rate-limited', win, '/tmp/proj')
    liveSessions.push(session)
    await session.run('hello')

    expect(sent.filter(([c]) => c === 'session:auth-required')).toEqual([])

    // And the block names no provider: a rate limit is nobody's credential, so
    // the row must not start claiming Claude rejected one.
    const messages = sent
      .filter(([c]) => c === 'session:message')
      .map(([, , d]) => d as { content: Array<{ type: string; providerId?: string }> })
    expect(messages.at(-1)!.content[0]).not.toHaveProperty('providerId')
  })
})
