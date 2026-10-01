import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/usage-recorder', () => ({ recordUsageEvent: vi.fn() }))
vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: {
    buildPiAccountRef: () => null,
    accountIdentity: (vendorId: string) => ({
      accountKey: `pi:${vendorId}`,
      accountLabel: vendorId
    })
  }
}))

import { recordUsageEvent } from '../../services/usage-recorder'
import type { PiBridgeHost } from '../PiBridgeHost'
import type { PiRpcClient } from '../PiRpcClient'
import type { PiChildSpawnOpts, SpawnPiChildFn } from '../pi-child-runner'
import {
  loadPiAgentRegistry,
  type PiAgentDefinition,
  type PiAgentRegistry
} from '../pi-agent-registry'
import {
  buildPiSubagentChildArgs,
  buildPiSubagentChildEnv,
  MAX_CONCURRENT_PI_SUBAGENTS,
  narrowMode,
  PI_SUBAGENT_SUFFIX,
  PiSubagentManager,
  type PiChildScope,
  type PiSubagentHost
} from '../pi-subagents'
import { AutoModeDenialTracker } from '../../automode/denial-tracker'
import { HostedGrants } from '../hosted-grants'
import type { PiAgentDelivery } from '../pi-delivery'

type Cmd = Record<string, unknown>

interface FakeChild {
  opts: PiChildSpawnOpts
  env: NodeJS.ProcessEnv
  push: (ev: Cmd) => void
  client: {
    request: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
  commands: () => Cmd[]
}

/** A fake SpawnPiChildFn: real mapper/runner, fake transport (the dispatcher suite's makeFakePiTarget shape). */
function makeFakeSpawn(
  opts: {
    setModelFails?: boolean
    /** Park child n's get_last_assistant_text (1-based) until the promise resolves. */
    holdLastText?: (n: number) => Promise<void> | undefined
  } = {}
) {
  const children: FakeChild[] = []
  const spawn = vi.fn<SpawnPiChildFn>(async (spawnOpts) => {
    const handlers: Array<(ev: Cmd) => void> = []
    const n = children.length + 1
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        switch (cmd.type) {
          case 'get_state':
            return {
              type: 'response',
              command: 'get_state',
              success: true,
              data: { sessionId: `s${n}` }
            }
          case 'set_model':
            return opts.setModelFails
              ? { type: 'response', command: 'set_model', success: false, error: 'no such model' }
              : { type: 'response', command: 'set_model', success: true }
          case 'get_last_assistant_text':
            await opts.holdLastText?.(n)
            return {
              type: 'response',
              command: 'get_last_assistant_text',
              success: true,
              data: { text: `report ${n}` }
            }
          default:
            return { type: 'response', command: String(cmd.type), success: true }
        }
      }),
      onEvent: vi.fn((cb: (ev: Cmd) => void) => {
        handlers.push(cb)
        return () => {}
      }),
      onExit: vi.fn(() => () => {}),
      dispose: vi.fn()
    }
    children.push({
      opts: spawnOpts,
      env: spawnOpts.env!({ url: 'http://127.0.0.1:1', token: 'child-token' }),
      push: (ev) => {
        for (const h of handlers) h(ev)
      },
      client,
      commands: () => client.request.mock.calls.map((c) => c[0] as Cmd)
    })
    return {
      client: client as unknown as PiRpcClient,
      bridgeHost: { dispose: vi.fn() } as unknown as PiBridgeHost
    }
  })
  return { spawn, children }
}

function makeHost(over: Partial<PiSubagentHost> = {}) {
  const sent: Array<[string, unknown]> = []
  const host: PiSubagentHost = {
    routingId: 'rid-parent',
    cwd: '/parent/cwd',
    currentModel: () => 'openai-codex/parent-model',
    skillDirsEnv: () => ({}),
    send: (channel, data) => {
      sent.push([channel, data])
    },
    gateChild: vi.fn(async () => ({ behavior: 'allow' as const })),
    childAbandoned: vi.fn(),
    retractChildGates: vi.fn(),
    deliverToSession: vi.fn(),
    backgroundWorkChanged: vi.fn(),
    ...over
  }
  return { host, sent }
}

let root: string
const createdRoots: string[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-test-'))
  createdRoots.push(root)
  vi.mocked(recordUsageEvent).mockClear()
})

afterEach(() => {
  // Remove exactly what the runs created: <root>/<agentId>/system-prompt.md, the dir, the root.
  for (const r of createdRoots.splice(0)) {
    for (const id of fs.readdirSync(r)) {
      const dir = path.join(r, id)
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
      fs.rmdirSync(dir)
    }
    fs.rmdirSync(r)
  }
})

function builtins(): PiAgentRegistry {
  return loadPiAgentRegistry({
    cwd: root,
    userAgentsDir: path.join(root, 'no-such-user-dir')
  })
}

function registryWith(defs: PiAgentDefinition[]): PiAgentRegistry {
  const base = builtins()
  return {
    list: () => [...base.list(), ...defs],
    resolve: (t) => defs.find((d) => d.name === t) ?? base.resolve(t),
    diagnostics: []
  }
}

