/**
 * @vitest-environment node
 *
 * Media generation on Claude (the real ClaudeSession.run(), SDK query mocked): `claude-ui-media` is
 * its own server, outside allowedTools, present only while the Claude toggle is on; a call is asked
 * like any tool (with the normal suggestions) and denied in plan mode, even where cli.js would skip
 * canUseTool for an allowed tool (the handler refuses too); the root agent's call is a background
 * job under the session's routing id, a subagent's waits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

const { mockQuery, mediaSetting, startSpy } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mediaSetting: { value: undefined as unknown },
  startSpy: vi.fn()
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
  opencodeServerManager: { setServerStartedHook: () => {}, isBinaryAvailable: (): boolean => true }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => true
}))
vi.mock('../media-jobs', () => ({ mediaJobs: { start: startSpy } }))
vi.mock('../app-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app-settings')>()
  return {
    ...actual,
    appSetting: (key: string): unknown =>
      key === 'mediaGeneration' ? mediaSetting.value : actual.appSetting(key as never)
  }
})
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
vi.mock('../session-history', () => ({ computeTokenMetrics: vi.fn(() => ({})) }))
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

import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'
import type { SdkMcpServer } from '../../sdk'

afterEach(() => {
  clearSyncSubscribersForTests()
})

interface Captured {
  mcpServers: Record<string, SdkMcpServer>
  allowedTools: string[]
  onInboundFrame: (frame: Record<string, unknown>) => void
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseId?: string; suggestions?: unknown[] }
  ) => Promise<{ behavior: string; message?: string }>
}

function fakeQuery(): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      /* ends at once */
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
}

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

const live: ClaudeSession[] = []

async function boot(): Promise<{
  session: ClaudeSession
  options: Captured
  sent: Array<[string, string, unknown]>
}> {
  const { win, sent } = makeWin()
  const session = new ClaudeSession('routing-1', win, '/tmp/proj')
  live.push(session)
  await session.run('hello')
  return { session, options: mockQuery.mock.calls[0][0].options as Captured, sent }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const IMAGE = 'mcp__claude-ui-media__generate_image'

beforeEach(() => {
  vi.clearAllMocks()
  mediaSetting.value = undefined
  mockQuery.mockImplementation(() => fakeQuery())
  startSpy.mockResolvedValue({
    ok: true,
    jobId: 'j1',
    path: '/tmp/proj/.claude/ui/media/j1.png',
    modelLabel: 'ChatGPT Plan'
  })
})
afterEach(() => {
  for (const s of live.splice(0)) s.cancel()
})

describe('claude-ui-media registration', () => {
  it('is its own server with both tools and is never in allowedTools', async () => {
    const { options } = await boot()
    const server = options.mcpServers['claude-ui-media']
    expect(server.tools.map((t) => t.name)).toEqual(['generate_image', 'generate_video'])
    expect(options.allowedTools.join(' ')).not.toContain('media')
  })

  it('is not offered while the Claude toggle is off', async () => {
    mediaSetting.value = { engines: { claude: false } }
    const { options } = await boot()
    expect(options.mcpServers['claude-ui-media']).toBeUndefined()
  })
})

describe('canUseTool for the media tools', () => {
  it('asks in default mode and passes the normal suggestions on', async () => {
    const { session, options, sent } = await boot()
    const suggestions = [{ type: 'addRules', behavior: 'allow', destination: 'localSettings' }]
    const pending = options.canUseTool(
      IMAGE,
      { prompt: 'a fox' },
      { signal: new AbortController().signal, toolUseId: 'toolu_1', suggestions }
    )
    await tick()
    const request = sent.find(([c]) => c === 'session:approval-request')![2] as {
      requestId: string
      suggestions?: unknown[]
    }
    expect(request.suggestions).toEqual(suggestions)
    session.resolveApproval(request.requestId, 'allow')
    expect((await pending).behavior).toBe('allow')
  })

  it('asks in acceptEdits too', async () => {
    const { session, options, sent } = await boot()
    await session.setPermissionMode('acceptEdits')
    void options.canUseTool(
      IMAGE,
      { prompt: 'a fox' },
      { signal: new AbortController().signal, toolUseId: 'toolu_2' }
    )
    await tick()
    expect(sent.some(([c]) => c === 'session:approval-request')).toBe(true)
  })

  it('denies in plan mode with no card', async () => {
    const { session, options, sent } = await boot()
    await session.setPermissionMode('plan')
    const result = await options.canUseTool(
      'mcp__claude-ui-media__generate_video',
      { prompt: 'a fox' },
      { signal: new AbortController().signal, toolUseId: 'toolu_3' }
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('plan mode')
    expect(sent.some(([c]) => c === 'session:approval-request')).toBe(false)
  })
})

describe('the media handler', () => {
  const call = async (
    options: Captured,
    toolUseId: string
  ): Promise<{ content: { text: string }[]; isError?: boolean }> => {
    const tool = options.mcpServers['claude-ui-media'].tools[0]
    return (await tool.handler({ prompt: 'a fox' }, {
      meta: { 'claudecode/toolUseId': toolUseId }
    } as never)) as never
  }

  it('refuses in plan mode (cli.js skips canUseTool for a rule-allowed tool)', async () => {
    const { session, options } = await boot()
    await session.setPermissionMode('plan')
    const result = await call(options, 'toolu_4')
    expect(result.isError).toBe(true)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('starts a background job for the root agent under the session routing id', async () => {
    const { options } = await boot()
    options.onInboundFrame({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_root' }] }
    })
    const result = await call(options, 'toolu_root')
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Do not poll or re-request it.')
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        routingId: 'routing-1',
        toolUseId: 'toolu_root',
        kind: 'image',
        foreground: false
      })
    )
  })

  it("waits for a subagent's call", async () => {
    const { options } = await boot()
    options.onInboundFrame({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      message: { content: [{ type: 'tool_use', id: 'toolu_sub' }] }
    })
    await call(options, 'toolu_sub')
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'toolu_sub', foreground: true })
    )
  })
})
