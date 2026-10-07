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

async function load(tools: string[] = []): Promise<{
  plugin: Plugin
  hooks: Record<string, Hook>
  rpc: { definition: RpcDefinition; handlers: Record<string, (input: unknown) => Promise<unknown>> }
}> {
  const plugin = (await import(pathToFileURL(join(DIR, 'index.js')).href)).default as Plugin
  const hooks: Record<string, Hook> = {}
  let rpc: Awaited<ReturnType<typeof load>>['rpc'] | undefined
  await plugin.setup({
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
