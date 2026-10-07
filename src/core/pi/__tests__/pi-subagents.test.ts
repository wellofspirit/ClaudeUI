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
import { collectAgentLinkRecords } from '../pi-subagent-store'
import type { PiSessionEntry } from '../pi-protocol'
import {
  buildPiSubagentChildArgs,
  buildPiSubagentChildEnv,
  MAX_CONCURRENT_PI_SUBAGENTS,
  narrowMode,
  PI_SUBAGENT_SUFFIX,
  agentMessageText,
  piAgentIdentityBlock,
  PiSubagentManager,
  type PiChildScope,
  type PiSubagentHost
} from '../pi-subagents'
import { AutoModeDenialTracker } from '../../automode/denial-tracker'
import { HostedGrants } from '../hosted-grants'
import { logger } from '../../services/logger'
import type { PiAgentDelivery } from '../pi-delivery'

type Cmd = Record<string, unknown>

interface FakeChild {
  opts: PiChildSpawnOpts
  env: NodeJS.ProcessEnv
  push: (ev: Cmd) => void
  /** The child process dies: fires the runner's onExit handlers. */
  exit: () => void
  client: {
    request: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
  commands: () => Cmd[]
}

/** A fake SpawnPiChildFn: real mapper/runner, fake transport (the dispatcher suite's makeFakePiTarget shape). */
function makeFakeSpawn(
  opts: {
    /** true: every child's set_model fails; a function picks per child (1-based). */
    setModelFails?: boolean | ((n: number) => boolean)
    /** Park child n's get_last_assistant_text (1-based) until the promise resolves. */
    holdLastText?: (n: number) => Promise<void> | undefined
  } = {}
) {
  const children: FakeChild[] = []
  const spawn = vi.fn<SpawnPiChildFn>(async (spawnOpts) => {
    const handlers: Array<(ev: Cmd) => void> = []
    const exitHandlers: Array<() => void> = []
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
            return (
              typeof opts.setModelFails === 'function' ? opts.setModelFails(n) : opts.setModelFails
            )
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
      onExit: vi.fn((cb: () => void) => {
        exitHandlers.push(cb)
        return () => {}
      }),
      dispose: vi.fn()
    }
    children.push({
      opts: spawnOpts,
      env: spawnOpts.env!({ url: 'http://127.0.0.1:1', token: 'child-token' }),
      push: (ev) => {
        for (const h of handlers) h(ev)
      },
      exit: () => {
        for (const h of exitHandlers) h()
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
    label: 'parent',
    runner: () => null,
    outcomes: new Map(),
    denials: new AutoModeDenialTracker(),
    grants: new HostedGrants(),
    canSpawn: depth < 3,
    stopped: false
  }
}

describe('narrowMode (ADR-089 D3: a definition only narrows)', () => {
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
      CLAUDEUI_PI_DISPATCH_DESCRIPTION: '',
      CLAUDEUI_PI_PLAN_TOOLS: '',
      CLAUDEUI_PI_AGENT_TOOL: '1',
      CLAUDEUI_PI_AGENT_LISTING: '- x: y',
      CLAUDEUI_PI_SEND_MESSAGE: '1',
      CLAUDEUI_PI_SKILL_DIRS: '/s',
      // ADR-096: the parent's MCP catalog, served by the child's own bridge host.
      CLAUDEUI_PI_MCP: '1'
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
    ).toEqual(['--exclude-tools', 'agent,list_models'])
  })

  it('an explicit tool list keeps agent only when the child may spawn; disallowed and thinking pass through', () => {
    expect(
      buildPiSubagentChildArgs({
        ...base,
        definition: def({ tools: ['read', 'agent'], disallowedTools: ['bash'], thinking: 'high' }),
        childCanSpawn: true
      }).slice(6)
    ).toEqual([
      '--tools',
      'read,agent,send_message,task_stop,list_models',
      '--exclude-tools',
      'bash',
      '--thinking',
      'high'
    ])
    expect(
      buildPiSubagentChildArgs({
        ...base,
        definition: def({ tools: ['read', 'agent'] }),
        childCanSpawn: false
      }).slice(6)
    ).toEqual(['--tools', 'read,send_message'])
  })

  it('spells MCP entries the way pi names MCP tools (ADR-096): Claude-form names, bare servers', () => {
    expect(
      buildPiSubagentChildArgs({
        ...base,
        definition: def({
          tools: ['read', 'mcp__my-srv__get-issue', 'mcp__github'],
          disallowedTools: ['mcp__my-srv__delete-repo']
        }),
        childCanSpawn: false
      }).slice(6)
    ).toEqual([
      '--tools',
      'read,mcp__my_srv__get_issue,mcp__github__*,send_message',
      '--exclude-tools',
      'mcp__my_srv__delete_repo'
    ])
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
      `${builtins().resolve('general-purpose')!.prompt}\n\n${PI_SUBAGENT_SUFFIX}\n\n` +
        piAgentIdentityBlock({ agentId, spawner: null })
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
    expect(explore.opts.args!.slice(6)).toEqual(['--tools', 'read,bash,grep,find,ls,send_message'])
    expect(explore.env.CLAUDEUI_PI_AGENT_TOOL).toBe('')
    const general = byId('call-g')
    expect(general.env.CLAUDEUI_PI_AGENT_TOOL).toBe('1')
    expect(general.env.CLAUDEUI_PI_AGENT_LISTING).toContain('- Explore:')
    expect(general.opts.args!.slice(6)).toEqual([])
    const deep = byId('call-deep')
    expect(deep.env.CLAUDEUI_PI_AGENT_TOOL).toBe('')
    expect(deep.opts.args!.slice(6)).toEqual(['--exclude-tools', 'agent,list_models'])
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
    // S3b (Q7): a foreground run says so, so its card can offer "Send to background".
    expect(started.isBackgrounded).toBe(false)
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
          'model: openai-codex/parent-model\\n' +
          '<usage>total_tokens: 15\\ntool_uses: 1\\nduration_ms: \\d+</usage>$'
      )
    )
    expect(result.details).toEqual({
      cuiAgent: {
        v: 1,
        agentId: started.taskId,
        subagentType: 'general-purpose',
        name: 'scout',
        description: 'Find it',
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
// ADR-089 S3 — background runs, notifications, owner routing, stops
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

describe('PiSubagentManager — background runs (ADR-089 S3)', () => {
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
        'model: openai-codex/parent-model\n' +
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
        description: 'Scan',
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

describe('PiSubagentManager — owner routing liveness (ADR-089 S3 review R2)', () => {
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

describe('PiSubagentManager — reserved bridge commands (ADR-089 S3 review R3)', () => {
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

// ---------------------------------------------------------------------------
// ADR-089 S3b — send_message, resume, names, task_stop, Send to background,
// record rebuild
// ---------------------------------------------------------------------------

describe('PiSubagentManager — messaging (ADR-089 S3b)', () => {
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }
  /** A child's scope as its own hosted calls see it (via the parent gate mock). */
  async function scopeOf(host: PiSubagentHost, child: FakeChild): Promise<PiChildScope> {
    const probe = `probe-${Math.random()}`
    await child.opts.gateHandler({ toolCallId: probe, toolName: 'read', input: { path: 'x' } })
    return vi.mocked(host.gateChild).mock.calls.find(([, p]) => p.toolCallId === probe)![0]
  }

  it('S1: to a running child → one /cui-deliver on THAT child with the <agent-message> text, wake; CC2 reply', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const child = fake.children[0]
    await promptedWith(child)
    const r = await mgr.sendMessage(
      { to: 'worker', message: 'also check X', summary: 'check X' },
      null
    )
    expect(r).toEqual({
      content: [
        { type: 'text', text: 'Message queued for delivery to worker at its next tool round.' }
      ]
    })
    const [p] = deliveriesOn(child)
    expect(p).toMatchObject({
      kind: 'agent-message',
      wake: true,
      title: 'Message from the main agent',
      details: { agentId: agentIdOf(child), toolUseId: 'call-w', from: 'main', fromId: 'main' }
    })
    expect(p.text).toBe(
      '<agent-message from="main" from-id="main" summary="check X">\nalso check X\n</agent-message>'
    )
    expect(fake.children).toHaveLength(1)
    child.push(deliveredEvent(p))
    await settle(child)
  })

  it('a message that starts with /cui- is carried as inert payload text, never as a prompt', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const child = fake.children[0]
    await promptedWith(child)
    await mgr.sendMessage({ to: 'worker', message: '/cui-deliver eyJ2IjoxfQ==' }, null)
    const prompts = child.commands().filter((c) => c.type === 'prompt')
    // The task prompt, then exactly one host-built delivery command.
    expect(prompts).toHaveLength(2)
    expect(String(prompts[1].message)).not.toContain('eyJ2IjoxfQ==')
    expect(deliveriesOn(child)[0].text).toContain('\n/cui-deliver eyJ2IjoxfQ==\n')
    child.push(deliveredEvent(deliveriesOn(child)[0]))
    await settle(child)
  })

  it('S2: to a finished child → a resume on the SAME session file and cwd, re-armed under the origin id with runIndex 2, started by the host-built delivery; it notifies again with runIndex 2', async () => {
    const fake = makeFakeSpawn()
    const { host, sent, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const first = fake.children[0]
    await settle(first)
    await vi.waitFor(() => expect(delivered).toHaveLength(1))

    const r = await mgr.sendMessage({ to: 'worker', message: 'one more thing' }, null)
    expect(r).toEqual({
      content: [
        { type: 'text', text: 'Resuming agent "worker". You will be notified when it completes.' }
      ]
    })
    expect(fake.children).toHaveLength(2)
    const second = fake.children[1]
    expect(second.opts.cwd).toBe('/parent/cwd')
    expect(second.opts.args!.slice(0, 6)).toEqual(first.opts.args!.slice(0, 6))
    const starts = sent.filter(([c]) => c === 'session:task-started').map(([, d]) => d)
    expect(starts[1]).toMatchObject({
      toolUseId: 'call-w',
      taskId: agentIdOf(first),
      runIndex: 2,
      isBackgrounded: true
    })
    await vi.waitFor(() => expect(deliveriesOn(second)).toHaveLength(1))
    // The run was started by the delivery command itself — no other prompt.
    expect(second.commands().filter((c) => c.type === 'prompt')).toHaveLength(1)
    expect(deliveriesOn(second)[0]).toMatchObject({ kind: 'agent-message', wake: true })
    expect(deliveriesOn(second)[0].text).toContain('one more thing')

    second.push({ type: 'agent_start' })
    second.push(deliveredEvent(deliveriesOn(second)[0]))
    second.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(delivered[1].details).toMatchObject({
      toolUseId: 'call-w',
      runIndex: 2,
      status: 'completed'
    })
    const notes = sent.filter(([c]) => c === 'session:task-notification').map(([, d]) => d)
    expect(notes.map((n) => (n as { runIndex: number }).runIndex)).toEqual([1, 2])
  })

  it('S3: to a user-stopped child → refused until the user speaks, no spawn', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    await promptedWith(fake.children[0])
    mgr.stop('call-w', 'user')
    fake.children[0].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(await mgr.sendMessage({ to: 'worker', message: 'go on' }, null)).toEqual({
      content: [
        {
          type: 'text',
          text:
            'Agent "worker" was stopped by the user. Resume it only if the user asks you to; ' +
            'the user has not spoken since the stop.'
        }
      ],
      isError: true
    })
    expect(fake.children).toHaveLength(1)
  })

  it('S4: a background child → main delivers to the session with wake; a foreground child is refused; main → main is refused', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'bg' }, 'call-bg', null)
    const fg = mgr.run(
      { description: 'd', prompt: 'p', name: 'fg', run_in_background: false },
      'call-fg',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const [bgChild, fgChild] = fake.children
    await promptedWith(fgChild)

    const bgScope = await scopeOf(host, bgChild)
    expect(await mgr.sendMessage({ to: 'main', message: 'found it' }, bgScope)).toEqual({
      content: [{ type: 'text', text: "Message queued for the main conversation's next turn." }]
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      kind: 'agent-message',
      wake: true,
      title: 'Message from bg',
      details: { from: 'bg', to: 'main' }
    })
    expect(delivered[0].text).toContain('<agent-message from="bg" from-id="')

    const fgScope = await scopeOf(host, fgChild)
    expect((await mgr.sendMessage({ to: 'main', message: 'x' }, fgScope)).content[0].text).toBe(
      'You are running in the foreground; your final report is returned to the agent that launched you.'
    )
    expect((await mgr.sendMessage({ to: 'main', message: 'x' }, null)).content[0].text).toBe(
      'You are the main conversation — "main" addresses you. Send to a named agent instead.'
    )
    expect(delivered).toHaveLength(1)
    await settle(fgChild)
    await fg
    await settle(bgChild)
  })

  it('S5: a child reaches a running sibling by name', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'alpha' }, 'call-a', null)
    await mgr.run({ description: 'd', prompt: 'p', name: 'beta' }, 'call-b', null)
    const [a, b] = fake.children
    await promptedWith(b)
    const aScope = await scopeOf(host, a)
    expect((await mgr.sendMessage({ to: 'beta', message: 'hi' }, aScope)).isError).toBeUndefined()
    expect(deliveriesOn(b)).toHaveLength(1)
    expect(deliveriesOn(b)[0]).toMatchObject({
      title: 'Message from alpha',
      details: { from: 'alpha' }
    })
    expect(deliveriesOn(a)).toHaveLength(0)
    expect((await mgr.sendMessage({ to: 'alpha', message: 'me' }, aScope)).content[0].text).toBe(
      'You cannot send a message to yourself.'
    )
    expect((await mgr.sendMessage({ to: 'nobody', message: 'x' }, null)).content[0].text).toBe(
      'No agent "nobody" in this session. Agents: alpha, beta'
    )
    b.push(deliveredEvent(deliveriesOn(b)[0]))
    await settle(a)
    await settle(b)
  })

  it('S6: names — duplicate (any case), reserved, uuid-shaped, too long or malformed → error, no spawn', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'Scout' }, 'call-1', null)
    const bad: Array<[string, string]> = [
      ['scout', 'An agent named "scout" already exists in this session.'],
      ['Main', 'agent "name" "Main" is reserved.'],
      ['team-lead', 'agent "name" "team-lead" is reserved.'],
      ['11111111-1111-4111-8111-111111111111', 'agent "name" may not look like an agent id.'],
      ['x'.repeat(65), 'agent "name" must be 1 to 64 characters.'],
      [
        '-dash',
        'agent "name" may use letters, digits, ".", "_" and "-", starting with a letter or digit.'
      ]
    ]
    for (const [name, text] of bad) {
      expect(await mgr.run({ description: 'd', prompt: 'p', name }, `c-${name}`, null)).toEqual({
        content: [{ type: 'text', text }],
        isError: true
      })
    }
    expect(fake.children).toHaveLength(1)
    await settle(fake.children[0])
  })

  it('K1: task_stop by name from the session stops the agent and its descendants, with a passive notification; a child may stop only its own descendants', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    await mgr.run({ description: 'd', prompt: 'p', name: 'other' }, 'call-O', null)
    const [lead, other] = fake.children
    await promptedWith(lead)
    const input = { description: 'g', prompt: 'q', name: 'grand' }
    await lead.opts.gateHandler({ toolCallId: 'call-G', toolName: 'agent', input })
    await lead.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'call-G' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(3))
    const grand = fake.children[2]

    const otherScope = await scopeOf(host, other)
    expect(mgr.taskStop({ task_id: 'grand' }, otherScope)).toEqual({
      content: [{ type: 'text', text: 'You can only stop agents you launched.' }],
      isError: true
    })
    const leadScope = await scopeOf(host, lead)
    expect(mgr.taskStop({ task_id: 'other' }, leadScope).content[0].text).toBe(
      'You can only stop agents you launched.'
    )

    expect(mgr.taskStop({ task_id: 'lead' }, null)).toEqual({
      content: [{ type: 'text', text: 'Stopped agent lead.' }]
    })
    expect(grand.commands().some((c) => c.type === 'abort')).toBe(true)
    expect(lead.commands().some((c) => c.type === 'abort')).toBe(true)
    grand.push({ type: 'agent_settled' })
    lead.push({ type: 'agent_settled' })
    await vi.waitFor(() =>
      expect(delivered.some((p) => p.details.toolUseId === 'call-L')).toBe(true)
    )
    const leadNote = delivered.find((p) => p.details.toolUseId === 'call-L')!
    expect(leadNote).toMatchObject({
      wake: false,
      details: { status: 'stopped', stoppedBy: 'agent' }
    })
    expect(leadNote.text).toContain('<summary>Agent "lead" was stopped</summary>')
    expect(mgr.taskStop({ task_id: 'lead' }, null).content[0].text).toBe(
      'Agent lead is not running.'
    )
    await settle(other)
  })

