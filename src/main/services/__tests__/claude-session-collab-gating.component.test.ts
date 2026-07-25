/**
 * @vitest-environment node
 *
 * Guard tests for the ADR-033 collab-server wiring in the REAL ClaudeSession.run():
 *
 *  1. `claude-ui-collab` is registered in mcpServers ONLY when the opencode
 *     binary is available — and its system-prompt paragraph appears only then.
 *  2. It is NEVER in allowedTools.
 *  3. canUseTool does NOT auto-allow `mcp__claude-ui-collab__dispatch_agent` —
 *     it must go through the ordinary approval path (approval-request emitted,
 *     promise pending until resolveApproval), while `mcp__claude-ui__*` stays
 *     auto-allowed.
 *  4. cancel() tears down the session's dispatch targets via disposeFor.
 *
 * The SDK query is mocked to capture the spawn options; everything else that
 * touches disk/processes is stubbed. This intentionally drives the real run()
 * so the gating cannot silently regress in the option-assembly code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery, binaryAvailable, crossEngineSpies } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  binaryAvailable: { value: true },
  crossEngineSpies: {
    dispatch: vi.fn(),
    resolveApproval: vi.fn(),
    disposeFor: vi.fn()
  }
}))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

// Keep tool()/createSdkMcpServer real (collab-tool builds a real server);
// replace query with a capture, and point the CLI locator at an existing file
// so run()'s existsSync gate passes.
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
    isBinaryAvailable: (): boolean => binaryAvailable.value
  }
}))

vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: crossEngineSpies,
  // Mirrors opencodeServerManager.isBinaryAvailable() above — same underlying
  // signal, now routed through the named capability helper (ADR-030/M4-A).
  crossEngineDispatchAvailable: (engineId: string): boolean =>
    engineId === 'claude' ? binaryAvailable.value : true
}))

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// loadEngineConfig is also read by collab-tool.ts (real here) to resolve the
// dispatch_agent model hint (ADR-033 follow-up) — {} keeps that path on the
// generic hint, hermetically, without touching the real dev machine's config.
vi.mock('../ui-config', () => ({ saveSlashCommands: vi.fn(), loadEngineConfig: vi.fn(() => ({})) }))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(() => ({})),
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
import type { SdkMcpServer } from '../../sdk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedOptions {
  mcpServers: Record<string, SdkMcpServer>
  allowedTools: string[]
  systemPrompt: { append: string }
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseId?: string; suggestions?: unknown[] }
  ) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>
}

function makeFakeQueryHandle(): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      /* end immediately — run() falls through to its finally block */
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
  return { win, sent }
}

async function bootSession(): Promise<{
  session: ClaudeSession
  options: CapturedOptions
  sent: Array<[string, string, unknown]>
}> {
  const { win, sent } = makeWin()
  const session = new ClaudeSession('routing-1', win, '/tmp/proj')
  await session.run('hello')
  expect(mockQuery).toHaveBeenCalledTimes(1)
  const options = mockQuery.mock.calls[0][0].options as CapturedOptions
  return { session, options, sent }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
  binaryAvailable.value = true
  mockQuery.mockImplementation(() => makeFakeQueryHandle())
})

afterEach(() => {
  // Clear the 15-min inactivity timers that run()'s finally block starts.
  for (const s of liveSessions.splice(0)) s.cancel()
})

// ---------------------------------------------------------------------------
// Registration gating
// ---------------------------------------------------------------------------

describe('ClaudeSession — collab server registration (ADR-033)', () => {
  it('registers claude-ui-collab when the opencode binary is available', async () => {
    const { session, options } = await bootSession()
    liveSessions.push(session)

    const collab = options.mcpServers['claude-ui-collab']
    expect(collab).toBeTruthy()
    expect(collab.name).toBe('claude-ui-collab')
    expect(collab.tools.map((t) => t.name)).toEqual(['dispatch_agent'])
    // The UI tool servers are still there.
    expect(options.mcpServers['claude-ui']).toBeTruthy()
    expect(options.mcpServers['claude-ui-mockup']).toBeTruthy()
    // System prompt documents the tool only when registered.
    expect(options.systemPrompt.append).toContain('mcp__claude-ui-collab__dispatch_agent')
  })

  it('does NOT register claude-ui-collab when the binary is unavailable', async () => {
    binaryAvailable.value = false
    const { session, options } = await bootSession()
    liveSessions.push(session)

    expect(options.mcpServers['claude-ui-collab']).toBeUndefined()
    expect(options.systemPrompt.append).not.toContain('dispatch_agent')
    // The UI tool servers are unaffected.
    expect(options.mcpServers['claude-ui']).toBeTruthy()
  })

  it('never puts the collab server in allowedTools', async () => {
    const { session, options } = await bootSession()
    liveSessions.push(session)

    expect(options.allowedTools).toEqual(['mcp__claude-ui__*', 'mcp__claude-ui-mockup__*'])
    expect(options.allowedTools.join(' ')).not.toContain('collab')
  })
})

// ---------------------------------------------------------------------------
// canUseTool — the approval-path guard
// ---------------------------------------------------------------------------

describe('ClaudeSession — canUseTool does not auto-allow dispatch_agent', () => {
  it('mcp__claude-ui__* stays auto-allowed (control)', async () => {
    const { session, options } = await bootSession()
    liveSessions.push(session)

    const result = await options.canUseTool(
      'mcp__claude-ui__render_mermaid',
      { source: 'graph TD' },
      { signal: new AbortController().signal }
    )
    expect(result.behavior).toBe('allow')
  })

  it('mcp__claude-ui-collab__dispatch_agent goes through the ordinary approval path', async () => {
    const { session, options, sent } = await bootSession()
    liveSessions.push(session)

    const abort = new AbortController()
    const pending = options.canUseTool(
      'mcp__claude-ui-collab__dispatch_agent',
      { engine: 'opencode', prompt: 'x' },
      { signal: abort.signal, toolUseId: 'toolu_1' }
    )

    // An approval request must be emitted to the renderer…
    await tick()
    const approvalEvent = sent.find(([channel]) => channel === 'session:approval-request')
    expect(approvalEvent).toBeTruthy()
    const approval = approvalEvent![2] as { requestId: string; toolName: string }
    expect(approval.toolName).toBe('mcp__claude-ui-collab__dispatch_agent')

    // …and the canUseTool promise must still be pending (NOT auto-allowed).
    const sentinel = Symbol('pending')
    const raced = await Promise.race([pending, Promise.resolve(sentinel)])
    expect(raced).toBe(sentinel)

    // The user's decision resolves it.
    session.resolveApproval(approval.requestId, 'deny', { feedback: 'not now' })
    const result = await pending
    expect(result.behavior).toBe('deny')
    expect(result.message).toBe('not now')
  })

  it('approving the request resolves canUseTool with allow', async () => {
    const { session, options, sent } = await bootSession()
    liveSessions.push(session)

    const pending = options.canUseTool(
      'mcp__claude-ui-collab__dispatch_agent',
      { engine: 'opencode', prompt: 'x' },
      { signal: new AbortController().signal, toolUseId: 'toolu_2' }
    )
    await tick()
    const approval = sent.find(([c]) => c === 'session:approval-request')![2] as {
      requestId: string
    }
    session.resolveApproval(approval.requestId, 'allow')
    const result = await pending
    expect(result.behavior).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('ClaudeSession — dispatch teardown', () => {
  it('cancel() disposes the dispatch targets owned by this session', async () => {
    const { session } = await bootSession()
    session.cancel()
    expect(crossEngineSpies.disposeFor).toHaveBeenCalledWith('routing-1')
  })
})
