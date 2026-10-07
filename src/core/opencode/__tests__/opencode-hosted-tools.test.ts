/**
 * @vitest-environment node
 *
 * Unit tests for createOpencodeHostedToolsServer.
 *
 * Verifies:
 *   - Server is named 'claudeui' and carries all 3 tools
 *   - Mockup tool uses the provided cwd for file I/O
 *   - Tool names are exactly render_mermaid, create_mockup, show_mockup
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// createOpencodeHostedToolsServer reads engines/claude.json (via loadEngineConfig)
// on EVERY call to resolve the dispatch_agent model hint (ADR-033 follow-up) —
// mocked so tests are hermetic and don't depend on the real dev machine's
// ~/.claude/ui/engines/claude.json.
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: vi.fn(() => ({}))
}))

import { createOpencodeHostedToolsServer } from '../opencode-hosted-tools'
import { resolveCallerIdentity } from '../opencode-hosted-tools'
import type {
  CallerRootResolver,
  CallerSessionHandle,
  DispatchAgentFn
} from '../opencode-hosted-tools'
import { loadEngineConfig } from '../../services/ui-config'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'claudeui-hosted-tools-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('createOpencodeHostedToolsServer', () => {
  it('returns a McpServer instance', () => {
    const server = createOpencodeHostedToolsServer(tmp)
    expect(server).toBeInstanceOf(McpServer)
  })

  it('registers exactly 4 tools: render_mermaid, create_mockup, show_mockup, dispatch_agent', () => {
    const server = createOpencodeHostedToolsServer(tmp)
    // Access the internal tool registry via the server's _registeredTools map
    // (internal API, but necessary for unit verification without a full MCP session).
    const toolNames = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}
    )
    expect(toolNames.sort()).toEqual([
      'create_mockup',
      'dispatch_agent',
      'render_mermaid',
      'show_mockup'
    ])
  })

  it('create_mockup writes files under <cwd>/.claude/ui/mockups', async () => {
    const server = createOpencodeHostedToolsServer(tmp)
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, unknown>) => Promise<unknown> }
        >
      }
    )._registeredTools

    const result = (await tools['create_mockup'].handler({ html: '<h1>Hello</h1>' })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content[0].type).toBe('text')
    const text = result.content[0].text

    // Parse the directory ID from the result text.
    const m = /Directory:\s*(\S+)/.exec(text)
    expect(m).not.toBeNull()
    const id = m![1]

    const indexPath = join(tmp, '.claude', 'ui', 'mockups', id, 'index.html')
    expect(existsSync(indexPath)).toBe(true)

    const html = await readFile(indexPath, 'utf-8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('https://cdn.tailwindcss.com')
  })

  it('show_mockup returns success text for an existing mockup', async () => {
    // Set up a pre-existing mockup directory.
    const id = 'abcd1234'
    const mockupDir = join(tmp, '.claude', 'ui', 'mockups', id)
    await mkdir(mockupDir, { recursive: true })
    await writeFile(join(mockupDir, 'index.html'), '<html></html>', 'utf-8')

    const server = createOpencodeHostedToolsServer(tmp)
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, unknown>) => Promise<unknown> }
        >
      }
    )._registeredTools

    const result = (await tools['show_mockup'].handler({ directory: id })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content[0].text).toContain('Mockup displayed')
    expect(result.content[0].text).toContain(id)
  })

  it('cwd isolation: two servers for different cwds write to their own dirs', async () => {
    const tmp2 = await mkdtemp(join(tmpdir(), 'claudeui-hosted-tools-b-'))
    try {
      const serverA = createOpencodeHostedToolsServer(tmp)
      const serverB = createOpencodeHostedToolsServer(tmp2)
      const toolsA = (
        serverA as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: Record<string, unknown>) => Promise<unknown> }
          >
        }
      )._registeredTools
      const toolsB = (
        serverB as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: Record<string, unknown>) => Promise<unknown> }
          >
        }
      )._registeredTools

      const resultA = (await toolsA['create_mockup'].handler({ html: '<p>A</p>' })) as {
        content: Array<{ type: string; text: string }>
      }
      const resultB = (await toolsB['create_mockup'].handler({ html: '<p>B</p>' })) as {
        content: Array<{ type: string; text: string }>
      }

      const idA = /Directory:\s*(\S+)/.exec(resultA.content[0].text)![1]
      const idB = /Directory:\s*(\S+)/.exec(resultB.content[0].text)![1]

      // Each mockup lands in its own cwd.
      expect(existsSync(join(tmp, '.claude', 'ui', 'mockups', idA, 'index.html'))).toBe(true)
      expect(existsSync(join(tmp2, '.claude', 'ui', 'mockups', idB, 'index.html'))).toBe(true)
      // Not crossed.
      expect(existsSync(join(tmp2, '.claude', 'ui', 'mockups', idA, 'index.html'))).toBe(false)
      expect(existsSync(join(tmp, '.claude', 'ui', 'mockups', idB, 'index.html'))).toBe(false)
    } finally {
      await rm(tmp2, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// dispatch_agent (ADR-033 M2 — opencode → Claude)
// ---------------------------------------------------------------------------

function makeExtra(meta?: Record<string, unknown>): {
  signal: AbortSignal
  sendNotification: ReturnType<typeof vi.fn>
  _meta?: Record<string, unknown>
} {
  return {
    signal: new AbortController().signal,
    sendNotification: vi.fn(async () => {}),
    ...(meta ? { _meta: meta } : {})
  }
}

const callerHandle = (): CallerSessionHandle => ({
  cwd: '/proj',
  getAutonomyMode: () => 'default',
  getMessages: () => [],
  emit: vi.fn(),
  addDispatchedCost: vi.fn()
})

function getDispatchTool(
  tmp: string,
  deps: {
    lookupCallerSession?: (id: string) => CallerSessionHandle | undefined
    resolveCallerRoot?: CallerRootResolver
    dispatch?: DispatchAgentFn
  }
): { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> } {
  const server = createOpencodeHostedToolsServer(tmp, deps)
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >
    }
  )._registeredTools['dispatch_agent']
}

describe('createOpencodeHostedToolsServer — dispatch_agent (ADR-033 M2)', () => {
  it('neither _meta nor the plugin stamp → isError naming both signals', async () => {
    const tool = getDispatchTool(tmp, {})
    const result = (await tool.handler({ engine: 'claude', prompt: 'x' }, makeExtra())) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('ai.opencode/sessionID')
    expect(result.content[0].text).toContain('claudeui-xeng')
  })

  it('unknown/expired caller session id → isError (lookup returns undefined)', async () => {
    const tool = getDispatchTool(tmp, { lookupCallerSession: () => undefined })
    const result = (await tool.handler(
      { engine: 'claude', prompt: 'x', __xeng_caller_session: 'ses_gone' },
      makeExtra()
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('ses_gone')
  })

  it('no dispatch function wired → isError (never throws)', async () => {
    const tool = getDispatchTool(tmp, {
      lookupCallerSession: () => ({
        cwd: '/proj',
        getAutonomyMode: () => 'default',
        getMessages: () => [],
        emit: vi.fn(),
        addDispatchedCost: vi.fn()
      })
    })
    const result = (await tool.handler(
      { engine: 'claude', prompt: 'x', __xeng_caller_session: 'ses_1' },
      makeExtra()
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
  })

  it('happy path: strips the internal arg, dispatches with fromRoutingId = caller id, appends session_id', async () => {
    const emit = vi.fn()
    const getAutonomyMode = (): string => 'acceptEdits'
    const getMessages = (): [] => []
    const addDispatchedCost = vi.fn()
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({
      text: 'the review',
      sessionId: 'claude-42'
    }))
    const tool = getDispatchTool(tmp, {
      lookupCallerSession: (id) => {
        expect(id).toBe('ses_caller')
        return {
          cwd: '/proj',
          getAutonomyMode,
          getMessages,
          emit,
          addDispatchedCost
        }
      },
      dispatch
    })
    const extra = makeExtra()
    const result = (await tool.handler(
      {
        engine: 'claude',
        prompt: 'review the diff',
        model: 'haiku',
        __xeng_caller_session: 'ses_caller',
        __xeng_call_id: 'call_99'
      },
      extra
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }

    expect(dispatch).toHaveBeenCalledWith(
      { engine: 'claude', prompt: 'review the diff', model: 'haiku', sessionId: undefined },
      expect.objectContaining({
        fromEngine: 'opencode',
        fromRoutingId: 'ses_caller',
        cwd: '/proj',
        // The caller's live accessors, passed through (ADR-088).
        getAutonomyMode,
        getMessages,
        emit,
        addDispatchedCost,
        toolUseId: 'call_99'
      })
    )
    // The internal args never reached the dispatch call's request shape.
    const [reqArg] = dispatch.mock.calls[0]
    expect(reqArg).not.toHaveProperty('__xeng_caller_session')
    expect(reqArg).not.toHaveProperty('__xeng_call_id')

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('the review')
    expect(result.content[0].text).toContain('session_id: claude-42')
  })

  it('missing __xeng_call_id → dispatch still proceeds, ctx.toolUseId is undefined', async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'ok', sessionId: 'claude-1' }))
    const tool = getDispatchTool(tmp, {
      lookupCallerSession: () => ({
        cwd: '/proj',
        getAutonomyMode: () => 'default',
        getMessages: () => [],
        emit: vi.fn(),
        addDispatchedCost: vi.fn()
      }),
      dispatch
    })
    const result = (await tool.handler(
      { engine: 'claude', prompt: 'x', __xeng_caller_session: 'ses_1' },
      makeExtra()
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toolUseId: undefined })
    )
  })

  it('propagates dispatch isError as an isError tool result without a session_id suffix', async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({
      text: 'something broke',
      sessionId: '',
      isError: true
    }))
    const tool = getDispatchTool(tmp, {
      lookupCallerSession: () => ({
        cwd: '/proj',
        getAutonomyMode: () => 'default',
        getMessages: () => [],
        emit: vi.fn(),
        addDispatchedCost: vi.fn()
      }),
      dispatch
    })
    const result = (await tool.handler(
      { engine: 'claude', prompt: 'x', __xeng_caller_session: 'ses_1' },
      makeExtra()
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('something broke')
  })

  // -------------------------------------------------------------------------
  // ADR-033 M4c — pi as a second dispatch target (engine enum widening)
  // -------------------------------------------------------------------------

  it("the engine param's schema accepts 'pi' and rejects an unlisted engine value", () => {
    const def = getDispatchToolDef(tmp)
    const engineSchema = (
      def.inputSchema.shape as unknown as Record<
        string,
        { safeParse: (v: unknown) => { success: boolean } }
      >
    ).engine
    expect(engineSchema.safeParse('pi').success).toBe(true)
    expect(engineSchema.safeParse('claude').success).toBe(true)
    expect(engineSchema.safeParse('opencode').success).toBe(false)
  })

  it("accepts engine: 'pi' and delegates to the dispatcher (ADR-033 M4c)", async () => {
    const emit = vi.fn()
    const addDispatchedCost = vi.fn()
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({
      text: 'pi says hi',
      sessionId: 'pi-sess-1'
    }))
    const tool = getDispatchTool(tmp, {
      lookupCallerSession: () => ({
        cwd: '/proj',
        getAutonomyMode: () => 'default',
        getMessages: () => [],
        emit,
        addDispatchedCost
      }),
      dispatch
    })
    const result = (await tool.handler(
      {
        engine: 'pi',
        prompt: 'do a thing',
        model: 'openai-codex/gpt-5.6-luna',
        __xeng_caller_session: 'ses_caller',
        __xeng_call_id: 'call_99'
      },
      makeExtra()
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }

    expect(dispatch).toHaveBeenCalledWith(
      {
        engine: 'pi',
        prompt: 'do a thing',
        model: 'openai-codex/gpt-5.6-luna',
        sessionId: undefined
      },
      expect.objectContaining({
        fromEngine: 'opencode',
        fromRoutingId: 'ses_caller',
        toolUseId: 'call_99'
      })
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('pi says hi')
    expect(result.content[0].text).toContain('session_id: pi-sess-1')
  })
})

// ---------------------------------------------------------------------------
// dispatch_agent model hint (ADR-033 follow-up)
// ---------------------------------------------------------------------------

function getDispatchToolDef(t: string): {
  description: string
  inputSchema: { shape: Record<string, { description?: string }> }
} {
  return (
    createOpencodeHostedToolsServer(t) as unknown as {
      _registeredTools: Record<
        string,
        { description: string; inputSchema: { shape: Record<string, { description?: string }> } }
      >
    }
  )._registeredTools['dispatch_agent']
}

describe('createOpencodeHostedToolsServer — dispatch_agent model hint (ADR-033 follow-up)', () => {
  afterEach(() => {
    vi.mocked(loadEngineConfig).mockReturnValue({})
  })

  it('bakes the configured allowlist into both the tool description and the model param describe()', () => {
    vi.mocked(loadEngineConfig).mockReturnValue({
      dispatch: { allowedModels: ['sonnet', 'haiku'], defaultModel: 'sonnet' }
    })
    const def = getDispatchToolDef(tmp)
    expect(def.description).toContain('sonnet')
    expect(def.description).toContain('haiku')
    expect(def.description).toContain('Default: sonnet')
    expect(def.inputSchema.shape.model.description).toContain('sonnet')
  })

  it('steers opencode to its own task tool first (S4) and lists claude, pi and codex as targets', () => {
    vi.mocked(loadEngineConfig).mockReturnValue({})
    const { description } = getDispatchToolDef(tmp)
    expect(description).toContain(
      'Use this only when the user asks for a different engine or model vendor'
    )
    expect(description).toContain('use your own task tool instead')
    expect(description).toContain(
      "claude (Anthropic's models), pi (an alternative coding-agent harness) or codex"
    )
  })

  it('falls back to the generic Claude-alias hint when nothing is configured', () => {
    vi.mocked(loadEngineConfig).mockReturnValue({})
    const def = getDispatchToolDef(tmp)
    expect(def.description).toContain('sonnet')
    expect(def.description).toContain('haiku')
    expect(def.description).toContain('No default is configured')
    expect(def.inputSchema.shape.model.description).toContain('alias')
  })

  it('bakes an independent pi model hint alongside the Claude one (ADR-033 M4c)', () => {
    // First call is the Claude hint (loadEngineConfig('claude')), second is
    // pi's (loadEngineConfig('pi')) — see createOpencodeHostedToolsServer's
    // call order.
    vi.mocked(loadEngineConfig)
      .mockReturnValueOnce({
        dispatch: { allowedModels: ['sonnet', 'haiku'], defaultModel: 'sonnet' }
      })
      .mockReturnValueOnce({
        dispatch: {
          allowedModels: ['openai-codex/gpt-5.6-luna'],
          defaultModel: 'openai-codex/gpt-5.6-luna'
        }
      })
    const def = getDispatchToolDef(tmp)
    expect(def.description).toContain('sonnet') // Claude hint survives
    expect(def.description).toContain('openai-codex/gpt-5.6-luna') // pi hint present too
    expect(def.inputSchema.shape.model.description).toContain('openai-codex/gpt-5.6-luna')
  })

  it('falls back to the generic pi "provider/modelId" hint when pi has nothing configured', () => {
    vi.mocked(loadEngineConfig).mockReturnValue({})
    const def = getDispatchToolDef(tmp)
    expect(def.description).toContain('provider/modelId')
  })
})

// ---------------------------------------------------------------------------
// Caller identity on opencode 2.x (ADR-093 §4): _meta first, plugin stamp fallback
// ---------------------------------------------------------------------------

describe('resolveCallerIdentity', () => {
  const META = 'ai.opencode/sessionID'

  it('_meta wins; a matching plugin stamp contributes the call id', () => {
    expect(
      resolveCallerIdentity(
        { [META]: 'ses_a' },
        { __xeng_caller_session: 'ses_a', __xeng_call_id: 'call_1' }
      )
    ).toEqual({ sessionId: 'ses_a', callId: 'call_1', source: 'meta' })
  })

  it('_meta alone (plugin not loaded): the session, no call id', () => {
    expect(resolveCallerIdentity({ [META]: 'ses_a' }, {})).toEqual({
      sessionId: 'ses_a',
      callId: undefined,
      source: 'meta'
    })
  })

  it('a call id without the plugin session stamp is not trusted', () => {
    expect(
      resolveCallerIdentity({ [META]: 'ses_a' }, { __xeng_call_id: 'call_forged' }).callId
    ).toBeUndefined()
  })

  it('stamp and _meta disagree: _meta wins, the call id is dropped, the mismatch flagged', () => {
    expect(
      resolveCallerIdentity(
        { [META]: 'ses_a' },
        { __xeng_caller_session: 'ses_b', __xeng_call_id: 'call_1' }
      )
    ).toEqual({ sessionId: 'ses_a', callId: undefined, source: 'meta', mismatch: true })
  })

  it('no _meta (an engine that does not send it): the plugin stamp is the fallback', () => {
    expect(
      resolveCallerIdentity(undefined, { __xeng_caller_session: 'ses_b', __xeng_call_id: 'call_2' })
    ).toEqual({ sessionId: 'ses_b', callId: 'call_2', source: 'plugin' })
  })

  it('nothing, or only empty/non-string values: no identity', () => {
    expect(resolveCallerIdentity(undefined, {})).toEqual({ source: 'none' })
    expect(resolveCallerIdentity({ [META]: '' }, { __xeng_caller_session: 42 })).toEqual({
      source: 'none'
    })
  })
})

describe('dispatch_agent caller identity through the handler (ADR-093 §4)', () => {
  it('reads the caller from _meta even without the plugin stamp (no call id)', async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'ok', sessionId: 'c-1' }))
    const lookup = vi.fn(() => callerHandle())
    const tool = getDispatchTool(tmp, { lookupCallerSession: lookup, dispatch })
    const result = (await tool.handler(
      { engine: 'claude', prompt: 'x' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_meta' })
    )) as { isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(lookup).toHaveBeenCalledWith('ses_meta')
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromRoutingId: 'ses_meta', toolUseId: undefined })
    )
  })

  it('a stamp that disagrees with _meta cannot redirect the dispatch to another session', async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'ok', sessionId: 'c-1' }))
    const lookup = vi.fn(() => callerHandle())
    const onIdentityMismatch = vi.fn()
    const server = createOpencodeHostedToolsServer(tmp, {
      lookupCallerSession: lookup,
      dispatch,
      onIdentityMismatch
    })
    const tool = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>
      }
    )._registeredTools['dispatch_agent']
    await tool.handler(
      {
        engine: 'claude',
        prompt: 'x',
        __xeng_caller_session: 'ses_other',
        __xeng_call_id: 'call_9'
      },
      makeExtra({ 'ai.opencode/sessionID': 'ses_real' })
    )
    expect(lookup).toHaveBeenCalledWith('ses_real')
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromRoutingId: 'ses_real', toolUseId: undefined })
    )
    expect(onIdentityMismatch).toHaveBeenCalledWith(expect.objectContaining({ mismatch: true }))
  })

  it("a subagent CHILD calling: the dispatch belongs to the ClaudeUI chat it descends from, carrying the child agent's restriction (S9)", async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'ok', sessionId: 'c-1' }))
    const handle = callerHandle()
    const lookup = vi.fn((id: string) => (id === 'ses_root' ? handle : undefined))
    const restriction = { agents: ['custom'], deny: ['Edit', 'Write'], ask: [] }
    const resolveCallerRoot = vi.fn<CallerRootResolver>(async (id) =>
      id === 'ses_child'
        ? { root: 'ses_root', restriction }
        : id === 'ses_unreadable'
          ? { refused: 'ClaudeUI could not read the permission rules of the calling subagent' }
          : undefined
    )
    const tool = getDispatchTool(tmp, { lookupCallerSession: lookup, resolveCallerRoot, dispatch })
    const result = (await tool.handler(
      { engine: 'claude', prompt: 'x' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_child' })
    )) as { isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(resolveCallerRoot).toHaveBeenCalledWith('ses_child')
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fromRoutingId: 'ses_root',
        cwd: handle.cwd,
        callerRestriction: restriction
      })
    )

    // Rules that cannot be read: refused (fail closed), nothing dispatched.
    const unreadable = (await tool.handler(
      { engine: 'claude', prompt: 'x' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_unreadable' })
    )) as { isError?: boolean; content: { text: string }[] }
    expect(unreadable.isError).toBe(true)
    expect(unreadable.content[0].text).toContain('could not read the permission rules')

    // No ClaudeUI ancestor (a dispatch target's own child, a foreign session): refused.
    const orphan = (await tool.handler(
      { engine: 'claude', prompt: 'x' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_orphan' })
    )) as { isError?: boolean; content: { text: string }[] }
    expect(orphan.isError).toBe(true)
    expect(orphan.content[0].text).toContain('could not find the calling session (ses_orphan)')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('a chat calling for itself carries no restriction', async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'ok', sessionId: 'c-1' }))
    const tool = getDispatchTool(tmp, { lookupCallerSession: () => callerHandle(), dispatch })
    await tool.handler(
      { engine: 'claude', prompt: 'x' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_a' })
    )
    expect(dispatch.mock.calls[0][1].callerRestriction).toBeUndefined()
  })

  it('_meta + matching stamp: session from _meta, call id from the stamp', async () => {
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'ok', sessionId: 'c-1' }))
    const tool = getDispatchTool(tmp, { lookupCallerSession: () => callerHandle(), dispatch })
    await tool.handler(
      { engine: 'claude', prompt: 'x', __xeng_caller_session: 'ses_a', __xeng_call_id: 'call_7' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_a' })
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromRoutingId: 'ses_a', toolUseId: 'call_7' })
    )
  })
})

describe('mockup tools with a per-call cwd resolver (one opencode server, many directories)', () => {
  type Handler = (a: Record<string, unknown>, e: unknown) => Promise<unknown>
  const toolsOf = (server: McpServer): Record<string, { handler: Handler }> =>
    (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })
      ._registeredTools

  it("writes under the CALLING session's directory, resolved from _meta per call", async () => {
    const tmp2 = await mkdtemp(join(tmpdir(), 'claudeui-hosted-tools-r-'))
    try {
      const dirs: Record<string, string> = { ses_a: tmp, ses_b: tmp2 }
      const resolver = vi.fn(async (sid: string | undefined) => (sid ? dirs[sid] : undefined))
      const tools = toolsOf(createOpencodeHostedToolsServer(resolver))
      const a = (await tools['create_mockup'].handler(
        { html: '<p>A</p>' },
        makeExtra({ 'ai.opencode/sessionID': 'ses_a' })
      )) as { content: Array<{ text: string }> }
      const b = (await tools['create_mockup'].handler(
        { html: '<p>B</p>' },
        makeExtra({ 'ai.opencode/sessionID': 'ses_b' })
      )) as { content: Array<{ text: string }> }
      const idA = /Directory:\s*(\S+)/.exec(a.content[0].text)![1]
      const idB = /Directory:\s*(\S+)/.exec(b.content[0].text)![1]
      expect(existsSync(join(tmp, '.claude', 'ui', 'mockups', idA, 'index.html'))).toBe(true)
      expect(existsSync(join(tmp2, '.claude', 'ui', 'mockups', idB, 'index.html'))).toBe(true)
      expect(resolver).toHaveBeenCalledWith('ses_a')
    } finally {
      await rm(tmp2, { recursive: true, force: true })
    }
  })

  it('an unresolvable caller is an isError result, never a write to a guessed directory', async () => {
    const tools = toolsOf(createOpencodeHostedToolsServer(async () => undefined))
    const result = (await tools['create_mockup'].handler(
      { html: '<p>x</p>' },
      makeExtra({ 'ai.opencode/sessionID': 'ses_gone' })
    )) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('ses_gone')
  })
})
