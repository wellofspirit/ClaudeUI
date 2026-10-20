/**
 * @vitest-environment node
 *
 * The session tools on opencode's hosted `claudeui` MCP server (slice 2): driven
 * through a real MCP client over an in-memory transport, so the tool list, the
 * server `instructions` and the `_meta` opencode stamps on every `tools/call` travel
 * the way they do on the wire. The service behind the tools is a spy: what it is
 * called with (the caller) is the subject; its own rules are tested with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  SESSION_TOOL_NAMES,
  sessionToolDescriptions,
  sessionToolsGuidance
} from '../../../shared/session-tools-description'
import { SESSION_TOOL_SHAPES } from '../../services/session-tool-specs'
import type { SessionToolCaller } from '../../services/session-tools'

vi.mock('../../services/ui-config', () => ({ loadEngineConfig: vi.fn(() => ({})) }))

import {
  createOpencodeHostedToolsServer,
  OPENCODE_SESSION_META_KEY,
  type CallerRootResolver,
  type CallerSessionHandle,
  type HostedSessionTools
} from '../opencode-hosted-tools'

const handle = (over: Partial<CallerSessionHandle> = {}): CallerSessionHandle => ({
  cwd: '/proj',
  getAutonomyMode: () => 'default',
  getMessages: () => [],
  emit: vi.fn(),
  addDispatchedCost: vi.fn(),
  ...over
})

interface Rig {
  client: Client
  run: ReturnType<typeof vi.fn<HostedSessionTools['run']>>
}

const open: Client[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()))
})

async function connect(
  deps: {
    lookupCallerSession?: (id: string) => CallerSessionHandle | undefined
    resolveCallerRoot?: CallerRootResolver
    sessionTools?: boolean
    xAgentCaller?: (id: string) => SessionToolCaller | undefined
  } = {}
): Promise<Rig> {
  const run = vi.fn<HostedSessionTools['run']>(async () => ({ text: 'the answer' }))
  const server: McpServer = createOpencodeHostedToolsServer('/proj', {
    lookupCallerSession: deps.lookupCallerSession,
    resolveCallerRoot: deps.resolveCallerRoot,
    ...(deps.xAgentCaller ? { xAgentCaller: deps.xAgentCaller } : {}),
    ...(deps.sessionTools === false ? {} : { sessionTools: { run } })
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'opencode', version: '2.0.26' })
  open.push(client)
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return { client, run }
}

/** What opencode 2.x does on every `tools/call` (`core/src/mcp/client.ts`). */
const call = (
  rig: Rig,
  name: string,
  args: Record<string, unknown>,
  sessionID?: string
): ReturnType<Client['callTool']> =>
  rig.client.callTool({
    name,
    arguments: args,
    ...(sessionID ? { _meta: { [OPENCODE_SESSION_META_KEY]: sessionID } } : {})
  })