/** Wait until the child has been prompted, then settle its turn. */
async function settle(child: FakeChild): Promise<void> {
  await vi.waitFor(() => expect(child.commands().some((c) => c.type === 'prompt')).toBe(true))
  child.push({ type: 'agent_settled' })
}

function parentScope(depth: number): PiChildScope {
  const def = builtins().resolve('general-purpose')!
  return {
    agentId: 'parent-agent',
    toolUseId: 'parent-call',
    depth,
    definition: def,
    description: '',
    prompt: '',
    runner: () => null,
    outcomes: new Map(),
    denials: new AutoModeDenialTracker(),
    grants: new HostedGrants(),
    canSpawn: depth < 3,
    stopped: false
  }
}

describe('narrowMode (ADR-088 D3: a definition only narrows)', () => {
  it('returns the lower-ranked mode and the parent mode when the definition sets none', () => {
    expect(narrowMode('auto', undefined)).toBe('auto')
    expect(narrowMode('auto', 'plan')).toBe('plan')
    expect(narrowMode('default', 'bypassPermissions')).toBe('default')
    expect(narrowMode('acceptEdits', 'default')).toBe('default')
    expect(narrowMode('full', 'auto')).toBe('full')
    expect(narrowMode('bypassPermissions', 'acceptEdits')).toBe('acceptEdits')
    // An unknown parent mode ranks as default.
    expect(narrowMode('weird', 'acceptEdits')).toBe('weird')
    expect(narrowMode('weird', 'plan')).toBe('plan')
  })
})

describe('buildPiSubagentChildEnv', () => {
  it('sets every gate var explicitly (exact keys), the agent tool only when the child may spawn', () => {
    const can = buildPiSubagentChildEnv(
      { url: 'u', token: 't' },
      { childCanSpawn: true, listing: '- x: y', skillDirsEnv: { CLAUDEUI_PI_SKILL_DIRS: '/s' } }
    )
    expect(can).toEqual({
      CLAUDEUI_PI_BRIDGE_URL: 'u',
      CLAUDEUI_PI_BRIDGE_TOKEN: 't',
      CLAUDEUI_PI_HOSTED_TOOLS: '',
      CLAUDEUI_PI_DISPATCH_ENABLED: '',
      CLAUDEUI_PI_PLAN_TOOLS: '',
      CLAUDEUI_PI_AGENT_TOOL: '1',
      CLAUDEUI_PI_AGENT_LISTING: '- x: y',
      CLAUDEUI_PI_SKILL_DIRS: '/s'
    })
    const cannot = buildPiSubagentChildEnv(
      { url: 'u', token: 't' },
      { childCanSpawn: false, listing: '- x: y', skillDirsEnv: {} }
    )
    expect(cannot.CLAUDEUI_PI_AGENT_TOOL).toBe('')
    expect(cannot.CLAUDEUI_PI_AGENT_LISTING).toBe('')
    expect(cannot.CLAUDEUI_PI_SKILL_DIRS).toBe('')
    expect(Object.keys(cannot).sort()).toEqual(Object.keys(can).sort())
  })
})

describe('buildPiSubagentChildArgs', () => {
  const def = (over: Partial<PiAgentDefinition>): PiAgentDefinition => ({
    ...builtins().resolve('general-purpose')!,
    ...over
  })
  const base = { dir: '/d', agentId: 'id', promptFile: '/d/system-prompt.md' }

  it('persists the session and appends the prompt file; inherit adds -xt agent only when it cannot spawn', () => {
    expect(buildPiSubagentChildArgs({ ...base, definition: def({}), childCanSpawn: true })).toEqual(
      ['--session-dir', '/d', '--session-id', 'id', '--append-system-prompt', '/d/system-prompt.md']
    )
    expect(
      buildPiSubagentChildArgs({ ...base, definition: def({}), childCanSpawn: false }).slice(6)
    ).toEqual(['--exclude-tools', 'agent'])
  })

  it('an explicit tool list keeps agent only when the child may spawn; disallowed and thinking pass through', () => {
    expect(
      buildPiSubagentChildArgs({
        ...base,
        definition: def({ tools: ['read', 'agent'], disallowedTools: ['bash'], thinking: 'high' }),
        childCanSpawn: true
      }).slice(6)
    ).toEqual(['--tools', 'read,agent', '--exclude-tools', 'bash', '--thinking', 'high'])
    expect(
      buildPiSubagentChildArgs({
        ...base,
        definition: def({ tools: ['read', 'agent'] }),
        childCanSpawn: false
      }).slice(6)
    ).toEqual(['--tools', 'read'])
  })
})

