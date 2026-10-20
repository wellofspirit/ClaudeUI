/**
 * @vitest-environment node
 *
 * `ClaudeSession.nestedTaskIds` holds a subagent-launched task only until it reports
 * (ADR-105 §2). Mock scaffold mirrors `claude-session-handback.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

const { mockQuery, collab } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  collab: { ctx: null as null | { getMessages: () => ChatMessage[] } }
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
// Dispatch available, so the session hands its live transcript to the collab
// server — the same `getMessages` a dispatched target's judge reads (ADR-088).
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => true
}))
vi.mock('../collab-tool', () => ({
  createCollabServer: vi.fn((ctx: { getMessages: () => ChatMessage[] }) => {
    collab.ctx = ctx
    return { type: 'sdk', name: 'claude-ui-collab' }
  })
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
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({ usageFetcher: { fetch: vi.fn(async () => null) } }))
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

function makeWin(): BrowserWindow {
  const win = {
    isDestroyed: () => false,
    webContents: { send: (): void => {} }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  return win
}

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
  collab.ctx = null
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
})

const started = (taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  task_type: 'local_agent',
  description: 'scan',
  is_backgrounded: true,
  ...extra
})
const ended = (taskId: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_notification',
  uuid: `sys-${taskId}`,
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  status: 'completed',
  output_file: '',
  summary: 'pointer',
  handback: 'send',
  handback_report: { text: 'report' }
})

describe('ClaudeSession.nestedTaskIds', () => {
  it('a nested task is forgotten when it reports; one still open is kept', async () => {
    const wire = [
      started('nested-1', { parent_task_id: 'a-parent' }),
      started('nested-2', { spawn_depth: 2 }),
      started('open-nested', { parent_task_id: 'a-parent' }),
      started('plain-1'),
      ended('nested-1'),
      ended('nested-2'),
      ended('plain-1')
    ]
    mockQuery.mockImplementation(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        for (const m of wire) yield m
      },
      initializationResult: (): Promise<never> => new Promise<never>(() => {}),
      interrupt: vi.fn(async () => {})
    }))
    const session = new ClaudeSession('rid-nested-prune', makeWin(), '/tmp/proj', {})
    liveSessions.push(session)
    await session.run('go')
    const ids = (session as unknown as { nestedTaskIds: Set<string> }).nestedTaskIds
    expect([...ids]).toEqual(['open-nested'])
  })
})