  it('G1: Send to background — the waiting call returns the async text, task-started re-armed with the same runIndex and isBackgrounded: true; completion notifies', async () => {
    const fake = makeFakeSpawn()
    const { host, sent, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const pending = mgr.run(
      { description: 'd', prompt: 'p', name: 'slow', run_in_background: false },
      'call-s',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]
    await promptedWith(child)
    const firstStart = sent.find(([c]) => c === 'session:task-started')![1] as Record<
      string,
      unknown
    >
    expect(firstStart.isBackgrounded).toBe(false)

    expect(mgr.background('call-s')).toEqual({ success: true })
    const r = await pending
    expect(r.content[0].text).toMatch(/^Async agent launched successfully\./)
    expect(r.details).toMatchObject({ cuiAgent: { background: true, status: 'async_launched' } })
    const starts = sent.filter(([c]) => c === 'session:task-started').map(([, d]) => d)
    expect(starts[1]).toMatchObject({
      toolUseId: 'call-s',
      runIndex: 1,
      startedAt: firstStart.startedAt,
      isBackgrounded: true
    })
    expect(mgr.liveBackgroundCount).toBe(1)
    expect(mgr.background('call-s')).toMatchObject({ success: false })

    await settle(child)
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]).toMatchObject({
      wake: true,
      details: { toolUseId: 'call-s', status: 'completed' }
    })
  })

  it('G2 (manager): a rebuilt depth-1 record is resumable by id; a vanished type refuses', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const id = '44444444-4444-4444-8444-444444444444'
    mgr.adoptRecord({
      agentId: id,
      originToolUseId: 'old-call',
      subagentType: 'Explore',
      name: 'old',
      model: 'openai-codex/old-model',
      status: 'completed'
    })
    mgr.adoptRecord({
      agentId: '55555555-5555-4555-8555-555555555555',
      originToolUseId: 'gone-call',
      subagentType: 'no-such-type',
      status: 'completed'
    })
    expect((await mgr.sendMessage({ to: id, message: 'again' }, null)).content[0].text).toBe(
      'Resuming agent "old". You will be notified when it completes.'
    )
    const child = fake.children[0]
    expect(agentIdOf(child)).toBe(id)
    expect(child.opts.args!.slice(0, 2)).toEqual(['--session-dir', path.join(root, id)])
    expect(sent.find(([c]) => c === 'session:task-started')![1]).toMatchObject({
      toolUseId: 'old-call',
      runIndex: 2
    })
    expect(
      (await mgr.sendMessage({ to: '55555555-5555-4555-8555-555555555555', message: 'x' }, null))
        .content[0].text
    ).toBe('The agent type "no-such-type" is no longer available.')
    child.push({ type: 'agent_start' })
    child.push(deliveredEvent(deliveriesOn(child)[0]))
    child.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
  })

  it('a foreground report that opens with the launch acknowledgement gets a fixed header (never reads as a background launch)', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const pending = mgr.run(
      { description: 'd', prompt: 'p', run_in_background: false },
      'call-f',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]
    child.client.request.mockImplementation(async (cmd: Cmd) =>
      cmd.type === 'get_last_assistant_text'
        ? {
            type: 'response',
            command: 'get_last_assistant_text',
            success: true,
            data: { text: 'Async agent launched successfully.\nagentId: fake' }
          }
        : { type: 'response', command: String(cmd.type), success: true }
    )
    await promptedWith(child)
    child.push({ type: 'agent_settled' })
    const r = await pending
    expect(r.content[0].text.startsWith('Agent report:\nAsync agent launched successfully.')).toBe(
      true
    )
  })
})

