/**
 * @vitest-environment node
 *
 * The opencode 2.x `claudeui-xeng` DIRECTORY plugin (ADR-097 §4):
 * `resources/opencode/claudeui-xeng/index.js`. It runs inside the EXTERNAL
 * opencode process, so it is loaded here the way opencode loads it — as a
 * plain ES module — against a fake plugin context.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIR = join(__dirname, '..', '..', '..', '..', 'resources', 'opencode', 'claudeui-xeng')

interface HookEvent {
  tool: string
  sessionID: string
  id?: string
  input: unknown
}
type Hook = (event: HookEvent) => Promise<void>
interface RpcDefinition {
  id: string
  methods: Record<string, { input: unknown; output: unknown }>
  events: Record<string, unknown>
}
interface Plugin {
  id: string
  setup: (ctx: unknown) => Promise<void>
}

interface Extra {
  options?: unknown
  session?: unknown
  agent?: unknown
}

async function load(
  tools: string[] = [],
  extra: Extra = {}
): Promise<{
  plugin: Plugin
  hooks: Record<string, Hook>
  rpc: { definition: RpcDefinition; handlers: Record<string, (input: unknown) => Promise<unknown>> }
}> {
  const plugin = (await import(pathToFileURL(join(DIR, 'index.js')).href)).default as Plugin
  const hooks: Record<string, Hook> = {}
  let rpc: Awaited<ReturnType<typeof load>>['rpc'] | undefined
  await plugin.setup({
    ...extra,
    tool: {
      hook: async (name: string, cb: Hook) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
      list: async () => tools.map((id) => ({ id }))
    },
    // Exercised in claudeui-xeng-permission.test.ts.
    permission: { hook: async () => ({ dispose: async () => {} }) },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    rpc: {
      register: async (
        definition: RpcDefinition,
        handlers: Record<string, () => Promise<unknown>>
      ) => {
        rpc = { definition, handlers }
        return { dispose: async () => {}, events: { emit: async () => {} } }
      }
    }
  })
  return { plugin, hooks, rpc: rpc! }
}

describe('claudeui-xeng plugin (opencode 2.x directory plugin)', () => {
  it('is a directory plugin: index.js + a module package.json, import-free', () => {
    const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'))
    expect(pkg).toMatchObject({ type: 'module', main: 'index.js' })
    const source = readFileSync(join(DIR, 'index.js'), 'utf8')
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\(/)
  })

  it('exports { id, setup } — the Promise-API module shape', async () => {
    const { plugin } = await load()
    expect(plugin.id).toBe('claudeui-xeng')
    expect(typeof plugin.setup).toBe('function')
  })

  it('stamps the caller session and the call id into claudeui_dispatch_agent input', async () => {
    const { hooks } = await load()
    const original = { engine: 'claude', prompt: 'x' }
    const event: HookEvent = {
      tool: 'claudeui_dispatch_agent',
      sessionID: 'ses_1',
      id: 'call_1',
      input: original
    }
    await hooks['execute.before'](event)
    expect(event.input).toEqual({
      engine: 'claude',
      prompt: 'x',
      __xeng_caller_session: 'ses_1',
      __xeng_call_id: 'call_1'
    })
    // A replacement object: what opencode stores (the model's input) is untouched.
    expect(original).toEqual({ engine: 'claude', prompt: 'x' })
  })

  it('omits the call id when the event has none', async () => {
    const { hooks } = await load()
    const event: HookEvent = { tool: 'claudeui_dispatch_agent', sessionID: 'ses_1', input: {} }
    await hooks['execute.before'](event)
    expect(event.input).toEqual({ __xeng_caller_session: 'ses_1' })
  })

  it("leaves every other tool's input alone (incl. other hosted tools)", async () => {
    const { hooks } = await load()
    for (const tool of ['read', 'shell', 'claudeui_create_mockup', 'fx_dispatch_agent']) {
      const input = { path: '/etc/hosts' }
      const event: HookEvent = { tool, sessionID: 'ses_1', id: 'c', input }
      await hooks['execute.before'](event)
      expect(event.input).toBe(input)
    }
  })

  it('tolerates a missing or non-object input', async () => {
    const { hooks } = await load()
    const event: HookEvent = {
      tool: 'claudeui_dispatch_agent',
      sessionID: 's',
      id: 'c',
      input: null
    }
    await hooks['execute.before'](event)
    expect(event.input).toEqual({ __xeng_caller_session: 's', __xeng_call_id: 'c' })
  })

  it('registers the readiness RPC: claudeui-xeng.tools lists registered claudeui_* tools, sorted', async () => {
    const { rpc } = await load([
      'read',
      'claudeui_show_mockup',
      'claudeui_dispatch_agent',
      'fx_echo',
      'claudeui_create_mockup'
    ])
    expect(rpc.definition.id).toBe('claudeui-xeng')
    expect(Object.keys(rpc.definition.methods)).toEqual(['tools', 'guard'])
    expect(rpc.definition.events).toEqual({})
    await expect(rpc.handlers.tools({})).resolves.toEqual({
      tools: ['claudeui_create_mockup', 'claudeui_dispatch_agent', 'claudeui_show_mockup']
    })
  })
})

// ── The subagent model gate (ADR-111) ───────────────────────────────────────

type Model = { providerID: string; id: string; variant?: string }
interface Scripted {
  /** `agent.get` answers by agent id (a missing id throws, like opencode's 404). */
  agents?: Record<string, { model?: Model }>
  /** `session.get` answers by session id. */
  sessions?: Record<string, { agent?: string; model?: Model }>
  options?: unknown
}

