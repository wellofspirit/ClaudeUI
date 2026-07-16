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
import type { CallerSessionHandle, DispatchAgentFn } from '../opencode-hosted-tools'
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
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools

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
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools

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
      const toolsA = (serverA as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools
      const toolsB = (serverB as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools

      const resultA = (await toolsA['create_mockup'].handler({ html: '<p>A</p>' })) as { content: Array<{ type: string; text: string }> }
      const resultB = (await toolsB['create_mockup'].handler({ html: '<p>B</p>' })) as { content: Array<{ type: string; text: string }> }

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

function makeExtra(): { signal: AbortSignal; sendNotification: ReturnType<typeof vi.fn> } {
  return { signal: new AbortController().signal, sendNotification: vi.fn(async () => {}) }
}

function getDispatchTool(
  tmp: string,
  deps: { lookupCallerSession?: (id: string) => CallerSessionHandle | undefined; dispatch?: DispatchAgentFn }
): { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> } {
  const server = createOpencodeHostedToolsServer(tmp, deps)
  return (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }>
    }
  )._registeredTools['dispatch_agent']
}

describe('createOpencodeHostedToolsServer — dispatch_agent (ADR-033 M2)', () => {
  it('missing __xeng_caller_session → isError mentioning the caller-identity plugin', async () => {
    const tool = getDispatchTool(tmp, {})
    const result = (await tool.handler({ engine: 'claude', prompt: 'x' }, makeExtra())) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('claudeui-xeng-plugin')
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
        autonomyMode: 'default',
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
    const addDispatchedCost = vi.fn()
    const dispatch = vi.fn<DispatchAgentFn>(async () => ({ text: 'the review', sessionId: 'claude-42' }))
    const tool = getDispatchTool(tmp, {
      lookupCallerSession: (id) => {
        expect(id).toBe('ses_caller')
        return { cwd: '/proj', autonomyMode: 'acceptEdits', emit, addDispatchedCost }
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
        autonomyMode: 'acceptEdits',
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
        autonomyMode: 'default',
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
        autonomyMode: 'default',
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

  it('falls back to the generic Claude-alias hint when nothing is configured', () => {
    vi.mocked(loadEngineConfig).mockReturnValue({})
    const def = getDispatchToolDef(tmp)
    expect(def.description).toContain('sonnet')
    expect(def.description).toContain('haiku')
    expect(def.description).toContain('No default is configured')
    expect(def.inputSchema.shape.model.description).toContain('alias')
  })
})