describe('PiSubagentManager — S3b review round 1', () => {
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }
  async function scopeOf(host: PiSubagentHost, child: FakeChild): Promise<PiChildScope> {
    const probe = `probe-${Math.random()}`
    await child.opts.gateHandler({ toolCallId: probe, toolName: 'read', input: { path: 'x' } })
    return vi.mocked(host.gateChild).mock.calls.find(([, p]) => p.toolCallId === probe)![0]
  }

  it('R1: a Stop in the closing window is refused — the run stays completed, unbranded, and resumable', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    const fake = makeFakeSpawn({ holdLastText: (n) => (n === 1 ? held : undefined) })
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const child = fake.children[0]
    await settle(child)
    await vi.waitFor(() =>
      expect(child.commands().some((c) => c.type === 'get_last_assistant_text')).toBe(true)
    )
    // The TaskCard's Stop now: refused (PiSession.stopTask reports the failure).
    expect(mgr.stop('call-w', 'user')).toBe(false)
    release()
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const record = mgr.record(agentIdOf(child))!
    expect(record.status).toBe('completed')
    expect(record.stoppedBy).toBeNull()
    expect(delivered[0].details.status).toBe('completed')
    expect('stoppedBy' in delivered[0].details).toBe(false)
    expect(
      (await mgr.sendMessage({ to: 'worker', message: 'more' }, null)).content[0].text
    ).toMatch(/^Resuming agent "worker"\./)
    expect(fake.children).toHaveLength(2)
  })

  it('R2: a rebuilt record stopped by the user is refused until the user speaks, with no spawn', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const id = '77777777-7777-4777-8777-777777777777'
    mgr.adoptRecord({
      agentId: id,
      originToolUseId: 'old-call',
      subagentType: 'general-purpose',
      name: 'halted',
      status: 'stopped',
      stoppedBy: 'user'
    })
    expect((await mgr.sendMessage({ to: 'halted', message: 'go' }, null)).content[0].text).toBe(
      'Agent "halted" was stopped by the user. Resume it only if the user asks you to; ' +
        'the user has not spoken since the stop.'
    )
    expect(fake.spawn).not.toHaveBeenCalled()
    mgr.userTurn()
    expect((await mgr.sendMessage({ to: 'halted', message: 'go' }, null)).content[0].text).toBe(
      'Resuming agent "halted". You will be notified when it completes.'
    )
    expect(fake.spawn).toHaveBeenCalledTimes(1)
    fake.children[0].push({ type: 'agent_start' })
    fake.children[0].push(deliveredEvent(deliveriesOn(fake.children[0])[0]))
    fake.children[0].push({ type: 'agent_settled' })
  })

  it('M1: a child stops its own descendant', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    const input = { description: 'g', prompt: 'q', name: 'grand' }
    await lead.opts.gateHandler({ toolCallId: 'call-G', toolName: 'agent', input })
    await lead.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'call-G' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const grand = fake.children[1]
    const leadScope = await scopeOf(host, lead)
    expect(mgr.taskStop({ task_id: 'grand' }, leadScope)).toEqual({
      content: [{ type: 'text', text: 'Stopped agent grand.' }]
    })
    expect(grand.commands().some((c) => c.type === 'abort')).toBe(true)
    expect(lead.commands().some((c) => c.type === 'abort')).toBe(false)
    grand.push({ type: 'agent_settled' })
    await settle(lead)
  })

  it('M2: an agent that cannot launch agents may steer a running one but not resume a finished one', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'done' }, 'call-done', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    await mgr.run({ description: 'd', prompt: 'p', name: 'live' }, 'call-live', null)
    await mgr.run(
      { description: 'd', prompt: 'p', name: 'explorer', subagent_type: 'Explore' },
      'call-ex',
      null
    )
    const [, live, explorer] = fake.children
    await promptedWith(live)
    const exScope = await scopeOf(host, explorer)
    expect(exScope.canSpawn).toBe(false)
    expect((await mgr.sendMessage({ to: 'live', message: 'hi' }, exScope)).isError).toBeUndefined()
    expect(deliveriesOn(live)).toHaveLength(1)
    expect(await mgr.sendMessage({ to: 'done', message: 'wake up' }, exScope)).toEqual({
      content: [
        {
          type: 'text',
          text: 'This agent cannot launch agents; it can only message running agents.'
        }
      ],
      isError: true
    })
    expect(fake.children).toHaveLength(3)
    live.push(deliveredEvent(deliveriesOn(live)[0]))
    await settle(live)
    await settle(explorer)
  })

  it("M3: a resumed run's judge sees the agent's earlier assistant actions (the trajectory spans runs)", async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const first = fake.children[0]
    await promptedWith(first)
    first.push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    first.push(usageEnd(1, 1))
    first.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const earlier = [...mgr.record(agentIdOf(first))!.trajectory.values()]
    expect(earlier).toHaveLength(1)

    await mgr.sendMessage({ to: 'worker', message: 'again' }, null)
    const second = fake.children[1]
    const scope = await scopeOf(host, second)
    expect([...scope.runner()!.trajectory.values()].map((m) => m.id)).toEqual([earlier[0].id])
    second.push({ type: 'agent_start' })
    second.push(deliveredEvent(deliveriesOn(second)[0]))
    second.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
  })

  it('M5: a resume by someone other than the owner says who will be notified', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'done' }, 'call-done', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    await mgr.run({ description: 'd', prompt: 'p', name: 'other' }, 'call-o', null)
    const otherScope = await scopeOf(host, fake.children[1])
    expect((await mgr.sendMessage({ to: 'done', message: 'x' }, otherScope)).content[0].text).toBe(
      'Resuming agent "done". The main session will be notified when it completes.'
    )
  })

  it('M9: attribute values lose quotes, angle brackets and line breaks', () => {
    expect(
      agentMessageText({ fromLabel: 'a"<b>\nc', fromId: 'id', summary: '<x>', message: 'm' })
    ).toBe('<agent-message from="a  b  c" from-id="id" summary=" x ">\nm\n</agent-message>')
  })

  it('M10: a grant minted before a stop does not run after it; a target still starting says so', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    let releaseSpawn: () => void = () => {}
    const spawnHeld = new Promise<void>((r) => (releaseSpawn = r))
    let holdNext = false
    const mgr = new PiSubagentManager(host, {
      spawn: async (o) => {
        if (holdNext) await spawnHeld
        return fake.spawn(o)
      },
      registry: builtins(),
      sessionsRoot: root
    })
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    const input = { description: 'g', prompt: 'q' }
    expect(await lead.opts.gateHandler({ toolCallId: 'pre', toolName: 'agent', input })).toEqual({
      behavior: 'allow'
    })
    mgr.stop('call-L', 'user')
    expect(
      await lead.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'pre' })
    ).toEqual({ content: [{ type: 'text', text: 'Agent stopped.' }], isError: true })
    expect(fake.children).toHaveLength(1)
    lead.push({ type: 'agent_settled' })

    holdNext = true
    const starting = mgr.run({ description: 'd', prompt: 'p', name: 'slow' }, 'call-S', null)
    await new Promise((r) => setTimeout(r, 10))
    expect((await mgr.sendMessage({ to: 'slow', message: 'x' }, null)).content[0].text).toBe(
      'Agent slow is starting; send the message again shortly.'
    )
    releaseSpawn()
    await starting
    await settle(fake.children[1])
  })
})