describe('PiSubagentManager.run', () => {
  it('T2: spawns in the parent cwd with a persisted session dir and the prompt file (body + suffix)', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const pending = mgr.run(
      { description: 'd', prompt: 'do the task', run_in_background: false },
      'call-1',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]
    expect(child.opts.cwd).toBe('/parent/cwd')
    const args = child.opts.args!
    const agentId = args[args.indexOf('--session-id') + 1]
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/)
    const dir = path.join(root, agentId)
    expect(args.slice(0, 6)).toEqual([
      '--session-dir',
      dir,
      '--session-id',
      agentId,
      '--append-system-prompt',
      path.join(dir, 'system-prompt.md')
    ])
    const promptText = fs.readFileSync(path.join(dir, 'system-prompt.md'), 'utf-8')
    expect(promptText).toBe(
      `${builtins().resolve('general-purpose')!.prompt}\n\n${PI_SUBAGENT_SUFFIX}`
    )
    await vi.waitFor(() => expect(child.commands().length).toBeGreaterThan(1))
    expect(child.commands()[1]).toMatchObject({
      type: 'set_model',
      provider: 'openai-codex',
      modelId: 'parent-model'
    })
    // The task prompt is the first user message, not argv text.
    await vi.waitFor(() =>
      expect(child.commands().find((c) => c.type === 'prompt')).toEqual({
        type: 'prompt',
        message: 'do the task'
      })
    )
    await settle(child)
    await pending
  })

  it('T2: model precedence — the call > the definition > the parent', async () => {
    const custom: PiAgentDefinition = {
      ...builtins().resolve('general-purpose')!,
      name: 'pinned',
      source: 'user',
      model: 'anthropic/def-model'
    }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ subagent_type: 'pinned', model: 'openai/call-model' }, 'call-model'],
      [{ subagent_type: 'pinned' }, 'def-model'],
      [{}, 'parent-model']
    ]
    for (const [extra, expected] of cases) {
      const fake = makeFakeSpawn()
      const { host } = makeHost()
      const mgr = new PiSubagentManager(host, {
        spawn: fake.spawn,
        registry: registryWith([custom]),
        sessionsRoot: root
      })
      const pending = mgr.run(
        { description: 'd', prompt: 'p', run_in_background: false, ...extra },
        'call-m',
        null
      )
      await vi.waitFor(() => expect(fake.children).toHaveLength(1))
      await vi.waitFor(() => expect(fake.children[0].commands().length).toBeGreaterThan(1))
      expect(fake.children[0].commands()[1]).toMatchObject({ type: 'set_model', modelId: expected })
      await settle(fake.children[0])
      await pending
    }
  })

  it('T3: Explore gets its read-only tool list and no agent tool; general-purpose at depth 1 may spawn; depth 3 may not', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })

    const runs = [
      mgr.run(
        { description: 'd', prompt: 'p', subagent_type: 'Explore', run_in_background: false },
        'call-e',
        null
      ),
      mgr.run({ description: 'd', prompt: 'p', run_in_background: false }, 'call-g', null),
      mgr.run(
        { description: 'd', prompt: 'p', run_in_background: false },
        'call-deep',
        parentScope(2)
      )
    ]
    await vi.waitFor(() => expect(fake.children).toHaveLength(3))
    // Spawned in call order (each run reaches its spawn synchronously).
    const byId = (id: string): FakeChild =>
      fake.children[['call-e', 'call-g', 'call-deep'].indexOf(id)]
    const explore = byId('call-e')
    expect(explore.opts.args!.slice(6)).toEqual(['--tools', 'read,bash,grep,find,ls'])
    expect(explore.env.CLAUDEUI_PI_AGENT_TOOL).toBe('')
    const general = byId('call-g')
    expect(general.env.CLAUDEUI_PI_AGENT_TOOL).toBe('1')
    expect(general.env.CLAUDEUI_PI_AGENT_LISTING).toContain('- Explore:')
    expect(general.opts.args!.slice(6)).toEqual([])
    const deep = byId('call-deep')
    expect(deep.env.CLAUDEUI_PI_AGENT_TOOL).toBe('')
    expect(deep.opts.args!.slice(6)).toEqual(['--exclude-tools', 'agent'])
    for (const c of fake.children) await settle(c)
    await Promise.all(runs)
  })

  it('T7: task-started → task-notification (completed, with usage) BEFORE the result; the report ends with <usage>; the runner is disposed', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    let notifiedAtResolve = -1
    const pending = mgr
      .run(
        { description: 'Find it', prompt: 'p', name: 'scout', run_in_background: false },
        'call-7',
        null
      )
      .then((r) => {
        notifiedAtResolve = sent.filter(([c]) => c === 'session:task-notification').length
        return r
      })
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]
    await vi.waitFor(() => expect(child.commands().some((c) => c.type === 'prompt')).toBe(true))
    child.push({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c-bash', name: 'bash', arguments: { command: 'ls' } }],
        provider: 'openai-codex',
        model: 'parent-model',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 }
        },
        stopReason: 'toolUse',
        timestamp: Date.now()
      }
    })
    child.push({ type: 'agent_settled' })
    const result = await pending

    const started = sent.find(([c]) => c === 'session:task-started')![1] as Record<string, unknown>
    expect(started).toMatchObject({ toolUseId: 'call-7', taskType: 'local_agent', runIndex: 1 })
    expect(started.isBackgrounded).toBeUndefined()
    const progress = sent.find(([c]) => c === 'session:task-progress')![1]
    expect(progress).toMatchObject({
      toolUseId: 'call-7',
      toolName: 'agent',
      parentToolUseId: null,
      usage: { totalTokens: 15, toolUses: 1 }
    })
    const note = sent.find(([c]) => c === 'session:task-notification')![1] as Record<
      string,
      unknown
    >
    expect(note).toMatchObject({
      taskId: started.taskId,
      toolUseId: 'call-7',
      status: 'completed',
      outputFile: '',
      usage: { totalTokens: 15, toolUses: 1 },
      runIndex: 1
    })
    expect(notifiedAtResolve).toBe(1)
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toMatch(
      new RegExp(
        `^report 1\\n\\nagentId: ${String(started.taskId)} \\(use send_message with to: 'scout' to continue this agent\\.\\)\\n` +
          '<usage>total_tokens: 15\\ntool_uses: 1\\nduration_ms: \\d+</usage>$'
      )
    )
    expect(result.details).toEqual({
      cuiAgent: {
        v: 1,
        agentId: started.taskId,
        subagentType: 'general-purpose',
        name: 'scout',
        status: 'completed',
        model: 'openai-codex/parent-model'
      }
    })
    expect(child.client.dispose).toHaveBeenCalledTimes(1)
    expect(mgr.liveCount).toBe(0)

    // T8 (manager half): one child usage row, under the child's own session id.
    expect(recordUsageEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordUsageEvent).mock.calls[0][0]).toMatchObject({
      engineId: 'pi',
      origin: 'child',
      sessionId: started.taskId,
      parentRoutingId: 'rid-parent'
    })
  })

  it('T11: an unknown type lists the types with no spawn; tools: [] refuses with no spawn', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeHost()
    const refuser: PiAgentDefinition = {
      ...builtins().resolve('general-purpose')!,
      name: 'refuser',
      source: 'user',
      tools: []
    }
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: registryWith([refuser]),
      sessionsRoot: root
    })
    const unknown = await mgr.run(
      { description: 'd', prompt: 'p', subagent_type: 'nope' },
      'c1',
      null
    )
    expect(unknown).toEqual({
      content: [
        {
          type: 'text',
          text: 'Agent type "nope" not found. Available agents: general-purpose, Explore, Plan, refuser'
        }
      ],
      isError: true
    })
    const refused = await mgr.run(
      { description: 'd', prompt: 'p', subagent_type: 'refuser' },
      'c2',
      null
    )
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('cannot be launched')
    const noPrompt = await mgr.run({ description: 'd', prompt: '  ' }, 'c3', null)
    expect(noPrompt.isError).toBe(true)
    expect(fake.spawn).not.toHaveBeenCalled()
  })

  it('T11: over the concurrency cap is an error', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const runs = Array.from({ length: MAX_CONCURRENT_PI_SUBAGENTS }, (_, i) =>
      mgr.run({ description: 'd', prompt: 'p', run_in_background: false }, `cap-${i}`, null)
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(MAX_CONCURRENT_PI_SUBAGENTS))
    const over = await mgr.run({ description: 'd', prompt: 'p' }, 'cap-over', null)
    expect(over.isError).toBe(true)
    expect(over.content[0].text).toContain('Too many agents running')
    expect(fake.children).toHaveLength(MAX_CONCURRENT_PI_SUBAGENTS)
    for (const c of fake.children) await settle(c)
    await Promise.all(runs)
  })

  it('a refused set_model is an error result naming pi’s message', async () => {
    const fake = makeFakeSpawn({ setModelFails: true })
    const { host, sent } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const r = await mgr.run({ description: 'd', prompt: 'p', model: 'x/y' }, 'c-m', null)
    expect(r).toEqual({
      content: [{ type: 'text', text: 'Failed to start the agent: no such model' }],
      isError: true
    })
    expect(sent.some(([c]) => c === 'session:task-started')).toBe(false)
  })

  it('stop: aborts the child, stops descendants first, and reports "Agent stopped by user."', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const pending = mgr.run(
      { description: 'd', prompt: 'p', run_in_background: false },
      'call-s',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]
    await vi.waitFor(() => expect(child.commands().some((c) => c.type === 'prompt')).toBe(true))

    // A grandchild launched through the child's own (granted) agent tool.
    const grandGate = await child.opts.gateHandler({
      toolCallId: 'grand-call',
      toolName: 'agent',
      input: { description: 'd', prompt: 'q' }
    })
    expect(grandGate).toEqual({ behavior: 'allow' })
    const grand = child.opts.hostedToolHandler!({
      toolName: 'agent',
      input: { description: 'd', prompt: 'q', run_in_background: false },
      toolCallId: 'grand-call'
    })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const grandChild = fake.children[1]
    await vi.waitFor(() =>
      expect(grandChild.commands().some((c) => c.type === 'prompt')).toBe(true)
    )

    expect(mgr.stop('call-s')).toBe(true)
    // F1(b) — a call after the stop is refused at the child gate itself: the
    // parent's gate (and so its judge and its cards) is never consulted.
    expect(
      await child.opts.gateHandler({
        toolCallId: 'late-call',
        toolName: 'bash',
        input: { command: 'npm test' }
      })
    ).toEqual({ behavior: 'deny', reason: 'Agent stopped' })
    expect(vi.mocked(host.gateChild).mock.calls.some(([, p]) => p.toolCallId === 'late-call')).toBe(
      false
    )
    // F7 — descendant first: the grandchild's abort precedes the child's.
    const abortOrder = (c: FakeChild): number => {
      const i = c.commands().findIndex((x) => x.type === 'abort')
      expect(i).toBeGreaterThanOrEqual(0)
      return c.client.request.mock.invocationCallOrder[i]
    }
    expect(abortOrder(grandChild)).toBeLessThan(abortOrder(child))
    // R2 — each stopped child's open cards are retracted (host side).
    expect(vi.mocked(host.retractChildGates).mock.calls.map(([sc]) => sc.toolUseId)).toEqual([
      'grand-call',
      'call-s'
    ])
    child.push({ type: 'agent_settled' })
    grandChild.push({ type: 'agent_settled' })
    const [r, g] = await Promise.all([pending, grand])
    expect(r).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Agent stopped by user.' }]
    })
    expect(g).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Agent stopped by user.' }]
    })
    const statuses = sent
      .filter(([c]) => c === 'session:task-notification')
      .map(([, d]) => (d as { status: string }).status)
    expect(statuses).toEqual(['stopped', 'stopped'])
    expect(mgr.stop('call-s')).toBe(false)
  })

  it('T12: a child hosted-tool agent call WITHOUT a grant fails closed; a granted one streams under its own id with a top-level task-started', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const pending = mgr.run(
      { description: 'd', prompt: 'p', run_in_background: false },
      'call-r',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]

    const ungranted = await child.opts.hostedToolHandler!({
      toolName: 'agent',
      input: { description: 'd', prompt: 'q' },
      toolCallId: 'no-grant'
    })
    expect(ungranted).toEqual({
      content: [{ type: 'text', text: 'hosted tool call was not approved through the tool gate' }],
      isError: true
    })
    expect(fake.children).toHaveLength(1)

    await child.opts.gateHandler({
      toolCallId: 'grand-1',
      toolName: 'agent',
      input: { description: 'd', prompt: 'q' }
    })
    const grand = child.opts.hostedToolHandler!({
      toolName: 'agent',
      input: { description: 'd', prompt: 'q', run_in_background: false },
      toolCallId: 'grand-1'
    })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const gc = fake.children[1]
    await vi.waitFor(() => expect(gc.commands().some((c) => c.type === 'prompt')).toBe(true))
    gc.push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    gc.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' }
    })
    const open = sent.find(
      ([c, d]) =>
        c === 'session:item-open' &&
        (d as { target: { ownerToolUseId: string } }).target.ownerToolUseId === 'grand-1'
    )
    expect(open).toBeDefined()
    const starts = sent
      .filter(([c]) => c === 'session:task-started')
      .map(([, d]) => (d as { toolUseId: string }).toolUseId)
    expect(starts).toEqual(['call-r', 'grand-1'])
    gc.push({ type: 'agent_settled' })
    await grand
    await settle(child)
    await pending
  })

  it('R1: a child that cannot spawn (Explore; depth 3) is refused on the HOST — its gate denies agent with no grant, and a forged grant is refused by run()', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const runs = [
      mgr.run(
        { description: 'd', prompt: 'p', subagent_type: 'Explore', run_in_background: false },
        'call-ex',
        null
      ),
      mgr.run(
        { description: 'd', prompt: 'p', run_in_background: false },
        'call-d3',
        parentScope(2)
      )
    ]
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const input = { description: 'd', prompt: 'q' }
    for (const child of fake.children) {
      expect(
        await child.opts.gateHandler({ toolCallId: 'try-agent', toolName: 'agent', input })
      ).toEqual({ behavior: 'deny', reason: 'This agent cannot launch agents' })
      // Never reached the parent's gate; no grant was minted.
      expect(
        vi.mocked(host.gateChild).mock.calls.some(([, p]) => p.toolCallId === 'try-agent')
      ).toBe(false)
      expect(
        await child.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'try-agent' })
      ).toMatchObject({ isError: true })
    }
    // A grant forged straight into the scope (as if the gate had been bypassed).
    await fake.children[0].opts.gateHandler({
      toolCallId: 'probe',
      toolName: 'read',
      input: { path: 'x' }
    })
    const scope = vi.mocked(host.gateChild).mock.calls.find(([, p]) => p.toolCallId === 'probe')![0]
    expect(scope.canSpawn).toBe(false)
    scope.grants.mint('forged', 'agent')
    expect(
      await fake.children[0].opts.hostedToolHandler!({
        toolName: 'agent',
        input,
        toolCallId: 'forged'
      })
    ).toEqual({
      content: [{ type: 'text', text: 'This agent cannot launch agents.' }],
      isError: true
    })
    expect(fake.children).toHaveLength(2)
    for (const c of fake.children) await settle(c)
    await Promise.all(runs)
  })
})