describe('the session tools on the hosted claudeui server', () => {
  it('lists the nine session_* tools beside the existing ones, with the shared descriptions and schemas', async () => {
    const rig = await connect()
    const { tools } = await rig.client.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([...SESSION_TOOL_NAMES]))
    expect(names).toEqual(expect.arrayContaining(['dispatch_agent', 'render_mermaid']))
    const descriptions = sessionToolDescriptions({})
    for (const name of SESSION_TOOL_NAMES) {
      const tool = tools.find((candidate) => candidate.name === name)!
      expect(tool.description, name).toBe(descriptions[name])
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort(), name).toEqual(
        Object.keys(SESSION_TOOL_SHAPES[name]).sort()
      )
    }
    // opencode prefixes the server name: nothing here carries the prefix itself.
    expect(names.some((name) => name.startsWith('claudeui_'))).toBe(false)
  })

  it('carries the guidance as the MCP server instructions, spelled with the claudeui_ prefix', async () => {
    const rig = await connect()
    expect(rig.client.getInstructions()).toBe(sessionToolsGuidance({ toolPrefix: 'claudeui_' }))
    expect(rig.client.getInstructions()).toContain('`claudeui_session_start`')
  })

  it('registers none of them, and no instructions, when the host wired no session tools', async () => {
    const rig = await connect({ sessionTools: false })
    const { tools } = await rig.client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_mockup',
      'dispatch_agent',
      'render_mermaid',
      'show_mockup'
    ])
    expect(rig.client.getInstructions()).toBeUndefined()
  })

  it('a call from a ClaudeUI chat reaches the service as its root agent, with the live mode and cwd', async () => {
    let mode = 'default'
    const rig = await connect({
      lookupCallerSession: (id) =>
        id === 'ses_root' ? handle({ cwd: '/work/app', getAutonomyMode: () => mode }) : undefined
    })
    const first = await call(rig, 'session_list', { scope: 'project' }, 'ses_root')
    expect(first).toMatchObject({ content: [{ type: 'text', text: 'the answer' }] })
    expect(first.isError).toBeFalsy()
    mode = 'plan'
    await call(rig, 'session_message', { session: 's-abc123', message: 'hi' }, 'ses_root')

    expect(rig.run).toHaveBeenCalledTimes(2)
    const [caller, tool, input] = rig.run.mock.calls[0]
    expect(caller).toMatchObject({
      routingId: 'ses_root',
      engine: 'opencode',
      cwd: '/work/app',
      permissionMode: 'default'
    })
    expect(await (caller as SessionToolCaller).callOwner!(undefined)).toBe('root')
    expect(tool).toBe('session_list')
    expect(input).toEqual({ scope: 'project' })
    // The mode is read at the call, not when the server was built.
    expect(rig.run.mock.calls[1][0].permissionMode).toBe('plan')
    expect(rig.run.mock.calls[1][1]).toBe('session_message')
  })

  it('a service error result comes back as a tool error', async () => {
    const rig = await connect({ lookupCallerSession: () => handle() })
    rig.run.mockResolvedValueOnce({ text: 'Refused: nope', isError: true })
    const out = await call(rig, 'session_stop', { session: 's-a' }, 'ses_root')
    expect(out.isError).toBe(true)
    expect(out.content).toEqual([{ type: 'text', text: 'Refused: nope' }])
  })

  it('a subagent child resolves to the chat it descends from and is attributed as a subagent', async () => {
    const lookup = vi.fn((id: string) => (id === 'ses_root' ? handle() : undefined))
    const resolveCallerRoot = vi.fn<CallerRootResolver>(async () => ({
      root: 'ses_root',
      restriction: undefined
    }))
    const rig = await connect({ lookupCallerSession: lookup, resolveCallerRoot })
    await call(rig, 'session_start', { prompt: 'x' }, 'ses_child')
    expect(resolveCallerRoot).toHaveBeenCalledWith('ses_child')
    const [caller] = rig.run.mock.calls[0]
    expect(caller.routingId).toBe('ses_root')
    expect(await caller.callOwner!(undefined)).toBe('subagent')
  })

  describe('fails closed: nothing reaches the service for a caller that is not a root agent', () => {
    it('no _meta session id', async () => {
      const rig = await connect({ lookupCallerSession: () => handle() })
      const out = await call(rig, 'session_start', { prompt: 'x' })
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.content)).toContain('could not identify the calling session')
      expect(rig.run).not.toHaveBeenCalled()
    })

    it('a session ClaudeUI never created (a dispatch target: no chat, no parent chain)', async () => {
      const rig = await connect({
        lookupCallerSession: () => undefined,
        resolveCallerRoot: async () => undefined
      })
      const out = await call(
        rig,
        'session_message',
        { session: 's-a', message: 'hi' },
        'ses_target'
      )
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.content)).toContain('is not one')
      expect(rig.run).not.toHaveBeenCalled()
    })

    it('no resolver at all', async () => {
      const rig = await connect({ lookupCallerSession: () => undefined })
      const out = await call(rig, 'session_stop', { session: 's-a' }, 'ses_x')
      expect(out.isError).toBe(true)
      expect(rig.run).not.toHaveBeenCalled()
    })

    it('a child whose agent rules cannot be read is refused with that reason', async () => {
      const rig = await connect({
        lookupCallerSession: () => undefined,
        resolveCallerRoot: async () => ({ refused: 'ClaudeUI could not read the rules.' })
      })
      const out = await call(rig, 'session_start', { prompt: 'x' }, 'ses_child')
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.content)).toContain('ClaudeUI could not read the rules.')
      expect(rig.run).not.toHaveBeenCalled()
    })

    it('a resolver that throws is treated as an unknown caller', async () => {
      const rig = await connect({
        lookupCallerSession: () => undefined,
        resolveCallerRoot: async () => {
          throw new Error('server gone')
        }
      })
      const out = await call(rig, 'session_start', { prompt: 'x' }, 'ses_child')
      expect(out.isError).toBe(true)
      expect(rig.run).not.toHaveBeenCalled()
    })

    it('a child whose root chat is no longer live', async () => {
      const rig = await connect({
        lookupCallerSession: () => undefined,
        resolveCallerRoot: async () => ({ root: 'ses_gone', restriction: undefined })
      })
      const out = await call(rig, 'session_start', { prompt: 'x' }, 'ses_child')
      expect(out.isError).toBe(true)
      expect(rig.run).not.toHaveBeenCalled()
    })
  })

  it('the plugin stamp is not a source of identity for these tools: an arg cannot name the caller', async () => {
    const rig = await connect({ lookupCallerSession: () => handle() })
    // `__xeng_caller_session` is dispatch_agent's stamp; zod strips it from these tools' args.
    const out = await call(rig, 'session_start', { prompt: 'x', __xeng_caller_session: 'ses_root' })
    expect(out.isError).toBe(true)
    expect(rig.run).not.toHaveBeenCalled()
  })
})