describe('PiSubagentManager — Fable arc review', () => {
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }

  it('F1: a grant minted in run 1 is not consumable in the resumed run 2 (no spawn, no gate call)', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const first = fake.children[0]
    await promptedWith(first)
    const input = { description: 'g', prompt: 'q' }
    expect(await first.opts.gateHandler({ toolCallId: 'pre', toolName: 'agent', input })).toEqual({
      behavior: 'allow'
    })
    // Stopped by an agent (resumable), never consumed.
    expect(mgr.taskStop({ task_id: 'lead' }, null).content[0].text).toBe('Stopped agent lead.')
    first.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))

    await mgr.sendMessage({ to: 'lead', message: 'continue' }, null)
    expect(fake.children).toHaveLength(2)
    const second = fake.children[1]
    const gateCalls = vi.mocked(host.gateChild).mock.calls.length
    expect(
      await second.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'pre' })
    ).toEqual({
      content: [{ type: 'text', text: 'hosted tool call was not approved through the tool gate' }],
      isError: true
    })
    expect(fake.children).toHaveLength(2)
    expect(vi.mocked(host.gateChild).mock.calls.length).toBe(gateCalls)
    second.push({ type: 'agent_start' })
    second.push(deliveredEvent(deliveriesOn(second)[0]))
    second.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
  })

  it('F2: a child stopped while it is still spawning gets no prompt and no abort, and ends stopped', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    const mgr = new PiSubagentManager(host, {
      spawn: async (o) => {
        await held
        return fake.spawn(o)
      },
      registry: builtins(),
      sessionsRoot: root
    })
    const pending = mgr.run(
      { description: 'd', prompt: 'p', run_in_background: false },
      'call-x',
      null
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stop('call-x', 'user')).toBe(true)
    release()
    expect(await pending).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Agent stopped by user.' }]
    })
    const types = fake.children[0].commands().map((c) => c.type)
    expect(types).not.toContain('prompt')
    expect(types).not.toContain('abort')
  })

  it('F5: a model-authored label is one line, without quotes or markup, at most 64 characters', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const description = `Fix "x" <b>now</b>\nsecond line ${'y'.repeat(80)}`
    await mgr.run({ description, prompt: 'p' }, 'call-l', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const label = mgr.record(agentIdOf(fake.children[0]))!.label
    expect(label.length).toBeLessThanOrEqual(64)
    expect(label).not.toMatch(/["<>\n]/)
    expect(delivered[0].title).toBe(`Agent "${label}" completed`)
  })

  it('F8: every launch rewrites the prompt file from the definition; an adopted record recovers its task', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const first = fake.children[0]
    await settle(first)
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const promptFile = path.join(root, agentIdOf(first), 'system-prompt.md')
    fs.writeFileSync(promptFile, 'tampered', 'utf-8')
    await mgr.sendMessage({ to: 'worker', message: 'again' }, null)
    expect(fs.readFileSync(promptFile, 'utf-8')).toBe(
      `${builtins().resolve('general-purpose')!.prompt}\n\n${PI_SUBAGENT_SUFFIX}\n\n` +
        piAgentIdentityBlock({ agentId: agentIdOf(first), name: 'worker', spawner: null })
    )
    const second = fake.children[1]
    second.push({ type: 'agent_start' })
    second.push(deliveredEvent(deliveriesOn(second)[0]))
    second.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))

    const id = '99999999-9999-4999-8999-999999999999'
    mgr.adoptRecord({
      agentId: id,
      originToolUseId: 'old',
      subagentType: 'general-purpose',
      description: 'Old task',
      prompt: 'THE ORIGINAL TASK',
      status: 'completed'
    })
    expect(mgr.record(id)!.scope).toMatchObject({
      prompt: 'THE ORIGINAL TASK',
      description: 'Old task'
    })
  })
})

describe('PiSubagentManager — logging (S4, ids and kinds only)', () => {
  let info: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    info = vi.spyOn(logger, 'info')
  })
  afterEach(() => {
    info.mockRestore()
  })
  /** Every PiSubagents info line logged so far. */
  const lines = (): string[] =>
    info.mock.calls.filter(([tag]) => tag === 'PiSubagents').map(([, msg]) => String(msg))
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }

  it('L1: one end line per run — background, foreground and a user stop', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)

    await mgr.run({ description: 'd', prompt: 'p' }, 'bg-l1', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(lines().filter((l) => / run 1 completed \(background\)$/.test(l))).toHaveLength(1)

    const fg = await (async () => {
      const pending = mgr.run(
        { description: 'd', prompt: 'p', run_in_background: false },
        'fg-l1',
        null
      )
      await vi.waitFor(() => expect(fake.children).toHaveLength(2))
      await settle(fake.children[1])
      return pending
    })()
    expect(fg.isError).toBeUndefined()
    expect(lines().filter((l) => / run 1 completed \(foreground\)$/.test(l))).toHaveLength(1)

    await mgr.run({ description: 'd', prompt: 'p' }, 'bg-stop', null)
    await vi.waitFor(() => expect(fake.children).toHaveLength(3))
    await promptedWith(fake.children[2])
    expect(mgr.stop('bg-stop', 'user')).toBe(true)
    fake.children[2].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(
      lines().filter((l) => / run 1 stopped \(by user\) \(background\)$/.test(l))
    ).toHaveLength(1)
    // No run logged its end twice.
    expect(lines().filter((l) => / run 1 (completed|stopped|failed)/.test(l))).toHaveLength(3)
  })

  it('L2: a background notification is logged with its delivery id, owner and wake — never its text', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)

    await mgr.run({ description: 'Scan it', prompt: 'p' }, 'bg-n1', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const wake = lines().filter((l) => l.startsWith('task-notification '))
    expect(wake).toEqual([
      `task-notification ${delivered[0].deliveryId} for agent ${delivered[0].details.agentId} run 1 → main (wake)`
    ])

    await mgr.run({ description: 'Stop it', prompt: 'p' }, 'bg-n2', null)
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    await promptedWith(fake.children[1])
    mgr.stop('bg-n2', 'user')
    fake.children[1].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(lines().filter((l) => l.startsWith('task-notification '))[1]).toBe(
      `task-notification ${delivered[1].deliveryId} for agent ${delivered[1].details.agentId} run 1 → main (passive)`
    )

    for (const l of lines()) {
      expect(l).not.toContain('report 1')
      expect(l).not.toContain('<task-notification>')
      expect(l).not.toContain('Scan it')
    }
  })

  it('L3: send_message to a running child logs (steer) with no message text', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    const child = fake.children[0]
    await promptedWith(child)
    await mgr.sendMessage({ to: 'worker', message: 'SECRET-BODY', summary: 'SECRET-SUM' }, null)
    const [p] = deliveriesOn(child)
    expect(lines().filter((l) => l.startsWith('agent-message '))).toEqual([
      `agent-message ${p.deliveryId} main → ${p.details.agentId} (steer)`
    ])
    for (const l of lines()) {
      expect(l).not.toContain('SECRET-BODY')
      expect(l).not.toContain('SECRET-SUM')
    }
    child.push(deliveredEvent(p))
    await settle(child)
  })
})

// ---------------------------------------------------------------------------
// S1 — resume rules: the user-stop hold and failure classification
// ---------------------------------------------------------------------------

