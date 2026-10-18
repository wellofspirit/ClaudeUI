/**
 * @vitest-environment node
 *
 * The session tools on Claude (slice 1c, ADR-033's collab server is the pattern):
 * `claude-ui-sessions` is its own in-process server built per spawn, never in
 * `allowedTools`, its guidance is appended to the system prompt, every call goes
 * through `canUseTool` and the session-tools gate, and Claude Code is told not to
 * defer the tools behind its tool search.
 *
 * Drives the real `ClaudeSession.run()` with the SDK query mocked, like
 * claude-session-collab-gating.component.test.ts.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests, emitEvent, syncCore } from '../../../core/services/sync-host'

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
  opencodeServerManager: { setServerStartedHook: () => {}, isBinaryAvailable: (): boolean => true }
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => true
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/services/ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({})),
  loadSessionConfig: vi.fn(() => ({})),
  saveSessionConfig: vi.fn()
}))
vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../../../core/services/session-history', () => ({
  computeTokenMetrics: vi.fn(() => ({})),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
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
import { configureSessionTools } from '../../../core/services/session-tools'
import { listAuditLog } from '../../../core/services/db'
import { refFor } from '../../../core/services/session-links'
import { TurnOriginLedger } from '../../../core/providers/turn-origin-ledger'
import type { SessionManager } from '../../../core/services/session-manager'
import type { BrowserWindow } from 'electron'
import type { SdkMcpServer } from '../../../core/sdk'

const PREFIX = 'mcp__claude-ui-sessions__'

interface CapturedOptions {
  mcpServers: Record<string, SdkMcpServer>
  allowedTools: string[]
  systemPrompt: { append: string }
  onInboundFrame: (frame: Record<string, unknown>) => void
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseId?: string; agentId?: string; suggestions?: unknown[] }
  ) => Promise<{ behavior: string; updatedInput?: unknown; message?: string }>
}

function makeFakeQueryHandle(): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      /* end immediately */
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

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const live: ClaudeSession[] = []
const ledgers = new Map<string, TurnOriginLedger>()
let n = 0

function configureHost(): void {
  const manager = {
    get: (id: string) => (ledgers.has(id) ? { originLedger: ledgers.get(id) } : undefined),
    getMessages: vi.fn(async () => [])
  } as unknown as SessionManager
  configureSessionTools({ manager, createSession: vi.fn(), sendPrompt: vi.fn() })
}

async function boot(opts: { mode?: string } = {}): Promise<{
  session: ClaudeSession
  options: CapturedOptions
  sent: Array<[string, string, unknown]>
  rid: string
  cwd: string
}> {
  const { win, sent } = makeWin()
  const rid = `routing-sessions-${process.pid}-${++n}`
  const cwd = path.join(process.cwd(), 'tmp-session-tools-proj')
  const session = new ClaudeSession(rid, win, cwd, opts.mode ? { permissionMode: opts.mode } : {})
  ledgers.set(rid, new TurnOriginLedger())
  live.push(session)
  await session.run('hello')
  const options = mockQuery.mock.calls.at(-1)?.[0].options as CapturedOptions
  return { session, options, sent, rid, cwd }
}

beforeEach(() => {
  vi.clearAllMocks()
  syncCore.resetCanonicalForTests()
  mockQuery.mockImplementation(() => makeFakeQueryHandle())
  configureHost()
})

afterEach(() => {
  for (const s of live.splice(0)) s.cancel()
  configureSessionTools(null)
  clearSyncSubscribersForTests()
})