describe('session_message from a dispatch target (ADR-105 §4)', () => {
  const xAgent: SessionToolCaller = {
    routingId: 'ses_target',
    engine: 'opencode',
    cwd: '/repo',
    permissionMode: 'acceptEdits',
    xAgent: { ledgerId: 's-abc123' }
  }
  const xAgentCaller = (id: string): SessionToolCaller | undefined =>
    id === 'ses_target' ? xAgent : undefined

  it('a call from the target’s own session reaches the service as the X-Agent, whatever else the lookups say', async () => {
    const rig = await connect({
      xAgentCaller,
      // Not a ClaudeUI chat: without the X-Agent branch this call would be refused.
      lookupCallerSession: () => undefined
    })
    const out = await call(
      rig,
      'session_message',
      { session: 'origin', message: 'hi' },
      'ses_target'
    )
    expect(out.isError).toBeFalsy()
    expect(rig.run).toHaveBeenCalledTimes(1)
    expect(rig.run.mock.calls[0]).toEqual([
      xAgent,
      'session_message',
      { session: 'origin', message: 'hi' }
    ])
  })

  it('only session_message: another session tool from the target’s session is refused, nothing runs', async () => {
    const rig = await connect({ xAgentCaller, lookupCallerSession: () => undefined })
    const out = await call(rig, 'session_start', { title: 't' }, 'ses_target')
    expect(out.isError).toBe(true)
    expect(rig.run).not.toHaveBeenCalled()
  })

  it('a subagent child of the target, or any other session, is not an X-Agent', async () => {
    const rig = await connect({ xAgentCaller, lookupCallerSession: () => undefined })
    const out = await call(
      rig,
      'session_message',
      { session: 'origin', message: 'hi' },
      'ses_child'
    )
    expect(out.isError).toBe(true)
    expect(rig.run).not.toHaveBeenCalled()
  })

  it('without the injected lookup nothing changes: the target’s call is refused', async () => {
    const rig = await connect({ lookupCallerSession: () => undefined })
    const out = await call(
      rig,
      'session_message',
      { session: 'origin', message: 'hi' },
      'ses_target'
    )
    expect(out.isError).toBe(true)
    expect(rig.run).not.toHaveBeenCalled()
  })
})