/** pi's errored assistant message_end: the mapper turns it into the turn's `error` output. */
function errorEnd(errorMessage: string): Cmd {
  const m = (usageEnd(0, 0).message ?? {}) as Record<string, unknown>
  return { type: 'message_end', message: { ...m, stopReason: 'error', errorMessage } }
}

describe('PiSubagentManager — S1a: the user-stop hold', () => {
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }
  const HOLD = (label: string): string =>
    `Agent "${label}" was stopped by the user. Resume it only if the user asks you to; ` +
    'the user has not spoken since the stop.'
  /** Let a resumed child finish so the test leaves nothing running. */
  async function finishResume(child: FakeChild): Promise<void> {
    await vi.waitFor(() => expect(deliveriesOn(child)).toHaveLength(1))
    child.push({ type: 'agent_start' })
    child.push(deliveredEvent(deliveriesOn(child)[0]))
    child.push({ type: 'agent_settled' })
  }

  it('a user stop → send_message refused → userTurn() → send_message resumes', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    await promptedWith(fake.children[0])
    expect(mgr.stop('call-w', 'user')).toBe(true)
    fake.children[0].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const record = mgr.record(agentIdOf(fake.children[0]))!
    expect(record).toMatchObject({ status: 'stopped', stoppedBy: 'user', userStopHold: true })

    expect(await mgr.sendMessage({ to: 'worker', message: 'go on' }, null)).toEqual({
      content: [{ type: 'text', text: HOLD('worker') }],
      isError: true
    })
    expect(fake.children).toHaveLength(1)

    mgr.userTurn()
    expect(record.userStopHold).toBe(false)
    expect((await mgr.sendMessage({ to: 'worker', message: 'go on' }, null)).content[0].text).toBe(
      'Resuming agent "worker". You will be notified when it completes.'
    )
    expect(fake.children).toHaveLength(2)
    await finishResume(fake.children[1])
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    // The resumed run ended normally: nothing is held any more.
    expect(record).toMatchObject({ status: 'completed', stoppedBy: null, userStopHold: false })
  })

  it('a user turn while the stopped run is still draining is not undone by the run ending', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'worker' }, 'call-w', null)
    await promptedWith(fake.children[0])
    mgr.stop('call-w', 'user')
    const record = mgr.record(agentIdOf(fake.children[0]))!
    // The stop is recorded the moment it is made …
    expect(record.userStopHold).toBe(true)
    // … so a prompt the user types before the abort has drained is "since the stop".
    mgr.userTurn()
    fake.children[0].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(record).toMatchObject({ status: 'stopped', stoppedBy: 'user', userStopHold: false })
    expect((await mgr.sendMessage({ to: 'worker', message: 'x' }, null)).content[0].text).toMatch(
      /^Resuming agent "worker"\./
    )
    await finishResume(fake.children[1])
  })

  it('the hold covers every descendant a user stop cascaded to', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    const input = { description: 'g', prompt: 'q', name: 'grand' }
    await lead.opts.gateHandler({ toolCallId: 'call-G', toolName: 'agent', input })
    await lead.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'call-G' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const grand = fake.children[1]
    await promptedWith(grand)

    expect(mgr.stop('call-L', 'user')).toBe(true)
    grand.push({ type: 'agent_settled' })
    lead.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0))

    const leadRec = mgr.record(agentIdOf(lead))!
    const grandRec = mgr.record(agentIdOf(grand))!
    expect(leadRec).toMatchObject({ stoppedBy: 'user', userStopHold: true })
    expect(grandRec).toMatchObject({ stoppedBy: 'user', userStopHold: true })
    expect((await mgr.sendMessage({ to: 'grand', message: 'x' }, null)).content[0].text).toBe(
      HOLD('grand')
    )
    expect((await mgr.sendMessage({ to: 'lead', message: 'x' }, null)).content[0].text).toBe(
      HOLD('lead')
    )
    expect(fake.children).toHaveLength(2)

    mgr.userTurn()
    expect(grandRec.userStopHold).toBe(false)
    expect(leadRec.userStopHold).toBe(false)
    expect((await mgr.sendMessage({ to: 'grand', message: 'x' }, null)).content[0].text).toMatch(
      /^Resuming agent "grand"\./
    )
    await finishResume(fake.children[2])
  })

  it('task_stop (agent) and an interrupt leave the agent resumable with no user turn', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    // task_stop
    await mgr.run({ description: 'd', prompt: 'p', name: 'bg' }, 'call-bg', null)
    await promptedWith(fake.children[0])
    expect(mgr.taskStop({ task_id: 'bg' }, null).content[0].text).toBe('Stopped agent bg.')
    fake.children[0].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const bgRec = mgr.record(agentIdOf(fake.children[0]))!
    expect(bgRec).toMatchObject({ stoppedBy: 'agent', userStopHold: false })
    expect((await mgr.sendMessage({ to: 'bg', message: 'again' }, null)).content[0].text).toMatch(
      /^Resuming agent "bg"\./
    )
    await finishResume(fake.children[1])

    // interrupt (stopForeground)
    const fg = mgr.run(
      { description: 'd', prompt: 'p', name: 'fg', run_in_background: false },
      'call-fg',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(3))
    await promptedWith(fake.children[2])
    mgr.stopForeground('interrupt')
    fake.children[2].push({ type: 'agent_settled' })
    await fg
    const fgRec = mgr.record(agentIdOf(fake.children[2]))!
    expect(fgRec).toMatchObject({ stoppedBy: 'interrupt', userStopHold: false })
    expect((await mgr.sendMessage({ to: 'fg', message: 'again' }, null)).content[0].text).toMatch(
      /^Resuming agent "fg"\./
    )
    await finishResume(fake.children[3])
  })

  it('a rebuilt link that says stoppedBy user holds; any other stop reason does not', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const link = (id: string, name: string, stoppedBy: 'user' | 'agent') => ({
      agentId: id,
      originToolUseId: `call-${name}`,
      subagentType: 'general-purpose',
      name,
      status: 'stopped',
      stoppedBy
    })
    mgr.adoptRecord(link('88888888-8888-4888-8888-888888888888', 'u', 'user'))
    mgr.adoptRecord(link('99999999-9999-4999-8999-999999999999', 'a', 'agent'))
    expect(mgr.record('88888888-8888-4888-8888-888888888888')!.userStopHold).toBe(true)
    expect(mgr.record('99999999-9999-4999-8999-999999999999')!.userStopHold).toBe(false)
    expect((await mgr.sendMessage({ to: 'a', message: 'x' }, null)).content[0].text).toMatch(
      /^Resuming agent "a"\./
    )
    await finishResume(fake.children[0])
  })
})

