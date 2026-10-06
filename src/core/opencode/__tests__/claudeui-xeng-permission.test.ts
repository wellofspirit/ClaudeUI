/**
 * @vitest-environment node
 *
 * The `claudeui-xeng` plugin's permission and MCP hooks (ADR-093 §3, S6):
 * saved "always" allows never answer a ClaudeUI ask (the hook only TIGHTENS
 * opencode's effect to what the configured rules say), and every MCP server is
 * declared directly (`codemode: false`). Loaded as opencode loads it — a plain
 * ES module — against a fake plugin context.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'resources',
  'opencode',
  'claudeui-xeng',
  'index.js'
)

type Effect = 'allow' | 'ask' | 'deny'
interface Rule {
  action: string
  resource: string
  effect: Effect
}
interface EvaluateEvent {
  sessionID: string
  agent?: string
  action: string
  resources: string[]
  effect: Effect
  message?: string
}
interface PluginModule {
  default: { setup: (ctx: unknown) => Promise<void> }
  evaluateConfigured: (
    rules: Rule[],
    action: string,
    resources: string[],
    platform?: string
  ) => Effect
  stricter: (a: string, b: string) => Effect
  wildcardMatch: (input: string, pattern: string, platform?: string) => boolean
}

const mod = async () => (await import(pathToFileURL(FILE).href)) as PluginModule
const r = (action: string, effect: Effect, resource = '*'): Rule => ({ action, resource, effect })

const AGENT_BUILD = [r('*', 'allow'), r('external_directory', 'ask')]

interface Fake {
  evaluate: (event: EvaluateEvent) => Promise<void>
  mcpTransform: (editor: { list: () => [string, Record<string, unknown>][] }) => void
  guard: () => Promise<{ permissionHook: boolean; mcpDirect: boolean }>
  calls: string[]
}

/** Sets the plugin up against a fake context whose session/agent reads are scripted. */
async function setup(opts: {
  session?: { agent?: string; permissions?: Rule[] }
  agents?: Record<string, Rule[]>
  defaultAgent?: string
  failReads?: boolean
}): Promise<Fake> {
  const plugin = (await mod()).default
  const calls: string[] = []
  let evaluate: Fake['evaluate'] | undefined
  let guard: Fake['guard'] | undefined
  let mcpTransform: Fake['mcpTransform'] | undefined
  const agents = opts.agents ?? { build: AGENT_BUILD }
  const fail = () => {
    if (opts.failReads) throw new Error('read failed')
  }
  await plugin.setup({
    tool: { hook: async () => ({}), list: async () => [] },
    rpc: {
      register: async (_def: unknown, handlers: { guard: Fake['guard'] }) => {
        guard = handlers.guard
        return {}
      }
    },
    permission: {
      hook: async (name: string, cb: Fake['evaluate']) => {
        if (name === 'evaluate') evaluate = cb
        return {}
      }
    },
    mcp: {
      transform: async (cb: Fake['mcpTransform']) => {
        mcpTransform = cb
        return {}
      }
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`session.get ${sessionID}`)
        fail()
        return { data: { id: sessionID, ...opts.session } }
      }
    },
    agent: {
      get: async ({ agentID }: { agentID: string }) => {
        calls.push(`agent.get ${agentID}`)
        fail()
        const permissions = agents[agentID]
        return { data: permissions ? { id: agentID, permissions } : undefined }
      },
      list: async () => {
        calls.push('agent.list')
        fail()
        const first = opts.defaultAgent ?? 'build'
        return {
          data: [first, ...Object.keys(agents).filter((id) => id !== first)].map((id) => ({
            id,
            permissions: agents[id]
          }))
        }
      }
    }
  })
  return { evaluate: evaluate!, mcpTransform: mcpTransform!, guard: guard!, calls }
}

const event = (over: Partial<EvaluateEvent>): EvaluateEvent => ({
  sessionID: 'ses_1',
  action: 'shell',
  resources: ['echo hi'],
  effect: 'allow',
  ...over
})