// ---------------------------------------------------------------------------
// ADR-088 S3 — background runs, notifications, owner routing, stops
// ---------------------------------------------------------------------------

/** Decode the /cui-deliver prompt(s) a fake child received. */
function deliveriesOn(child: FakeChild): PiAgentDelivery[] {
  return child
    .commands()
    .filter((c) => c.type === 'prompt' && String(c.message).startsWith('/cui-deliver '))
    .map(
      (c) =>
        JSON.parse(
          Buffer.from(String(c.message).slice('/cui-deliver '.length), 'base64').toString('utf8')
        ) as PiAgentDelivery
    )
}

/** The custom message_end pi emits once a payload is delivered (probe P-S1). */
function deliveredEvent(p: PiAgentDelivery): Cmd {
  return {
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'claudeui-agent-message',
      content: [{ type: 'text', text: p.text }],
      display: true,
      details: { ...p.details, v: 1, kind: p.kind, deliveryId: p.deliveryId, title: p.title },
      timestamp: Date.now()
    }
  }
}

function usageEnd(input: number, output: number): Cmd {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      provider: 'openai-codex',
      model: 'm',
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    }
  }
}

/** A host whose deliverToSession records into the same ordered log as send. */
function makeOrderedHost() {
  const { host, sent } = makeHost()
  const delivered: PiAgentDelivery[] = []
  host.deliverToSession = vi.fn((p: PiAgentDelivery) => {
    delivered.push(p)
    sent.push(['deliver', p])
  })
  return { host, sent, delivered }
}