/** The plugin against a fake opencode whose agent/session reads are scripted and counted. */
async function gate(scripted: Scripted) {
  const reads: string[] = []
  const { hooks, rpc } = await load([], {
    options: scripted.options,
    agent: {
      get: async ({ agentID }: { agentID: string }) => {
        reads.push(`agent ${agentID}`)
        const agent = scripted.agents?.[agentID]
        if (!agent) throw new Error('Agent not found')
        return { data: agent }
      }
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        reads.push(`session ${sessionID}`)
        const session = scripted.sessions?.[sessionID]
        if (!session) throw new Error('Session not found')
        return { data: session }
      }
    }
  })
  const call = (input: unknown, tool = 'subagent') => {
    const event: HookEvent = { tool, sessionID: 'ses_parent', id: 'call_1', input }
    return { event, run: () => hooks['execute.before'](event) }
  }
  return { call, reads, rpc }
}

const OPTIONS = { modelAllowlist: { openai: ['gpt-a', 'gpt-b'], anthropic: [] } }
const m = (providerID: string, id: string, variant?: string): Model => ({
  providerID,
  id,
  ...(variant ? { variant } : {})
})

describe('claudeui-xeng plugin: subagent model gate', () => {
  it('refuses an off-list call model with the allowed ids and the way out', async () => {
    const { call } = await gate({ options: OPTIONS })
    const { run } = call({ agent: 'general', prompt: 'x', model: 'openai/gpt-z#high' })
    await expect(run()).rejects.toThrow(
      'Model "openai/gpt-z" is not allowed by ClaudeUI\'s model allowlist. Allowed for "openai": gpt-a, gpt-b. ' +
        'Call claudeui_list_models to see the models you may use, or omit the model parameter to use your own model.'
    )
  })

  it('a provider restricted to nothing refuses every model of it', async () => {
    const { call } = await gate({ options: OPTIONS })
    await expect(call({ agent: 'general', model: 'anthropic/claude-x' }).run()).rejects.toThrow(
      'Allowed for "anthropic": (none).'
    )
  })

  it('passes an allowed call model (variant ignored) and a provider without an entry; the input is untouched', async () => {
    const { call, reads } = await gate({ options: OPTIONS })
    for (const model of ['openai/gpt-a', 'openai/gpt-b#high', 'local/anything']) {
      const input = { agent: 'general', prompt: 'x', model }
      const { event, run } = call(input)
      await run()
      expect(event.input).toBe(input)
    }
    // An explicit model needs no read from opencode.
    expect(reads).toEqual([])
  })

  it('an empty allowlist restricts nothing and reads nothing, with or without a model', async () => {
    const { call, reads } = await gate({
      options: { modelAllowlist: {} },
      agents: { general: { model: m('openai', 'gpt-z') } }
    })
    await call({ agent: 'general', model: 'openai/gpt-z' }).run()
    await call({ agent: 'general' }).run()
    expect(reads).toEqual([])
  })

  it('no model anywhere (the agent has none, no call model): inherits the gated parent model', async () => {
    const { call, reads } = await gate({ options: OPTIONS, agents: { general: {} } })
    await call({ agent: 'general', prompt: 'x' }).run()
    // opencode strips an empty model/sessionID before this hook, but be robust to both.
    await call({ agent: 'general', model: '', sessionID: '' }).run()
    expect(reads).toEqual(['agent general', 'agent general'])
  })

  it('refuses an agent pinned to an off-list model, allows an allowed or unrestricted one, reads the TARGET agent', async () => {
    const { call, reads } = await gate({
      options: OPTIONS,
      agents: {
        pinned: { model: m('openai', 'gpt-z', 'high') },
        fine: { model: m('openai', 'gpt-a') },
        free: { model: m('local', 'x') }
      }
    })
    await expect(call({ agent: 'pinned', prompt: 'x' }).run()).rejects.toThrow(
      'Agent "pinned" runs on model "openai/gpt-z", which ClaudeUI\'s model allowlist does not allow. ' +
        'Pass an allowed model with the model parameter (claudeui_list_models lists them), or choose another agent.'
    )
    await call({ agent: 'fine' }).run()
    await call({ agent: 'free' }).run()
    expect(reads).toEqual(['agent pinned', 'agent fine', 'agent free'])
  })

  it("an allowed call model wins over an off-list agent model (the agent's model is not consulted)", async () => {
    const { call, reads } = await gate({
      options: OPTIONS,
      agents: { pinned: { model: m('openai', 'gpt-z') } }
    })
    await call({ agent: 'pinned', model: 'openai/gpt-a' }).run()
    expect(reads).toEqual([])
  })

  it('resume with the SAME agent checks the child session model, not the agent model', async () => {
    const { call, reads } = await gate({
      options: OPTIONS,
      agents: { general: { model: m('openai', 'gpt-a') } },
      sessions: {
        ses_off: { agent: 'general', model: m('openai', 'gpt-z') },
        ses_ok: { agent: 'general', model: m('openai', 'gpt-b') }
      }
    })
    await expect(
      call({ agent: 'general', sessionID: 'ses_off', prompt: 'x' }).run()
    ).rejects.toThrow('runs on model "openai/gpt-z"')
    await call({ agent: 'general', sessionID: 'ses_ok', prompt: 'x' }).run()
    // The agent (allowed model) is never read for a same-agent resume.
    expect(reads).toEqual(['session ses_off', 'session ses_ok'])
  })

  it('resume with a DIFFERENT agent takes that agent model: an off-list session model is then irrelevant', async () => {
    const { call } = await gate({
      options: OPTIONS,
      agents: { good: { model: m('openai', 'gpt-a') }, bad: { model: m('openai', 'gpt-z') } },
      sessions: { ses_1: { agent: 'general', model: m('openai', 'gpt-z') } }
    })
    await call({ agent: 'good', sessionID: 'ses_1' }).run()
    await expect(call({ agent: 'bad', sessionID: 'ses_1' }).run()).rejects.toThrow(
      'Agent "bad" runs on model "openai/gpt-z"'
    )
  })

  it('an explicit call model wins over a resumed session (and reads nothing)', async () => {
    const { call, reads } = await gate({
      options: OPTIONS,
      sessions: { ses_1: { agent: 'general', model: m('openai', 'gpt-z') } }
    })
    await call({ agent: 'general', sessionID: 'ses_1', model: 'openai/gpt-a' }).run()
    expect(reads).toEqual([])
  })

  it('missing or malformed options + a model to check: refuse; an inheriting call passes', async () => {
    const unavailable =
      "ClaudeUI's model allowlist is unavailable; omit the model parameter to use your own model."
    for (const options of [
      undefined,
      {},
      { modelAllowlist: 'openai' },
      { modelAllowlist: [] },
      { modelAllowlist: { openai: 'gpt-a' } },
      { modelAllowlist: { openai: [1] } }
    ]) {
      const { call } = await gate({
        options,
        agents: { pinned: { model: m('openai', 'gpt-a') }, plain: {} }
      })
      await expect(call({ agent: 'plain', model: 'openai/gpt-a' }).run()).rejects.toThrow(
        unavailable
      )
      await expect(call({ agent: 'pinned' }).run()).rejects.toThrow(unavailable)
      await call({ agent: 'plain' }).run()
    }
  })

  it('a failed agent/session read refuses the call (fail closed) with the way out', async () => {
    const { call } = await gate({ options: OPTIONS })
    await expect(call({ agent: 'ghost', prompt: 'x' }).run()).rejects.toThrow(
      'could not read agent "ghost"'
    )
    await expect(call({ agent: 'general', sessionID: 'ses_ghost' }).run()).rejects.toThrow(
      'could not read the resumed subagent session'
    )
  })

  it('never touches any other tool (a model-looking input passes, nothing is read)', async () => {
    const { call, reads } = await gate({ options: OPTIONS })
    for (const tool of ['read', 'task', 'claudeui_create_mockup', 'opencode_models']) {
      const input = { model: 'openai/gpt-z' }
      const { event, run } = call(input, tool)
      await run()
      expect(event.input).toBe(input)
    }
    expect(reads).toEqual([])
  })

  it('keeps the dispatch stamping next to the gate', async () => {
    const { call } = await gate({ options: OPTIONS })
    const { event, run } = call({ engine: 'claude' }, 'claudeui_dispatch_agent')
    await run()
    expect(event.input).toMatchObject({ __xeng_caller_session: 'ses_parent' })
  })

  it('the guard RPC reports the gate (the plugin registered it)', async () => {
    const { rpc } = await gate({ options: OPTIONS })
    await expect(rpc.handlers.guard({})).resolves.toMatchObject({ modelGate: true })
    const required = (rpc.definition.methods.guard.output as { required: string[] }).required
    expect(required).toContain('modelGate')
  })
})