describe('PiSubagentManager — S1b: failure classification', () => {
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }
  async function finishResume(child: FakeChild): Promise<void> {
    await vi.waitFor(() => expect(deliveriesOn(child)).toHaveLength(1))
    child.push({ type: 'agent_start' })
    child.push(deliveredEvent(deliveriesOn(child)[0]))
    child.push({ type: 'agent_settled' })
  }
  const OVERFLOW = 'prompt is too long: 213462 tokens > 200000 maximum'

  it('a permanent failure (context overflow) is recorded, persisted on the notification, and refuses the resume', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-w', null)
    await promptedWith(fake.children[0])
    fake.children[0].push(errorEnd(OVERFLOW))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const record = mgr.record(agentIdOf(fake.children[0]))!
    expect(record).toMatchObject({
      status: 'failed',
      failure: 'permanent',
      failureMessage: OVERFLOW
    })
    expect(delivered[0].details).toMatchObject({ status: 'failed', failure: 'permanent' })

    expect(await mgr.sendMessage({ to: 'w', message: 'retry' }, null)).toEqual({
      content: [
        {
          type: 'text',
          text:
            `Agent "w" failed (${OVERFLOW}) and cannot be resumed. ` +
            'Launch a new agent for the task if it is still needed.'
        }
      ],
      isError: true
    })
    expect(fake.children).toHaveLength(1)
  })

  it('a transient failure (provider overloaded) resumes like a completed agent', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-w', null)
    await promptedWith(fake.children[0])
    fake.children[0].push(errorEnd('529 {"type":"error","error":{"type":"overloaded_error"}}'))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].details).toMatchObject({ status: 'failed', failure: 'transient' })
    const record = mgr.record(agentIdOf(fake.children[0]))!
    expect(record).toMatchObject({ status: 'failed', failure: 'transient' })
    expect((await mgr.sendMessage({ to: 'w', message: 'retry' }, null)).content[0].text).toMatch(
      /^Resuming agent "w"\./
    )
    expect(fake.children).toHaveLength(2)
    // The new run clears the failure while it runs.
    expect(record).toMatchObject({ status: 'running', failure: null, failureMessage: null })
    await finishResume(fake.children[1])
  })

  it('a rejected credential (401) FAILS the run — it used to read as completed — and is transient and resumable', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-w', null)
    await promptedWith(fake.children[0])
    const auth = '401 {"type":"error","error":{"type":"authentication_error","message":"bad key"}}'
    fake.children[0].push(errorEnd(auth))
    // pi's own settle follows an errored turn; it must not turn the failure into a completion.
    fake.children[0].push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].details).toMatchObject({ status: 'failed', failure: 'transient' })
    expect(mgr.record(agentIdOf(fake.children[0]))).toMatchObject({
      status: 'failed',
      failure: 'transient',
      failureMessage: auth
    })
    expect((await mgr.sendMessage({ to: 'w', message: 'retry' }, null)).content[0].text).toMatch(
      /^Resuming agent "w"\./
    )
    await finishResume(fake.children[1])
  })

  it('a crashed child process is transient', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-w', null)
    await promptedWith(fake.children[0])
    fake.children[0].exit()
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].details).toMatchObject({ status: 'failed', failure: 'transient' })
    expect(mgr.record(agentIdOf(fake.children[0]))).toMatchObject({
      failure: 'transient',
      failureMessage: 'pi child process exited unexpectedly'
    })
    expect((await mgr.sendMessage({ to: 'w', message: 'retry' }, null)).content[0].text).toMatch(
      /^Resuming agent "w"\./
    )
    await finishResume(fake.children[1])
  })

  it('an unrecognised error is permanent', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-w', null)
    await promptedWith(fake.children[0])
    fake.children[0].push(
      errorEnd('The model returned something we do not understand\nsecond line')
    )
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    // Only the first line is kept.
    expect(mgr.record(agentIdOf(fake.children[0]))).toMatchObject({
      failure: 'permanent',
      failureMessage: 'The model returned something we do not understand'
    })
  })

  it('a FOREGROUND failure carries failure on details.cuiAgent (a stopped one does not)', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const failed = mgr.run(
      { description: 'd', prompt: 'p', name: 'f1', run_in_background: false },
      'call-f1',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    await promptedWith(fake.children[0])
    fake.children[0].push(errorEnd(OVERFLOW))
    const r = await failed
    expect(r.isError).toBe(true)
    expect(r.details).toMatchObject({
      cuiAgent: { status: 'failed', failure: 'permanent' }
    })

    const stopped = mgr.run(
      { description: 'd', prompt: 'p', name: 'f2', run_in_background: false },
      'call-f2',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    await promptedWith(fake.children[1])
    mgr.stop('call-f2', 'user')
    fake.children[1].push({ type: 'agent_settled' })
    const r2 = await stopped
    expect((r2.details as { cuiAgent: Record<string, unknown> }).cuiAgent).toMatchObject({
      status: 'stopped',
      stoppedBy: 'user'
    })
    expect('failure' in (r2.details as { cuiAgent: object }).cuiAgent).toBe(false)
  })

  it('a launch failure on a RESUME is transient and the agent resumes again; a first-run one keeps no record', async () => {
    const fake = makeFakeSpawn({ setModelFails: (n) => n === 2 })
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-w', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const record = mgr.record(agentIdOf(fake.children[0]))!

    // The resume's launch fails (child 2: set_model refused).
    expect(await mgr.sendMessage({ to: 'w', message: 'again' }, null)).toEqual({
      content: [{ type: 'text', text: 'Failed to start the agent: no such model' }],
      isError: true
    })
    expect(record).toMatchObject({
      status: 'failed',
      failure: 'transient',
      failureMessage: 'Failed to start the agent: no such model',
      runIndex: 1
    })
    // Transient: the next resume is allowed (child 3 starts).
    expect((await mgr.sendMessage({ to: 'w', message: 'again' }, null)).content[0].text).toMatch(
      /^Resuming agent "w"\./
    )
    await finishResume(fake.children[2])

    // A FIRST run that fails to launch never leaves a record to resume (permanent).
    const fake2 = makeFakeSpawn({ setModelFails: true })
    const mgr2 = mgrWith(fake2, makeOrderedHost().host)
    const r = await mgr2.run({ description: 'd', prompt: 'p', name: 'x' }, 'call-x', null)
    expect(r.isError).toBe(true)
    expect((await mgr2.sendMessage({ to: 'x', message: 'y' }, null)).content[0].text).toMatch(
      /^No agent "x" in this session/
    )
  })

  it('an adopted failed link: no failure field resumes (old histories); permanent is refused', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    const old = '11111111-1111-4111-8111-111111111111'
    const perm = '22222222-2222-4222-8222-222222222222'
    mgr.adoptRecord({
      agentId: old,
      originToolUseId: 'call-old',
      subagentType: 'general-purpose',
      name: 'old',
      status: 'failed'
    })
    mgr.adoptRecord({
      agentId: perm,
      originToolUseId: 'call-perm',
      subagentType: 'general-purpose',
      name: 'perm',
      status: 'failed',
      failure: 'permanent',
      failureMessage: 'prompt is too long: 213462 tokens'
    })
    mgr.adoptRecord({
      agentId: '33333333-3333-4333-8333-333333333333',
      originToolUseId: 'call-nomsg',
      subagentType: 'general-purpose',
      name: 'nomsg',
      status: 'failed',
      failure: 'permanent'
    })
    expect(mgr.record(old)).toMatchObject({ status: 'failed', failure: 'transient' })
    expect((await mgr.sendMessage({ to: 'old', message: 'x' }, null)).content[0].text).toMatch(
      /^Resuming agent "old"\./
    )
    expect(await mgr.sendMessage({ to: 'perm', message: 'x' }, null)).toEqual({
      content: [
        {
          type: 'text',
          text:
            'Agent "perm" failed (prompt is too long: 213462 tokens) and cannot be resumed. ' +
            'Launch a new agent for the task if it is still needed.'
        }
      ],
      isError: true
    })
    // A permanent link written without a message still refuses.
    expect((await mgr.sendMessage({ to: 'nomsg', message: 'x' }, null)).content[0].text).toBe(
      'Agent "nomsg" failed (a permanent error) and cannot be resumed. ' +
        'Launch a new agent for the task if it is still needed.'
    )
    expect(fake.children).toHaveLength(1)
    await finishResume(fake.children[0])
  })

  it('round trip: details.cuiAgent.failure and the notification details.failure → collectAgentLinkRecords → adoptRecord', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    // A foreground agent that fails permanently: its toolResult details carry failure.
    const fg = mgr.run(
      { description: 'd', prompt: 'p', name: 'fg', run_in_background: false },
      'call-fg',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    await promptedWith(fake.children[0])
    fake.children[0].push(errorEnd(OVERFLOW))
    const fgResult = await fg
    // A background agent that fails permanently: the launch result has no failure, its notification does.
    const bgLaunch = await mgr.run({ description: 'd', prompt: 'p', name: 'bg' }, 'call-bg', null)
    await promptedWith(fake.children[1])
    fake.children[1].push(errorEnd(OVERFLOW))
    await vi.waitFor(() => expect(delivered).toHaveLength(1))

    let seq = 0
    const base = () => ({ id: `e${seq++}`, parentId: null, timestamp: '2024-01-01T00:00:00.000Z' })
    const toolResult = (callId: string, r: { details?: unknown }): PiSessionEntry =>
      ({
        ...base(),
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'agent',
          content: [{ type: 'text', text: 'x' }],
          details: r.details,
          isError: false,
          timestamp: 1
        }
      }) as PiSessionEntry
    const note: PiSessionEntry = {
      ...base(),
      type: 'custom_message',
      customType: 'claudeui-agent-message',
      content: [{ type: 'text', text: 'n' }],
      display: true,
      details: {
        v: 1,
        kind: 'task-notification',
        title: 't',
        ...delivered[0].details,
        deliveryId: 'd1'
      }
    } as PiSessionEntry
    const links = collectAgentLinkRecords([
      toolResult('call-fg', fgResult),
      toolResult('call-bg', bgLaunch),
      note
    ])
    // Both persisted shapes carry the message beside the classification.
    expect(fgResult.details).toMatchObject({
      cuiAgent: { failure: 'permanent', failureMessage: OVERFLOW }
    })
    expect(delivered[0].details).toMatchObject({ failure: 'permanent', failureMessage: OVERFLOW })
    expect(links.map((l) => [l.name, l.status, l.failure, l.failureMessage])).toEqual([
      ['fg', 'failed', 'permanent', OVERFLOW],
      ['bg', 'failed', 'permanent', OVERFLOW]
    ])

    const mgr2 = mgrWith(makeFakeSpawn(), makeOrderedHost().host)
    for (const l of links) mgr2.adoptRecord(l)
    for (const name of ['fg', 'bg']) {
      expect(mgr2.record(links.find((l) => l.name === name)!.agentId)).toMatchObject({
        status: 'failed',
        failure: 'permanent',
        failureMessage: OVERFLOW
      })
      expect((await mgr2.sendMessage({ to: name, message: 'x' }, null)).content[0].text).toBe(
        `Agent "${name}" failed (${OVERFLOW}) and cannot be resumed. ` +
          'Launch a new agent for the task if it is still needed.'
      )
    }
  })
})

