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
