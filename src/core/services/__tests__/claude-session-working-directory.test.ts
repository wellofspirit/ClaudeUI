/**
 * @vitest-environment node
 *
 * The collab (dispatch_agent) server a ClaudeSession builds reads the session's working directory
 * LIVE: the worktree its canonical `worktreeInfoMap` entry names while that directory exists, else
 * its spawn cwd. Mock scaffold mirrors `claude-session-handback.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeInfo } from '../../../shared/types'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests, emitEvent } from '../sync-host'

const { mockQuery, collab } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  collab: { ctx: null as null | { cwd: string; getWorkingDirectory?: () => string } }
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
  createCollabServer: vi.fn((ctx: { cwd: string; getWorkingDirectory?: () => string }) => {
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

const info = (worktreePath: string): WorktreeInfo => ({
  worktreePath,
  worktreeBranch: 'b',
  worktreeName: 'wt',
  originalCwd: '/tmp/proj',
  gitRoot: '/tmp/proj',
  originalHeadCommit: '',
  createdAt: 1,
  origin: 'detected'
})

let session: ClaudeSession | null = null
let base: string

beforeEach(() => {
  vi.clearAllMocks()
  collab.ctx = null
  base = mkdtempSync(join(tmpdir(), 'claudeui-cs-wd-'))
})

afterEach(() => {
  session?.cancel()
  session = null
  emitEvent('config:sessions-changed', [{ worktreeInfoMap: {} }])
  clearSyncSubscribersForTests()
  rmSync(base, { recursive: true, force: true })
})

async function started(routingId: string): Promise<NonNullable<typeof collab.ctx>> {
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
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
  session = new ClaudeSession(routingId, win, '/tmp/proj', {})
  await session.run('go')
  return collab.ctx!
}

describe('ClaudeSession — the dispatch server’s working directory', () => {
  it('is the cwd without a worktree entry, the worktree once canonical names an existing one, and the cwd when it is gone', async () => {
    const ctx = await started('rid-wd')
    expect(ctx.cwd).toBe('/tmp/proj')
    expect(ctx.getWorkingDirectory?.()).toBe('/tmp/proj')

    emitEvent('config:sessions-changed', [{ worktreeInfoMap: { 'rid-wd': info(base) } }])
    expect(ctx.getWorkingDirectory?.()).toBe(base)

    rmSync(base, { recursive: true, force: true })
    expect(ctx.getWorkingDirectory?.()).toBe('/tmp/proj')
  })
})