// ---------------------------------------------------------------------------
// S2 — identity block and the foreground channel rule
// ---------------------------------------------------------------------------

describe('piAgentIdentityBlock (S2)', () => {
  const ID = '11111111-1111-4111-8111-111111111111'
  const TAIL =
    'Messages from other agents arrive inside <agent-message from="…" from-id="…"> tags; reply ' +
    'with send_message to that from-id. An agent you message that has already finished is ' +
    'resumed with your message, which costs a new run: message agents only when it helps the task.'

  it('depth 1: launched by the main session, handle main; the name is optional', () => {
    expect(piAgentIdentityBlock({ agentId: ID, spawner: null })).toBe(
      [
        `Your agent id is ${ID}. You were launched by the main session.`,
        "To message the agent that launched you while you run in the background, use send_message with to: 'main'. " +
          'In the foreground your final report is your only channel to it.',
        TAIL
      ].join('\n')
    )
    expect(piAgentIdentityBlock({ agentId: ID, name: 'scout', spawner: null })).toContain(
      `Your agent id is ${ID} and your name is "scout". You were launched by the main session.`
    )
  })

  it('depth 2: launched by an agent, addressed by its handle (name or id); the label is cleaned', () => {
    const named = piAgentIdentityBlock({
      agentId: ID,
      name: 'grand',
      spawner: { label: 'lead "boss"\nx', handle: 'lead' }
    })
    expect(named).toContain(`and your name is "grand". You were launched by agent "lead  boss  x".`)
    expect(named).toContain("to: 'lead'.")
    const unnamed = piAgentIdentityBlock({
      agentId: ID,
      spawner: { label: 'Scan the repo', handle: '22222222-2222-4222-8222-222222222222' }
    })
    expect(unnamed).toContain(`Your agent id is ${ID}. You were launched by agent "Scan the repo".`)
    expect(unnamed).toContain("to: '22222222-2222-4222-8222-222222222222'.")
    expect(unnamed).not.toContain('your name is')
  })
})

describe('PiSubagentManager — S2: identity in the system prompt, foreground channel', () => {
  function mgrWith(fake: ReturnType<typeof makeFakeSpawn>, host: PiSubagentHost) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry: builtins(),
      sessionsRoot: root
    })
  }
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }
  async function scopeOf(host: PiSubagentHost, child: FakeChild): Promise<PiChildScope> {
    const probe = `probe-${Math.random()}`
    await child.opts.gateHandler({ toolCallId: probe, toolName: 'read', input: { path: 'x' } })
    return vi.mocked(host.gateChild).mock.calls.find(([, p]) => p.toolCallId === probe)![0]
  }
  const promptOf = (mgr: PiSubagentManager, child: FakeChild): string =>
    fs.readFileSync(mgr.record(agentIdOf(child))!.promptFile, 'utf-8')
  const REFUSAL =
    'You are running in the foreground; your final report is returned to the agent that launched you.'

  it('every launch appends the identity block to system-prompt.md: depth 1 and depth 2, and a resume rewrites it', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    const leadId = agentIdOf(lead)
    const text = promptOf(mgr, lead)
    expect(text).toContain(PI_SUBAGENT_SUFFIX)
    expect(text).toContain(
      `Your agent id is ${leadId} and your name is "lead". You were launched by the main session.\n` +
        "To message the agent that launched you while you run in the background, use send_message with to: 'main'. " +
        'In the foreground your final report is your only channel to it.\n' +
        'Messages from other agents arrive inside <agent-message from="…" from-id="…"> tags; reply '
    )

    // Depth 2: a named grandchild, addressed through its spawner's NAME.
    const input = { description: 'g', prompt: 'q', name: 'grand' }
    await lead.opts.gateHandler({ toolCallId: 'call-G', toolName: 'agent', input })
    await lead.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'call-G' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const grand = fake.children[1]
    const grandText = promptOf(mgr, grand)
    expect(grandText).toContain(
      `Your agent id is ${agentIdOf(grand)} and your name is "grand". You were launched by agent "lead".`
    )
    expect(grandText).toContain("use send_message with to: 'lead'.")

    // Finish everything, then resume `grand`: the file is rewritten (still carrying the block).
    grand.push({ type: 'agent_settled' })
    lead.push({ type: 'agent_settled' })
    await vi.waitFor(() => expect(mgr.liveCount).toBe(0))
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0))
    fs.writeFileSync(mgr.record(agentIdOf(grand))!.promptFile, 'stale')
    expect(
      (await mgr.sendMessage({ to: 'grand', message: 'again' }, null)).content[0].text
    ).toMatch(/^Resuming agent "grand"\./)
    expect(promptOf(mgr, fake.children[2])).toContain(
      `Your agent id is ${agentIdOf(grand)} and your name is "grand". You were launched by agent "lead".`
    )
    fake.children[2].push({ type: 'agent_start' })
    fake.children[2].push(deliveredEvent(deliveriesOn(fake.children[2])[0]))
    fake.children[2].push({ type: 'agent_settled' })
  })

  it('an unnamed spawner is addressed by its id', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'Scan the repo', prompt: 'p' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    const input = { description: 'g', prompt: 'q' }
    await lead.opts.gateHandler({ toolCallId: 'call-G', toolName: 'agent', input })
    await lead.opts.hostedToolHandler!({ toolName: 'agent', input, toolCallId: 'call-G' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const grandText = promptOf(mgr, fake.children[1])
    expect(grandText).toContain(`You were launched by agent "Scan the repo".`)
    expect(grandText).toContain(`use send_message with to: '${agentIdOf(lead)}'.`)
    expect(grandText).not.toContain('your name is')
    fake.children[1].push({ type: 'agent_settled' })
    lead.push({ type: 'agent_settled' })
  })

  it('a FOREGROUND child is refused when it messages its launcher by id or by name; a BACKGROUND one steers it', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    const leadId = agentIdOf(lead)

    const fgInput = { description: 'f', prompt: 'q', name: 'fg', run_in_background: false }
    await lead.opts.gateHandler({ toolCallId: 'call-F', toolName: 'agent', input: fgInput })
    const fgRun = lead.opts.hostedToolHandler!({
      toolName: 'agent',
      input: fgInput,
      toolCallId: 'call-F'
    })
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    const fg = fake.children[1]
    await promptedWith(fg)
    const fgScope = await scopeOf(host, fg)
    for (const to of ['lead', leadId]) {
      expect(await mgr.sendMessage({ to, message: 'hi' }, fgScope)).toEqual({
        content: [{ type: 'text', text: REFUSAL }],
        isError: true
      })
    }
    expect(deliveriesOn(lead)).toHaveLength(0)
    // Only its launcher is off limits: itself keeps its own rule.
    expect((await mgr.sendMessage({ to: 'fg', message: 'me' }, fgScope)).content[0].text).toBe(
      'You cannot send a message to yourself.'
    )

    const bgInput = { description: 'b', prompt: 'q', name: 'bg' }
    await lead.opts.gateHandler({ toolCallId: 'call-B', toolName: 'agent', input: bgInput })
    await lead.opts.hostedToolHandler!({ toolName: 'agent', input: bgInput, toolCallId: 'call-B' })
    await vi.waitFor(() => expect(fake.children).toHaveLength(3))
    const bg = fake.children[2]
    await promptedWith(bg)
    const bgScope = await scopeOf(host, bg)
    expect((await mgr.sendMessage({ to: 'lead', message: 'found it' }, bgScope)).isError).toBe(
      undefined
    )
    expect(deliveriesOn(lead)).toHaveLength(1)
    expect(deliveriesOn(lead)[0]).toMatchObject({ details: { from: 'bg' } })

    lead.push(deliveredEvent(deliveriesOn(lead)[0]))
    bg.push({ type: 'agent_settled' })
    fg.push({ type: 'agent_settled' })
    await fgRun
    lead.push({ type: 'agent_settled' })
  })
})

// ---------------------------------------------------------------------------
// S3 — model resolution and list_models
// ---------------------------------------------------------------------------

