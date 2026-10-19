/**
 * @vitest-environment node
 *
 * The run registry and the live parent facade (ADR-105, slice B-2a): the two small
 * modules the dispatcher's run engine is built on. The dispatcher's own behaviour on
 * top of them (background launches, disposeFor, stop) is in
 * `main/services/__tests__/cross-engine-dispatcher.component.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DispatchRun,
  DispatchRunRegistry,
  MAX_RENAMED_PARENTS,
  type DispatchRunInit
} from '../dispatch-runs'
import {
  COLD_TRANSCRIPT_TTL_MS,
  makeRunContext,
  type DispatchParentLookup,
  type LiveParentSession
} from '../dispatch-parent'
import type { DispatchContext } from '../cross-engine-dispatcher'
import type { ChatMessage } from '../../../shared/types'

function makeRun(overrides: Partial<DispatchRunInit> = {}): DispatchRun {
  return new DispatchRun({
    parentId: 'p-1',
    toolUseId: 'toolu_1',
    background: false,
    engine: 'claude',
    name: null,
    description: undefined,
    continuation: false,
    launchMode: 'default',
    startedAt: 1,
    ...overrides
  })
}

const msg = (id: string): ChatMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: id }],
  timestamp: 0
})

describe('DispatchRunRegistry', () => {
  it('finds a run by its tool_use id from registration, and by its ledger id once it is bound', () => {
    const registry = new DispatchRunRegistry()
    const run = makeRun()
    registry.add(run)
    expect(registry.find('toolu_1')).toBe(run)
    expect(registry.find('s-abc123')).toBeUndefined()
    registry.bind(run, 's-abc123', 'harness-1')
    expect(registry.find('s-abc123')).toBe(run)
    expect(registry.find('toolu_1')).toBe(run)
    expect(run).toMatchObject({ bound: true, ledgerId: 's-abc123', harnessId: 'harness-1' })
  })

  it('counts runs, and forgets a run on every key when it is removed', () => {
    const registry = new DispatchRunRegistry()
    const a = makeRun({ toolUseId: 'toolu_a' })
    const b = makeRun({ toolUseId: undefined })
    registry.add(a)
    registry.add(b)
    registry.bind(a, 's-a', 'h-a')
    expect(registry.size).toBe(2)
    registry.remove(a)
    expect(registry.size).toBe(1)
    expect(registry.find('toolu_a')).toBeUndefined()
    expect(registry.find('s-a')).toBeUndefined()
  })

  it('a later run reusing a tool_use id is not unregistered by the earlier one ending', () => {
    const registry = new DispatchRunRegistry()
    const first = makeRun({ toolUseId: 'toolu_same' })
    const second = makeRun({ toolUseId: 'toolu_same' })
    registry.add(first)
    registry.add(second)
    registry.remove(first)
    expect(registry.find('toolu_same')).toBe(second)
  })

  it('follows a parent through its re-keys, including a chain of them', () => {
    const registry = new DispatchRunRegistry()
    expect(registry.parentOf('tmp-1')).toBe('tmp-1')
    registry.rekey('tmp-1', 'uuid-1')
    expect(registry.parentOf('tmp-1')).toBe('uuid-1')
    registry.rekey('uuid-1', 'uuid-2')
    expect(registry.parentOf('tmp-1')).toBe('uuid-2')
    // A degenerate cycle terminates.
    registry.rekey('a', 'b')
    registry.rekey('b', 'a')
    expect(['a', 'b']).toContain(registry.parentOf('a'))
  })

  it('remembers a bounded number of rekeys, newest kept', () => {
    const registry = new DispatchRunRegistry()
    for (let i = 0; i <= MAX_RENAMED_PARENTS; i++) registry.rekey(`tmp-${i}`, `uuid-${i}`)
    expect(registry.parentOf('tmp-0')).toBe('tmp-0')
    expect(registry.parentOf(`tmp-${MAX_RENAMED_PARENTS}`)).toBe(`uuid-${MAX_RENAMED_PARENTS}`)
    expect(registry.parentOf('tmp-1')).toBe('uuid-1')
  })

  it('holds a name for a launch that has no ledger row yet, for the same parent only', () => {
    const registry = new DispatchRunRegistry()
    const launching = makeRun({ name: 'impl' })
    registry.add(launching)
    expect(registry.holdingName('p-1', 'impl')).toBe(launching)
    expect(registry.holdingName('p-2', 'impl')).toBeUndefined()
    expect(registry.holdingName('p-1', 'other')).toBeUndefined()
    // A re-keyed parent still owns it.
    registry.rekey('p-1', 'p-uuid')
    expect(registry.holdingName('p-uuid', 'impl')).toBe(launching)
    // Once it has a row, the ledger is the one place the name lives.
    registry.bind(launching, 's-1', 'h-1')
    expect(registry.holdingName('p-uuid', 'impl')).toBeUndefined()
  })

  it('a continuation holds no name', () => {
    const registry = new DispatchRunRegistry()
    registry.add(makeRun({ name: 'impl', continuation: true }))
    expect(registry.holdingName('p-1', 'impl')).toBeUndefined()
  })
})

describe('makeRunContext — the live parent', () => {
  function setup(
    opts: {
      sessions?: Map<string, LiveParentSession>
      canonical?: Record<string, ChatMessage[]>
      cold?: ChatMessage[]
    } = {}
  ) {
    const sessions = opts.sessions ?? new Map<string, LiveParentSession>()
    const emitted: unknown[][] = []
    const readMessages = vi.fn(async () => opts.cold ?? [])
    const parents: DispatchParentLookup = {
      session: (id) => sessions.get(id),
      emit: (id, channel, data) => {
        emitted.push([id, channel, data])
      },
      canonicalMessages: (id) => opts.canonical?.[id] ?? [],
      readMessages
    }
    const registry = new DispatchRunRegistry()
    const run = makeRun({ parentId: 'tmp-1' })
    let clock = 0
    const base: DispatchContext = {
      fromEngine: 'claude',
      fromRoutingId: 'tmp-1',
      cwd: '/proj',
      getAutonomyMode: () => 'call-time-mode',
      getMessages: () => [msg('stale-closure')],
      emit: vi.fn(),
      toolUseId: 'toolu_1'
    }
    const ctx = makeRunContext({
      base,
      run,
      registry,
      parents,
      launchMode: () => run.launchMode,
      now: () => clock
    })
    return {
      sessions,
      emitted,
      readMessages,
      registry,
      run,
      ctx,
      base,
      tick: (ms: number) => (clock += ms)
    }
  }

  it('emits under the parent’s durable id, never through the launching call’s closure', () => {
    const t = setup()
    t.ctx.emit('session:task-progress', { n: 1 })
    t.registry.rekey('tmp-1', 'uuid-1')
    t.ctx.emit('session:task-progress', { n: 2 })
    expect(t.emitted).toEqual([
      ['tmp-1', 'session:task-progress', { n: 1 }],
      ['uuid-1', 'session:task-progress', { n: 2 }]
    ])
    expect(t.base.emit).not.toHaveBeenCalled()
    expect(t.ctx.fromRoutingId).toBe('uuid-1')
  })

  it('reads the mode, transcript, queue, blocked calls and cost from whatever object answers now', () => {
    const t = setup()
    const cost = vi.fn()
    const v1: LiveParentSession = {
      getAutonomyMode: () => 'default',
      getMessages: () => [msg('v1')],
      queuedUserTurns: () => [msg('q1')],
      addDispatchedCost: cost
    }
    t.sessions.set('tmp-1', v1)
    expect(t.ctx.getAutonomyMode()).toBe('default')
    expect(t.ctx.getMessages().map((m) => m.id)).toEqual(['v1'])
    expect(t.ctx.getQueuedUserTurns!().map((m) => m.id)).toEqual(['q1'])
    t.ctx.addDispatchedCost!('pi', 'm', 1)
    expect(cost).toHaveBeenCalledWith('pi', 'm', 1)

    // The parent respawned: a NEW object under the same id.
    const ledger = { record: vi.fn() } as unknown as NonNullable<LiveParentSession['blockedCalls']>
    t.sessions.set('tmp-1', {
      getAutonomyMode: () => 'auto',
      getMessages: () => [msg('v2')],
      blockedCalls: ledger
    })
    expect(t.ctx.getAutonomyMode()).toBe('auto')
    expect(t.ctx.getMessages().map((m) => m.id)).toEqual(['v2'])
    expect(t.ctx.getQueuedUserTurns!()).toEqual([])
    expect(t.ctx.blockedCalls).toBe(ledger)
  })

  it('with no parent object the mode is the target’s launch mode, not the call’s and not a default', () => {
    const t = setup()
    t.run.launchMode = 'acceptEdits'
    expect(t.ctx.getAutonomyMode()).toBe('acceptEdits')
    expect(t.ctx.blockedCalls).toBeUndefined()
    expect(() => t.ctx.addDispatchedCost!('pi', 'm', 1)).not.toThrow()
  })

  it('a parent whose engine is down never loosens the launch mode; a live parent’s mode is its current word', () => {
    const t = setup()
    t.run.launchMode = 'default'
    const parent = (mode: string, live: boolean | undefined): LiveParentSession => ({
      getAutonomyMode: () => mode,
      getMessages: () => [],
      ...(live === undefined ? {} : { isEngineLive: () => live })
    })
    // Loosened after the launch, then the engine went down: the launch mode wins.
    t.sessions.set('tmp-1', parent('auto', false))
    expect(t.ctx.getAutonomyMode()).toBe('default')
    // Tightened and down: the tighter mode stands.
    t.sessions.set('tmp-1', parent('plan', false))
    expect(t.ctx.getAutonomyMode()).toBe('plan')
    // Live: whatever the user has set now, tighter or looser than the launch.
    t.sessions.set('tmp-1', parent('plan', true))
    expect(t.ctx.getAutonomyMode()).toBe('plan')
    t.sessions.set('tmp-1', parent('acceptEdits', true))
    expect(t.ctx.getAutonomyMode()).toBe('acceptEdits')
    // A double that says nothing about its engine is live.
    t.sessions.set('tmp-1', parent('acceptEdits', undefined))
    expect(t.ctx.getAutonomyMode()).toBe('acceptEdits')
  })

  it('the same holds when the modes are spelled as AutonomyModes: launched under full, a parent now at ask is ask', () => {
    const t = setup()
    const down = (mode: string): LiveParentSession => ({
      getAutonomyMode: () => mode,
      getMessages: () => [],
      isEngineLive: () => false
    })
    t.run.launchMode = 'full'
    t.sessions.set('tmp-1', down('ask'))
    expect(t.ctx.getAutonomyMode()).toBe('ask')
    // Launched under ask, loosened to full while down: ask stands.
    t.run.launchMode = 'ask'
    t.sessions.set('tmp-1', down('full'))
    expect(t.ctx.getAutonomyMode()).toBe('ask')
    t.run.launchMode = 'autoEdit'
    t.sessions.set('tmp-1', down('full'))
    expect(t.ctx.getAutonomyMode()).toBe('autoEdit')
  })

  it('concurrent asks share ONE cold read', async () => {
    const t = setup({ cold: [msg('cold')] })
    const [a, b, c] = await Promise.all([
      t.ctx.loadMessages!(),
      t.ctx.loadMessages!(),
      t.ctx.loadMessages!()
    ])
    expect([a, b, c].map((m) => m.map((x) => x.id))).toEqual([['cold'], ['cold'], ['cold']])
    expect(t.readMessages).toHaveBeenCalledTimes(1)
  })

  it('the transcript is live first, then canonical, and only then read cold — once per interval', async () => {
    const t = setup({ canonical: { 'tmp-1': [] }, cold: [msg('cold')] })
    // Nothing live and canonical holds nothing (evicted on disconnect): read it.
    expect((await t.ctx.loadMessages!()).map((m) => m.id)).toEqual(['cold'])
    expect((await t.ctx.loadMessages!()).map((m) => m.id)).toEqual(['cold'])
    expect(t.readMessages).toHaveBeenCalledTimes(1)
    t.tick(COLD_TRANSCRIPT_TTL_MS + 1)
    await t.ctx.loadMessages!()
    expect(t.readMessages).toHaveBeenCalledTimes(2)
  })

  it('never reads cold while a live object or canonical has the transcript', async () => {
    const live = setup()
    live.sessions.set('tmp-1', { getMessages: () => [msg('live')] })
    expect((await live.ctx.loadMessages!()).map((m) => m.id)).toEqual(['live'])
    expect(live.readMessages).not.toHaveBeenCalled()

    const held = setup({ canonical: { 'tmp-1': [msg('canonical')] } })
    expect((await held.ctx.loadMessages!()).map((m) => m.id)).toEqual(['canonical'])
    expect(held.readMessages).not.toHaveBeenCalled()
  })

  it('an unreadable history is an empty transcript, not a failed judgement', async () => {
    const t = setup()
    t.readMessages.mockRejectedValueOnce(new Error('disk'))
    expect(await t.ctx.loadMessages!()).toEqual([])
  })

  it('without a lookup the context is the launching call’s own, plus its run', () => {
    const run = makeRun()
    const base: DispatchContext = {
      fromEngine: 'claude',
      fromRoutingId: 'p-1',
      cwd: '/proj',
      getAutonomyMode: () => 'default',
      getMessages: () => [],
      emit: vi.fn()
    }
    const ctx = makeRunContext({
      base,
      run,
      registry: new DispatchRunRegistry(),
      parents: undefined,
      launchMode: () => 'x',
      now: () => 0
    })
    expect(ctx.emit).toBe(base.emit)
    expect(ctx.run).toBe(run)
  })
})