describe('saved allows never answer a ClaudeUI ask (permission.evaluate)', () => {
  it('opencode allowed only because of a saved row → back to ask', async () => {
    const fake = await setup({ session: { permissions: [r('shell', 'ask')] } })
    const e = event({ agent: 'build' })
    await fake.evaluate(e)
    expect(e.effect).toBe('ask')
    expect(fake.calls).toEqual(['session.get ses_1', 'agent.get build'])
  })

  it('an allow the configured rules give stays an allow', async () => {
    const fake = await setup({
      session: { permissions: [r('shell', 'ask'), r('shell', 'allow', 'echo *')] }
    })
    const e = event({ agent: 'build' })
    await fake.evaluate(e)
    expect(e.effect).toBe('allow')
  })

  it('every resource counts: one asked statement makes the call ask', async () => {
    const fake = await setup({
      session: { permissions: [r('shell', 'ask'), r('shell', 'allow', 'echo *')] }
    })
    const e = event({ agent: 'build', resources: ['echo hi', 'git push'] })
    await fake.evaluate(e)
    expect(e.effect).toBe('ask')
  })

  it('never loosens: an ask stays an ask even when the configured rules allow', async () => {
    const fake = await setup({ session: { permissions: [] } })
    const e = event({ agent: 'build', effect: 'ask' })
    await fake.evaluate(e)
    expect(e.effect).toBe('ask')
  })

  it('a deny opencode decided is left alone (no reads at all)', async () => {
    const fake = await setup({ session: { permissions: [] } })
    const e = event({ effect: 'deny' })
    await fake.evaluate(e)
    expect(e.effect).toBe('deny')
    expect(fake.calls).toEqual([])
  })

  it('the agent comes from the event, else the session, else opencode’s default agent', async () => {
    const agents = { build: AGENT_BUILD, plan: [r('*', 'allow'), r('edit', 'deny')] }
    const viaSession = await setup({ session: { agent: 'plan', permissions: [] }, agents })
    const e1 = event({ action: 'edit', resources: ['a.ts'] })
    await viaSession.evaluate(e1)
    expect(e1.effect).toBe('deny')
    expect(viaSession.calls).toContain('agent.get plan')

    const viaDefault = await setup({ session: { permissions: [] }, agents, defaultAgent: 'plan' })
    const e2 = event({ action: 'edit', resources: ['a.ts'] })
    await viaDefault.evaluate(e2)
    expect(e2.effect).toBe('deny')
    expect(viaDefault.calls).toContain('agent.list')
  })

  it('an agent opencode cannot resolve counts as deny-all, as opencode treats it', async () => {
    const fake = await setup({ session: { permissions: [] } })
    const e = event({ agent: 'ghost' })
    await fake.evaluate(e)
    expect(e.effect).toBe('deny')
  })

  it('a failed read answers ask (toward the human), never looser than opencode', async () => {
    const fake = await setup({ failReads: true })
    const allowed = event({})
    await fake.evaluate(allowed)
    expect(allowed.effect).toBe('ask')
  })

  it.each([
    ['allow', 'allow', 'allow'],
    ['allow', 'ask', 'ask'],
    ['allow', 'deny', 'deny'],
    ['ask', 'allow', 'ask'],
    ['ask', 'deny', 'deny'],
    ['deny', 'allow', 'deny'],
    ['allow', 'bogus', 'ask']
  ])('stricter(%s, %s) = %s', async (a, b, expected) => {
    expect((await mod()).stricter(a, b)).toBe(expected)
  })
})

describe('evaluateConfigured / wildcardMatch (opencode semantics)', () => {
  it('last match wins; no match is ask; a trailing ` *` also matches the bare command', async () => {
    const { evaluateConfigured } = await mod()
    const rules = [r('*', 'allow'), r('shell', 'ask'), r('shell', 'allow', 'ls *')]
    expect(evaluateConfigured(rules, 'shell', ['ls'], 'linux')).toBe('allow')
    expect(evaluateConfigured(rules, 'shell', ['ls -la'], 'linux')).toBe('allow')
    expect(evaluateConfigured(rules, 'shell', ['rm x'], 'linux')).toBe('ask')
    expect(evaluateConfigured([], 'read', ['a'], 'linux')).toBe('ask')
    expect(evaluateConfigured(rules, 'read', [], 'linux')).toBe('allow')
  })

  it('regex metacharacters are literal; `\\` folds to `/`; case folds on win32 only', async () => {
    const { wildcardMatch } = await mod()
    expect(wildcardMatch('a.b', 'a.b', 'linux')).toBe(true)
    expect(wildcardMatch('axb', 'a.b', 'linux')).toBe(false)
    expect(wildcardMatch('x\\y.ts', 'x/*.ts', 'linux')).toBe(true)
    expect(wildcardMatch('A', 'a', 'win32')).toBe(true)
    expect(wildcardMatch('A', 'a', 'linux')).toBe(false)
  })
})

describe('MCP servers are declared directly (codemode: false)', () => {
  it('every resolved server, whatever its own setting, without touching anything else', async () => {
    const fake = await setup({})
    const servers: [string, Record<string, unknown>][] = [
      ['mine', { type: 'local', command: ['x'], environment: { TOKEN: 's' } }],
      ['coded', { type: 'remote', url: 'https://x', codemode: true }],
      ['claudeui', { type: 'remote', url: 'http://127.0.0.1/mcp', codemode: false }]
    ]
    fake.mcpTransform({ list: () => servers })
    expect(servers.map(([, s]) => s.codemode)).toEqual([false, false, false])
    expect(servers[0][1]).toEqual({
      type: 'local',
      command: ['x'],
      environment: { TOKEN: 's' },
      codemode: false
    })
  })
})

describe('the `guard` RPC (ClaudeUI refuses a server without the hooks)', () => {
  it('reports both hooks once setup registered them', async () => {
    const fake = await setup({})
    expect(await fake.guard()).toEqual({ permissionHook: true, mcpDirect: true })
  })
})