describe('PiSubagentManager — S3: model resolution and list_models', () => {
  const entry = (provider: string, id: string, name = id) => ({
    provider,
    id,
    name,
    contextWindow: 200_000,
    reasoning: false,
    input: ['text'],
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }
  })
  const CATALOG = [
    entry('anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5'),
    entry('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5'),
    entry('openai-codex', 'gpt-5.6-luna', 'GPT-5.6 Luna')
  ]
  function mgrWith(
    fake: ReturnType<typeof makeFakeSpawn>,
    host: PiSubagentHost,
    catalog?: () => Promise<typeof CATALOG>,
    registry: PiAgentRegistry = builtins()
  ) {
    return new PiSubagentManager(host, {
      spawn: fake.spawn,
      registry,
      sessionsRoot: root,
      ...(catalog ? { catalog } : {})
    })
  }
  const setModelOf = (child: FakeChild): string =>
    String(child.commands().find((c) => c.type === 'set_model')?.modelId)
  const agentIdOf = (child: FakeChild): string => {
    const args = child.opts.args!
    return args[args.indexOf('--session-id') + 1]
  }

  it('an alias resolves against the catalog: the child and the record carry the RESOLVED value', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host, async () => CATALOG)
    const pending = mgr.run(
      { description: 'd', prompt: 'p', model: 'opus', name: 'w', run_in_background: false },
      'call-w',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(1))
    const child = fake.children[0]
    await settle(child)
    await pending
    expect(setModelOf(child)).toBe('claude-opus-4-5-20251101')
    expect(mgr.record(agentIdOf(child))!.model).toBe('anthropic/claude-opus-4-5-20251101')
  })

  it('details.cuiAgent.model of a foreground and a background launch is the resolved value', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host, async () => CATALOG)
    const bg = await mgr.run({ description: 'd', prompt: 'p', model: 'sonnet' }, 'call-bg', null)
    expect(bg.details).toMatchObject({ cuiAgent: { model: 'anthropic/claude-sonnet-4-5' } })
    const fg = mgr.run(
      { description: 'd', prompt: 'p', model: 'GPT-5.6-LUNA', run_in_background: false },
      'call-fg',
      null
    )
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    await settle(fake.children[1])
    await settle(fake.children[0])
    expect((await fg).details).toMatchObject({
      cuiAgent: { model: 'openai-codex/gpt-5.6-luna' }
    })
  })

  it('an unknown model refuses the launch: an error result, no spawn, no record', async () => {
    const fake = makeFakeSpawn()
    const { host, sent } = makeOrderedHost()
    const mgr = mgrWith(fake, host, async () => CATALOG)
    expect(
      await mgr.run({ description: 'd', prompt: 'p', model: 'gpt-9', name: 'w' }, 'call-w', null)
    ).toEqual({
      content: [
        {
          type: 'text',
          text: 'Unknown model "gpt-9". Call list_models to see the models available to agents.'
        }
      ],
      isError: true
    })
    expect(fake.spawn).not.toHaveBeenCalled()
    expect(mgr.liveCount).toBe(0)
    expect(sent.some(([c]) => c === 'session:task-started')).toBe(false)
    expect((await mgr.sendMessage({ to: 'w', message: 'x' }, null)).content[0].text).toMatch(
      /^No agent "w"/
    )
  })

  it("a definition's own model goes through the resolver too; the parent's live model fallback is NOT re-validated", async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const def: PiAgentDefinition = {
      ...builtins().resolve('general-purpose')!,
      name: 'pinned',
      model: 'anthropic/claude-gone'
    }
    const mgr = mgrWith(fake, host, async () => CATALOG, registryWith([def]))
    const refused = await mgr.run(
      { description: 'd', prompt: 'p', subagent_type: 'pinned' },
      'call-1',
      null
    )
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('Unknown model "anthropic/claude-gone"')
    expect(fake.spawn).not.toHaveBeenCalled()

    // No explicit model: the parent's model (not in the catalog at all) is used as is.
    await mgr.run({ description: 'd', prompt: 'p', name: 'w' }, 'call-2', null)
    expect(mgr.record(agentIdOf(fake.children[0]))!.model).toBe('openai-codex/parent-model')
    await settle(fake.children[0])
  })

  it('an empty catalog, or a discovery that throws, passes the model through unchanged and never throws out of run()', async () => {
    for (const catalog of [
      async () => [],
      async (): Promise<typeof CATALOG> => {
        throw new Error('probe failed')
      }
    ]) {
      const fake = makeFakeSpawn()
      const { host } = makeOrderedHost()
      const mgr = mgrWith(fake, host, catalog)
      const r = await mgr.run(
        { description: 'd', prompt: 'p', model: 'opus', name: 'w' },
        'call-w',
        null
      )
      expect(r.isError).toBeUndefined()
      expect(mgr.record(agentIdOf(fake.children[0]))!.model).toBe('opus')
      await settle(fake.children[0])
    }
  })

  it('two parallel agent calls with the SAME name and a model to resolve: exactly one spawns (uniqueness is checked after the catalog await)', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    let release: (c: typeof CATALOG) => void = () => {}
    const gate = new Promise<typeof CATALOG>((r) => (release = r))
    const mgr = mgrWith(fake, host, () => gate)
    const first = mgr.run(
      { description: 'd', prompt: 'p', name: 'dup', model: 'opus' },
      'call-1',
      null
    )
    const second = mgr.run(
      { description: 'd', prompt: 'p', name: 'dup', model: 'opus' },
      'call-2',
      null
    )
    // Both calls are parked on the catalog read; neither has claimed the name.
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.spawn).not.toHaveBeenCalled()
    release(CATALOG)
    const results = await Promise.all([first, second])
    expect(fake.spawn).toHaveBeenCalledTimes(1)
    const refused = results.filter((r) => r.isError)
    expect(refused).toHaveLength(1)
    expect(refused[0].content[0].text).toBe('An agent named "dup" already exists in this session.')
    await settle(fake.children[0])
  })

  it('a resume reuses the stored resolved model unchanged', async () => {
    const fake = makeFakeSpawn()
    const { host, delivered } = makeOrderedHost()
    const mgr = mgrWith(fake, host, async () => CATALOG)
    await mgr.run({ description: 'd', prompt: 'p', model: 'opus', name: 'w' }, 'call-w', null)
    await settle(fake.children[0])
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    await mgr.sendMessage({ to: 'w', message: 'again' }, null)
    expect(setModelOf(fake.children[1])).toBe('claude-opus-4-5-20251101')
    fake.children[1].push({ type: 'agent_start' })
    fake.children[1].push(deliveredEvent(deliveriesOn(fake.children[1])[0]))
    fake.children[1].push({ type: 'agent_settled' })
  })

  it('listModels: the session model first, the filter, the cap, zero matches', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const many = Array.from({ length: 120 }, (_, i) =>
      entry('p', `model-${String(i).padStart(3, '0')}`)
    )
    const mgr = mgrWith(fake, host, async () => [...CATALOG, ...many])
    const all = (await mgr.listModels({})).content[0].text.split('\n')
    expect(all[0]).toBe('Current session model: openai-codex/parent-model')
    expect(all[1]).toBe(
      'anthropic/claude-opus-4-5-20251101 — Claude Opus 4.5 · 200k ctx · $3/$15 per M tokens'
    )
    expect(all).toHaveLength(1 + 100 + 1)
    expect(all[all.length - 1]).toBe('… 23 more — pass query to narrow.')

    const filtered = (await mgr.listModels({ query: 'SONNET' })).content[0].text
    expect(filtered.split('\n')).toEqual([
      'Current session model: openai-codex/parent-model',
      'anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5 · 200k ctx · $3/$15 per M tokens'
    ])
    expect((await mgr.listModels({ query: 'zzz' })).content[0].text).toContain('No model matches')
    expect(await mgr.listModels({ query: 3 })).toEqual({
      content: [{ type: 'text', text: 'list_models "query" must be a string.' }],
      isError: true
    })
  })

  it('listModels degrades to the empty-catalog text when discovery throws', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host, async () => {
      throw new Error('probe failed')
    })
    const r = await mgr.listModels({})
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toContain('No models could be listed')
  })

  it('a child calls list_models through its own gate grant, and without one is refused', async () => {
    const fake = makeFakeSpawn()
    const { host } = makeOrderedHost()
    const mgr = mgrWith(fake, host, async () => CATALOG)
    await mgr.run({ description: 'd', prompt: 'p', name: 'lead' }, 'call-L', null)
    const lead = fake.children[0]
    await promptedWith(lead)
    expect(
      (await lead.opts.hostedToolHandler!({ toolName: 'list_models', input: {}, toolCallId: 'x' }))
        .isError
    ).toBe(true)
    await lead.opts.gateHandler({ toolCallId: 'call-LM', toolName: 'list_models', input: {} })
    const r = await lead.opts.hostedToolHandler!({
      toolName: 'list_models',
      input: { query: 'luna' },
      toolCallId: 'call-LM'
    })
    expect(r.content[0].text).toContain('openai-codex/gpt-5.6-luna')
    await settle(lead)
  })
})