describe('registration', () => {
  it('registers claude-ui-sessions with the nine tools, outside allowedTools, with its guidance in the prompt', async () => {
    const { options } = await boot()
    const server = options.mcpServers['claude-ui-sessions']
    expect(server).toBeTruthy()
    expect(server.tools.map((t) => t.name)).toEqual([
      'session_list',
      'session_get',
      'session_read',
      'session_message',
      'session_start',
      'session_dismiss_proposal',
      'session_hand_off',
      'session_usage',
      'session_stop'
    ])
    // Not auto-allowed: the same two entries the session always had.
    expect(options.allowedTools).toEqual(['mcp__claude-ui__*', 'mcp__claude-ui-mockup__*'])
    expect(options.systemPrompt.append).toContain('## ClaudeUI Sessions')
    expect(options.systemPrompt.append).toContain(`${PREFIX}session_start`)
    expect(options.systemPrompt.append).toContain('brief must stand alone')
    // The dispatch section and its server are untouched.
    expect(options.mcpServers['claude-ui-collab']).toBeTruthy()
    expect(options.systemPrompt.append).toContain('mcp__claude-ui-collab__dispatch_agent')
  })

  it('registers nothing where the host has not wired the tools', async () => {
    configureSessionTools(null)
    const { options } = await boot()
    expect(options.mcpServers['claude-ui-sessions']).toBeUndefined()
    expect(options.systemPrompt.append).not.toContain('ClaudeUI Sessions')
    expect(options.systemPrompt.append).not.toContain('session_start')
  })

  it('registers nothing, tools or guidance, while the host-wide Session tools setting is off; back on, it does again', async () => {
    syncCore.setAppState({ settings: { sessionTools: false } })
    const off = await boot()
    expect(off.options.mcpServers['claude-ui-sessions']).toBeUndefined()
    expect(off.options.systemPrompt.append).not.toContain('ClaudeUI Sessions')
    expect(off.options.systemPrompt.append).not.toContain('session_start')
    // The dispatch tools are a different family and stay.
    expect(off.options.mcpServers['claude-ui-collab']).toBeTruthy()

    syncCore.setAppState({ settings: {} })
    const on = await boot()
    expect(on.options.mcpServers['claude-ui-sessions']).toBeTruthy()
    expect(on.options.systemPrompt.append).toContain('## ClaudeUI Sessions')
  })

  it('only the interactive ClaudeSession builds the server: dispatch targets, automations and side questions never do', () => {
    // Those run on raw SDK queries (service-session, the dispatcher, the automation
    // manager), not on a ClaudeSession; a second call site would give them the tools.
    const callers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full)
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          if (fs.readFileSync(full, 'utf8').includes('createSessionToolsServer(')) {
            callers.push(full)
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))
    const rel = callers.map((p) => path.relative(process.cwd(), p).split(path.sep).join('/'))
    expect(rel.sort()).toEqual([
      'src/core/services/claude-session.ts',
      'src/core/services/session-tools-server.ts'
    ])
  })
})

describe('the tools as Claude Code sees them', () => {
  async function connect(server: SdkMcpServer): Promise<Client> {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.instance!.connect(serverTransport)
    const client = new Client({ name: 'test', version: '0.0.0' }, {})
    await client.connect(clientTransport)
    return client
  }

  it('every tool asks not to be deferred behind tool search', async () => {
    const { options } = await boot()
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(9)
      for (const t of tools) {
        expect((t as { _meta?: Record<string, unknown> })._meta, t.name).toEqual({
          'anthropic/alwaysLoad': true
        })
      }
      // The message tool says what it is not.
      const message = tools.find((t) => t.name === 'session_message')?.description ?? ''
      expect(message).toContain("the user's ClaudeUI sidebar")
      expect(message).toContain('reached with SendMessage, not with this tool')
    } finally {
      await client.close()
    }
  })

  it('a call reaches the service with the live session as the caller', async () => {
    const { options, rid } = await boot()
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      const result = (await client.callTool({ name: 'session_usage', arguments: {} })) as {
        content: Array<{ text: string }>
        isError?: boolean
      }
      expect(result.isError).toBeFalsy()
      // The ref in the answer is the one the live routing id resolves to.
      expect(result.content[0].text).toMatch(
        new RegExp(`^${refFor('claude', rid)}: (0 of 200000 tokens used|context use unknown)`)
      )
      // An acting tool needs its call attributed to the root agent first.
      options.onInboundFrame(rootFrame('tu-root-1'))
      const refused = (await client.callTool({
        name: 'session_stop',
        arguments: { session: 'self' },
        _meta: { 'claudecode/toolUseId': 'tu-root-1' }
      })) as { content: Array<{ text: string }>; isError?: boolean }
      expect(refused.isError).toBe(true)
      expect(refused.content[0].text).toContain('cannot stop its own turn')
    } finally {
      await client.close()
    }
  })
})