const promptedWith = async (child: FakeChild): Promise<void> => {
  await vi.waitFor(() => expect(child.commands().some((c) => c.type === 'prompt')).toBe(true))
}

describe('PiSubagentManager — background runs (ADR-088 S3)', () => {
  it('B1: no run_in_background → returns the async-launched text before the child settles; task-started says isBackgrounded', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const result = await mgr.run({ description: 'Scan', prompt: 'p', name: 'scout' }, 'bg-1', null)
    const child = fake.children[0]
    const started = sent.find(([c]) => c === 'session:task-started')![1] as Record<string, unknown>
    expect(started).toMatchObject({ toolUseId: 'bg-1', runIndex: 1, isBackgrounded: true })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe(
      'Async agent launched successfully.\n' +
        `agentId: ${String(started.taskId)} (use send_message with to: 'scout' to continue this agent.)\n` +
        'The agent is working in the background. You will be notified automatically when it completes. ' +
        'You know nothing about its results until that notification arrives — do not report, assume, ' +
        'or predict them; continue other work or respond to the user in the meantime.'
    )
    expect(result.details).toEqual({
      cuiAgent: {
        v: 1,
        agentId: started.taskId,
        subagentType: 'general-purpose',
        name: 'scout',
        model: 'openai-codex/parent-model',
        background: true,
        status: 'async_launched'
      }
    })
    // Still running: no notification, not disposed, counted as background work.
    expect(sent.some(([c]) => c === 'session:task-notification')).toBe(false)
    expect(child.client.dispose).not.toHaveBeenCalled()
    expect(mgr.liveBackgroundCount).toBe(1)
    expect(host.backgroundWorkChanged).toHaveBeenCalledTimes(1)
    await settle(child)
    await vi.waitFor(() => expect(host.deliverToSession).toHaveBeenCalledTimes(1))
    expect(mgr.liveBackgroundCount).toBe(0)
    expect(host.backgroundWorkChanged).toHaveBeenCalledTimes(2)
  })

  it('B1: a definition with background: true forces background even with run_in_background: false; a non-boolean is refused', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const forced: PiAgentDefinition = {
      ...builtins().resolve('general-purpose')!,
      name: 'bg-only',
      source: 'user',
      background: true
    }
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: registryWith([forced]),
      sessionsRoot: root
    })
    const r = await mgr.run(
      { description: 'd', prompt: 'p', subagent_type: 'bg-only', run_in_background: false },
      'bg-f',
      null
    )
    expect(r.content[0].text).toMatch(/^Async agent launched successfully\./)
    const bad = await mgr.run(
      { description: 'd', prompt: 'p', run_in_background: 'yes' },
      'bg-x',
      null
    )
    expect(bad).toEqual({
      content: [{ type: 'text', text: 'agent "run_in_background" must be a boolean.' }],
      isError: true
    })
    expect(fake.children).toHaveLength(1)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(host.deliverToSession).toHaveBeenCalledTimes(1))
  })

  it('B2 (manager half): a completed background run → UI notification FIRST, then one wake delivery with the CC-shaped text', async () => {
    const fake = makeFakeSpawn()
    const { host, sent, delivered } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    await mgr.run({ description: 'Scan the repo', prompt: 'p' }, 'bg-2', null)
    const child = fake.children[0]
    await promptedWith(child)
    child.push(usageEnd(10, 5))
    child.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const order = sent
      .map(([c]) => c)
      .filter((c) => c === 'session:task-notification' || c === 'deliver')
    expect(order).toEqual(['session:task-notification', 'deliver'])
    const agentId = (sent.find(([c]) => c === 'session:task-started')![1] as { taskId: string })
      .taskId
    const p = delivered[0]
    expect(p).toMatchObject({
      v: 1,
      kind: 'task-notification',
      wake: true,
      title: 'Agent "Scan the repo" completed',
      details: {
        agentId,
        toolUseId: 'bg-2',
        status: 'completed',
        summary: 'Agent "Scan the repo" completed',
        runIndex: 1,
        usage: { totalTokens: 15, toolUses: 0 }
      }
    })
    expect(p.text).toMatch(
      new RegExp(
        `^<task-notification>\\n<task-id>${agentId}</task-id>\\n<tool-use-id>bg-2</tool-use-id>\\n` +
          '<status>completed</status>\\n<summary>Agent "Scan the repo" completed</summary>\\n' +
          '<result>report 1</result>\\n' +
          '<usage><total_tokens>15</total_tokens><tool_uses>0</tool_uses><duration_ms>\\d+</duration_ms></usage>\\n' +
          '</task-notification>$'
      )
    )
    expect(child.client.dispose).toHaveBeenCalledTimes(1)
  })

  it('B5: a grandchild completing while its spawner child runs is delivered on the CHILD; one completing after the spawner finished goes to the root, naming the spawner', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const pendingA = mgr.run(
      { description: 'd', prompt: 'p', name: 'lead', run_in_background: false },
      'call-A',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const a = fake.children[0]
    await promptedWith(a)
    const launch = async (id: string): Promise<FakeChild> => {
      const input = { description: id, prompt: 'q' }
      await a.opts.gateHandler({ toolCallId: id, toolName: 'agent', input })
      const n = fake.children.length
      const r = await a.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: id })
      expect(r.content[0].text).toMatch(/^Async agent launched successfully\./)
      await vi.waitFor(() => expect(fake.children).toHaveLength(n + 1))
      return fake.children[n]
    }
    const g1 = await launch('g1')
    const g2 = await launch('g2')

    await settle(g1)
    await vi.waitFor(() => expect(deliveriesOn(a)).toHaveLength(1))
    expect(deliveriesOn(a)[0]).toMatchObject({ wake: true, details: { toolUseId: 'g1' } })
    expect(deliveriesOn(a)[0].text).not.toContain('launched by agent')
    expect(host.deliverToSession).not.toHaveBeenCalled()

    // A takes its delivery (pi steered it into the running turn) and finishes.
    a.push(deliveredEvent(deliveriesOn(a)[0]))
    a.push({ type: 'agent_settled' })
    await pendingA

    await settle(g2)
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].details.toolUseId).toBe('g2')
    expect(delivered[0].text).toContain(
      '<summary>Agent "g2" completed (launched by agent "lead")</summary>'
    )
    expect(deliveriesOn(a)).toHaveLength(1)
  })

  it('B6: a delivery still pending at agent_settled keeps the child; the deferred run settles it (one notification, usage spans both)', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const pendingA = mgr.run(
      { description: 'd', prompt: 'p', run_in_background: false },
      'call-A',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const a = fake.children[0]
    await promptedWith(a)
    const input = { description: 'g', prompt: 'q' }
    await a.opts.gateHandler({ toolCallId: 'g', toolName: 'agent', input })
    await a.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'g' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    await settle(fake.children[1])
    await vi.waitFor(() => expect(deliveriesOn(a)).toHaveLength(1))

    // pi settles A's run before the delivery lands (it was settling).
    a.push(usageEnd(10, 5))
    a.push({ type: 'agent_settled' })
    await new Promise((r) => setTimeout(r, 20))
    expect(a.client.dispose).not.toHaveBeenCalled()
    const notesFor = (id: string): Array<[string, unknown]> =>
      sent.filter(
        ([c, d]) =>
          c === 'session:task-notification' && (d as { toolUseId: string }).toolUseId === id
      )
    expect(notesFor('call-A')).toHaveLength(0)

    // The deferred run pi starts for it.
    a.push({ type: 'agent_start' })
    a.push(deliveredEvent(deliveriesOn(a)[0]))
    a.push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    a.push(usageEnd(3, 2))
    a.push({ type: 'agent_settled' })
    const result = await pendingA
    expect(result.isError).toBeUndefined()
    expect(notesFor('call-A')).toHaveLength(1)
    expect(notesFor('call-A')[0][1]).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 20 }
    })
    expect(a.client.dispose).toHaveBeenCalledTimes(1)
  })

  it('B8: a user Stop of a background child → stopped notification, then a passive delivery with <status>killed</status>', async () => {
    const fake = makeFakeSpawn()
    const { host, sent, delivered } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'bg-s', null)
    const child = fake.children[0]
    await promptedWith(child)
    expect(mgr.stop('bg-s', 'user')).toBe(true)
    child.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const order = sent
      .map(([c]) => c)
      .filter((c) => c === 'session:task-notification' || c === 'deliver')
    expect(order).toEqual(['session:task-notification', 'deliver'])
    expect(sent.find(([c]) => c === 'session:task-notification')![1]).toMatchObject({
      status: 'stopped'
    })
    expect(delivered[0]).toMatchObject({
      wake: false,
      title: 'Agent "w" was stopped',
      details: { status: 'stopped', summary: 'Agent "w" was stopped by the user' }
    })
    expect(delivered[0].text).toContain('<status>killed</status>')
    expect(delivered[0].text).not.toContain('<result>')
  })

  it('stopForeground spares background children (and their cards); stopAll(dispose) stops all with no delivery', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const fg = mgr.run({ description: 'd', prompt: 'p', run_in_background: false }, 'fg', null)
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    await mgr.run({ description: 'd', prompt: 'p' }, 'bg', null)
    const [fgChild, bgChild] = fake.children
    await promptedWith(bgChild)

    mgr.stopForeground('interrupt')
    expect(fgChild.commands().some((c) => c.type === 'abort')).toBe(true)
    expect(bgChild.commands().some((c) => c.type === 'abort')).toBe(false)
    expect(vi.mocked(host.retractChildGates).mock.calls.map(([s]) => s.toolUseId)).toEqual(['fg'])
    fgChild.push({ type: 'agent_settled' })
    expect(await fg).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Agent cancelled.' }]
    })
    expect(mgr.liveBackgroundCount).toBe(1)

    mgr.stopAll('dispose')
    expect(bgChild.client.dispose).toHaveBeenCalled()
    bgChild.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
    await new Promise((r) => setTimeout(r, 10))
    expect(delivered).toHaveLength(0)
  })
})