/** The assistant frame cli.js writes before it runs a tool: the root agent's, or a subagent's. */
function rootFrame(toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: toolUseId, name: `${PREFIX}session_stop` }] }
  }
}
function subagentFrame(toolUseId: string): Record<string, unknown> {
  return { ...rootFrame(toolUseId), parent_tool_use_id: 'toolu_agent_call' }
}

describe('root agent only, in every mode (no canUseTool involved)', () => {
  async function connect(server: SdkMcpServer): Promise<Client> {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.instance!.connect(serverTransport)
    const client = new Client({ name: 'test', version: '0.0.0' }, {})
    await client.connect(clientTransport)
    return client
  }
  type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
  const call = (
    client: Client,
    name: string,
    args: Record<string, unknown>,
    toolUseId?: string
  ): Promise<ToolResult> =>
    client.callTool({
      name,
      arguments: args,
      ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {})
    }) as Promise<ToolResult>
  const auditRows = (rid: string): ReturnType<typeof listAuditLog> =>
    listAuditLog({ limit: 500 }).filter(
      (r) => r.connectionId === `session:${refFor('claude', rid)}`
    )

  it('refuses a subagent acting call in bypassPermissions and audits it; the root agent runs', async () => {
    const { options, rid } = await boot({ mode: 'bypassPermissions' })
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      options.onInboundFrame(subagentFrame('tu-sub'))
      options.onInboundFrame(rootFrame('tu-root'))
      const sub = await call(
        client,
        'session_start',
        { title: 't', prompt: 'p', background: 'b'.repeat(90) },
        'tu-sub'
      )
      expect(sub.isError).toBe(true)
      expect(sub.content[0].text).toBe(
        "Refused: session_start can only be used by the session's main agent, not by a subagent."
      )
      for (const tool of ['session_message', 'session_stop', 'session_hand_off']) {
        const out = await call(
          client,
          tool,
          { session: 'self', message: 'x', title: 't', handoff: 'h' },
          'tu-sub'
        )
        expect(out.content[0].text, tool).toMatch(/not by a subagent/)
      }
      // The root agent gets past the attribution to the verb's own answer.
      const root = await call(client, 'session_stop', { session: 'self' }, 'tu-root')
      expect(root.content[0].text).toContain('cannot stop its own turn')
      const rows = auditRows(rid).filter((r) => r.detail?.includes('not by a subagent'))
      expect(rows.map((r) => r.channel).sort()).toEqual([
        'session-tools:session_hand_off',
        'session-tools:session_message',
        'session-tools:session_start',
        'session-tools:session_stop'
      ])
      expect(rows.every((r) => r.outcome === 'error' && r.method === 'agent')).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('refuses a call it cannot attribute: no frame, or no tool_use id at all', async () => {
    const { options, rid } = await boot({ mode: 'bypassPermissions' })
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      const started = Date.now()
      const unseen = await call(client, 'session_stop', { session: 'self' }, 'tu-never-announced')
      expect(unseen.isError).toBe(true)
      expect(unseen.content[0].text).toMatch(/could not be attributed to the session's main agent/)
      // It waited for the frame before giving up.
      expect(Date.now() - started).toBeGreaterThanOrEqual(200)
      const noId = await call(client, 'session_stop', { session: 'self' })
      expect(noId.content[0].text).toMatch(/could not be attributed/)
      expect(
        auditRows(rid).filter((r) => r.detail?.includes('could not be attributed'))
      ).toHaveLength(2)
    } finally {
      await client.close()
    }
  })

  it('a frame that arrives just after the call still attributes it, to a subagent or to the root', async () => {
    const { options } = await boot({ mode: 'bypassPermissions' })
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      const lateSub = call(client, 'session_stop', { session: 'self' }, 'tu-late-sub')
      setTimeout(() => options.onInboundFrame(subagentFrame('tu-late-sub')), 60)
      expect((await lateSub).content[0].text).toMatch(/not by a subagent/)
      const lateRoot = call(client, 'session_stop', { session: 'self' }, 'tu-late-root')
      setTimeout(() => options.onInboundFrame(rootFrame('tu-late-root')), 60)
      expect((await lateRoot).content[0].text).toContain('cannot stop its own turn')
    } finally {
      await client.close()
    }
  })

  it('reads are not held up by attribution', async () => {
    const { options } = await boot({ mode: 'bypassPermissions' })
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      const out = await call(client, 'session_list', {}, 'tu-sub-read')
      expect(out.isError).toBeFalsy()
    } finally {
      await client.close()
    }
  })

  it('canUseTool agentId verdict feeds the same record (a non-bypass mode)', async () => {
    const { options } = await boot()
    const client = await connect(options.mcpServers['claude-ui-sessions'])
    try {
      await options.canUseTool(
        `${PREFIX}session_stop`,
        { session: 'self' },
        { signal: new AbortController().signal, toolUseId: 'tu-cut', agentId: 'agent-3' }
      )
      const out = await call(client, 'session_stop', { session: 'self' }, 'tu-cut')
      expect(out.content[0].text).toMatch(/not by a subagent/)
    } finally {
      await client.close()
    }
  })
})

describe('canUseTool and the session-tools gate', () => {
  it('allows the free tools without an approval card', async () => {
    const { options, sent } = await boot()
    const result = await options.canUseTool(
      `${PREFIX}session_list`,
      {},
      {
        signal: new AbortController().signal,
        toolUseId: 'tu-1'
      }
    )
    expect(result.behavior).toBe('allow')
    expect(sent.some(([c]) => c === 'session:approval-request')).toBe(false)
  })

  it('refuses an acting tool called from a subagent, says why, and audits it', async () => {
    const { options, rid, sent } = await boot()
    const result = await options.canUseTool(
      `${PREFIX}session_start`,
      { title: 't', prompt: 'p', background: 'b'.repeat(90) },
      { signal: new AbortController().signal, toolUseId: 'tu-2', agentId: 'agent-7' }
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(/main agent, not by a subagent/)
    expect(sent.some(([c]) => c === 'session:approval-request')).toBe(false)
    const ref = refFor('claude', rid)
    const rows = listAuditLog({ limit: 500 }).filter((r) => r.connectionId === `session:${ref}`)
    expect(rows).toMatchObject([
      {
        method: 'agent',
        capability: 'chat',
        channel: 'session-tools:session_start',
        outcome: 'error',
        label: `${ref} (claude)`
      }
    ])
    expect(rows[0].detail).toMatch(/main agent, not by a subagent/)
  })

  it('plan mode refuses acting tools outright', async () => {
    const { options } = await boot({ mode: 'plan' })
    const result = await options.canUseTool(
      `${PREFIX}session_message`,
      { session: 'self', message: 'x' },
      { signal: new AbortController().signal, toolUseId: 'tu-3' }
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(/plan mode/)
  })

  it('a read outside the family and project goes to the ordinary approval card', async () => {
    const { options, session, sent } = await boot()
    emitEvent('session:created', [
      'elsewhere-1',
      { cwd: '/some/other/project', engineId: 'claude' }
    ])
    const pending = options.canUseTool(
      `${PREFIX}session_read`,
      { session: 'elsewhere-1' },
      { signal: new AbortController().signal, toolUseId: 'tu-4' }
    )
    await tick()
    const card = sent.find(([c]) => c === 'session:approval-request')
    expect(card).toBeTruthy()
    expect((card![2] as { toolName: string }).toolName).toBe(`${PREFIX}session_read`)
    const sentinel = Symbol('pending')
    expect(await Promise.race([pending, Promise.resolve(sentinel)])).toBe(sentinel)
    session.resolveApproval((card![2] as { requestId: string }).requestId, 'allow')
    expect((await pending).behavior).toBe('allow')
  })

  const SUGGESTION = [
    {
      type: 'addRules',
      rules: [{ toolName: `${PREFIX}session_read` }],
      behavior: 'allow',
      destination: 'userSettings'
    }
  ]

  it('offers no "always allow" on a session tool, and ignores one a client sends anyway', async () => {
    const { options, session, sent } = await boot()
    emitEvent('session:created', [
      'elsewhere-2',
      { cwd: '/some/other/project', engineId: 'claude' }
    ])
    const pending = options.canUseTool(
      `${PREFIX}session_read`,
      { session: 'elsewhere-2' },
      { signal: new AbortController().signal, toolUseId: 'tu-s1', suggestions: SUGGESTION }
    )
    await tick()
    const card = sent.find(([c]) => c === 'session:approval-request')![2] as {
      requestId: string
      suggestions?: unknown
    }
    expect(card.suggestions).toBeUndefined()
    session.resolveApproval(card.requestId, 'allow', undefined, SUGGESTION as never)
    const result = (await pending) as { behavior: string; updatedPermissions?: unknown }
    expect(result.behavior).toBe('allow')
    expect(result.updatedPermissions).toBeUndefined()
  })

  it('still offers the suggestion on every other tool (dispatch_agent is unchanged)', async () => {
    const { options, session, sent } = await boot()
    const pending = options.canUseTool(
      'mcp__claude-ui-collab__dispatch_agent',
      { engine: 'opencode', prompt: 'x' },
      { signal: new AbortController().signal, toolUseId: 'tu-s2', suggestions: SUGGESTION }
    )
    await tick()
    const card = sent.find(([c]) => c === 'session:approval-request')![2] as {
      requestId: string
      suggestions?: unknown
    }
    expect(card.suggestions).toEqual(SUGGESTION)
    session.resolveApproval(card.requestId, 'allow', undefined, SUGGESTION as never)
    expect(((await pending) as { updatedPermissions?: unknown }).updatedPermissions).toEqual(
      SUGGESTION
    )
  })

  it('a refused call names its target in the audit row when the input names one', async () => {
    const { options, rid } = await boot({ mode: 'plan' })
    emitEvent('session:created', ['named-target', { cwd: '/p', engineId: 'claude' }])
    await options.canUseTool(
      `${PREFIX}session_message`,
      { session: 'named-target', message: 'x' },
      { signal: new AbortController().signal, toolUseId: 'tu-n1' }
    )
    const rows = listAuditLog({ limit: 500 }).filter(
      (r) => r.connectionId === `session:${refFor('claude', rid)}`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sessionId).toBe(refFor('claude', 'named-target'))
    // And with no resolvable target the row simply has none.
    await options.canUseTool(
      `${PREFIX}session_stop`,
      { session: 'nobody-by-that-name' },
      { signal: new AbortController().signal, toolUseId: 'tu-n2' }
    )
    const after = listAuditLog({ limit: 500 }).filter(
      (r) => r.connectionId === `session:${refFor('claude', rid)}`
    )
    expect(after.find((r) => r.channel === 'session-tools:session_stop')?.sessionId).toBeNull()
  })

  it('leaves dispatch_agent on its own approval path', async () => {
    const { options, sent } = await boot()
    const pending = options.canUseTool(
      'mcp__claude-ui-collab__dispatch_agent',
      { engine: 'opencode', prompt: 'x' },
      { signal: new AbortController().signal, toolUseId: 'tu-5' }
    )
    await tick()
    expect(sent.some(([c]) => c === 'session:approval-request')).toBe(true)
    void pending
  })
})