describe('PiSubagentManager — owner routing liveness (ADR-088 S3 review R2)', () => {
  /** Root foreground F (child 1) launches background GB (child 2) through its own agent tool. */
  async function fWithGb(fake: ReturnType<typeof makeFakeSpawn>, mgr: PiSubagentManager) {
    const pendingF = mgr.run(
      { description: 'd', prompt: 'p', name: 'F', run_in_background: false },
      'call-F',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const f = fake.children[0]
    await vi.waitFor(() => expect(f.commands().some((c) => c.type === 'prompt')).toBe(true))
    const input = { description: 'GB', prompt: 'q' }
    await f.opts.gateHandler({ toolCallId: 'call-GB', toolName: 'agent', input })
    const launched = await f.opts.hostedToolHandler!({
      toolName: 'agent',
      input,
      toolCallId: 'call-GB'
    })
    expect(launched.content[0].text).toMatch(/^Async agent launched successfully\./)
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    return { pendingF, f, gb: fake.children[1] }
  }

  it('GB completing while its foreground spawner F drains an interrupt goes to the ROOT, not F', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const { pendingF, f, gb } = await fWithGb(fake, mgr)
    mgr.stopForeground('interrupt')
    expect(f.commands().some((c) => c.type === 'abort')).toBe(true)
    expect(gb.commands().some((c) => c.type === 'abort')).toBe(false)

    await settle(gb) // F has not settled its abort yet: still in `live`, draining
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].details.toolUseId).toBe('call-GB')
    expect(delivered[0].text).toContain('(launched by agent "F")')
    expect(deliveriesOn(f)).toHaveLength(0)
    f.push({ type: 'agent_settled' })
    await pendingF
  })

  it("GB completing in F's closing window (after its continuation, before dispose) goes to the ROOT", async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    const fake = makeFakeSpawn({ holdLastText: (n) => (n === 1 ? held : undefined) })
    const { host, delivered } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const { pendingF, f, gb } = await fWithGb(fake, mgr)
    f.push({ type: 'agent_settled' }) // F finishes; its report read is parked
    await vi.waitFor(() =>
      expect(f.commands().some((c) => c.type === 'get_last_assistant_text')).toBe(true)
    )
    expect(f.client.dispose).not.toHaveBeenCalled()

    await settle(gb)
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].details.toolUseId).toBe('call-GB')
    expect(deliveriesOn(f)).toHaveLength(0)
    release()
    await pendingF
  })

  it('stopWith(foregroundOnly) skips a background descendant of a stopped foreground child', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    const { pendingF, f, gb } = await fWithGb(fake, mgr)
    mgr.stopForeground('interrupt')
    expect(vi.mocked(host.retractChildGates).mock.calls.map(([s]) => s.toolUseId)).toEqual([
      'call-F'
    ])
    expect(gb.commands().some((c) => c.type === 'abort')).toBe(false)
    f.push({ type: 'agent_settled' })
    await pendingF
    expect(mgr.liveBackgroundCount).toBe(1)
    await settle(gb)
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
  })
})

describe('PiSubagentManager — reserved bridge commands (ADR-088 S3 review R3)', () => {
  it('an agent prompt starting with /cui- is refused before any spawn', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
    for (const prompt of ['/cui-deliver eyJ2IjoxfQ==', '  \n/cui-plan-exit']) {
      expect(await mgr.run({ description: 'd', prompt }, `c-${prompt.length}`, null)).toEqual({
        content: [{ type: 'text', text: 'agent "prompt" may not start with "/cui-".' }],
        isError: true
      })
    }
    expect(fake.spawn).not.toHaveBeenCalled()
  })
})
