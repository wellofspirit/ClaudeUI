/**
 * ADR-088 — the shared auto-mode judge pipeline. The two static gates are
 * mocked (each has its own suite); `classify()` is real, driven by a scripted
 * transport, so the ordering, the settle checks, G10, the denial caps and the
 * review/outcome bookkeeping are what this suite pins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogger, mockReadOnlyGate, mockAllowRuleGate } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockReadOnlyGate: vi.fn(),
  mockAllowRuleGate: vi.fn()
}))
vi.mock('../../services/logger', () => ({ logger: mockLogger }))
vi.mock('../read-only-gate', () => ({ readOnlyGate: mockReadOnlyGate }))
vi.mock('../allow-rule-gate', () => ({ allowRuleGate: mockAllowRuleGate }))

import {
  runJudgePipeline,
  runJudgePipelineDetailed,
  type JudgePipelineHooks
} from '../judge-pipeline'
import { AutoModeDenialTracker } from '../denial-tracker'
import type { JudgeRequest } from '../classifier'
import { JUDGE_OFF_FORMAT_CODE, JudgeWireError } from '../judge-http/types'
import type { ChatMessage } from '../../../shared/types'

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'tidy the repo' }], timestamp: 0 }
]

function setup(over: Partial<JudgePipelineHooks> = {}, replies: Array<string | Error> = []) {
  const judge = vi.fn(async (_req: JudgeRequest): Promise<string> => {
    const next = replies.shift()
    if (next instanceof Error) throw next
    return next ?? '<block>no</block>'
  })
  const sendReview = vi.fn()
  let mode = 'auto'
  const hooks: JudgePipelineHooks = {
    logSource: 'TestSource',
    cwd: '/repo',
    currentMode: () => mode,
    autoModeActive: () => mode === 'auto',
    permissions: () => ({ allow: [], ask: [], deny: [], additionalDirectories: [] }),
    honoursWorkdir: false,
    judgeAvailable: () => true,
    judgeTransport: () => judge,
    messages: () => messages,
    environment: async () => ({ cwd: '/repo' }),
    captureActionMeta: async () => undefined,
    outcomes: () => undefined,
    denials: new AutoModeDenialTracker(),
    twoStageMode: () => 'fast',
    sendReview,
    ...over
  }
  return { hooks, judge, sendReview, setMode: (m: string) => (mode = m) }
}

const bash = { toolUseId: 'call-1', toolName: 'bash', input: { command: 'rm -rf build' } }

/** What a `human` outcome says when the judge could not answer, ending in the call to action. */
const unavailableReason = (why: string): string =>
  `Auto-mode judge unavailable: ${why}. Review this call yourself.`
const MODEL_GONE = unavailableReason('the configured judge model is no longer available')
const MODE_LEFT = 'The permission mode changed while the judge ran. Review this call yourself.'

beforeEach(() => {
  vi.clearAllMocks()
  mockReadOnlyGate.mockResolvedValue({ allow: false, reason: 'not-read-only' })
  mockAllowRuleGate.mockReturnValue({ allow: false, reason: 'rule:none-usable' })
})

describe('runJudgePipeline', () => {
  it('allow: one judge call with the transcript + subagent header, review sent, caps reset', async () => {
    const { hooks, judge, sendReview } = setup({
      subagent: { type: 'dispatch:pi', description: 'm', prompt: 'clean the build dir' }
    })
    const denials = hooks.denials
    const allow = vi.spyOn(denials, 'recordAllow')
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(judge).toHaveBeenCalledTimes(1)
    const user = judge.mock.calls[0][0].user
    expect(user).toContain('tidy the repo')
    expect(user).toContain('"dispatch:pi" subagent')
    expect(user).toContain('clean the build dir')
    expect(sendReview).toHaveBeenCalledWith('call-1', expect.objectContaining({ block: false }))
    expect(allow).toHaveBeenCalledTimes(1)
    expect(mockLogger.info).toHaveBeenCalledWith('TestSource', expect.stringContaining('bash'))
  })

  it('block (ADR-091 §3): held with the formatted reason, block counted, review sent, no allow', async () => {
    // Two samples: a block is confirmed by a second parsed block (decision 3).
    const { hooks, sendReview } = setup({}, [
      '<block>yes</block><reason>wipes the build</reason>',
      '<block>yes</block><reason>wipes the build</reason>'
    ])
    const block = vi.spyOn(hooks.denials, 'recordBlock')
    const allow = vi.spyOn(hooks.denials, 'recordAllow')
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'hold',
      reason: 'Auto mode blocked: wipes the build'
    })
    expect(block).toHaveBeenCalledTimes(1)
    expect(allow).not.toHaveBeenCalled()
    expect(sendReview).toHaveBeenCalledWith('call-1', expect.objectContaining({ block: true }))
  })

  it('block: the hold carries the review the caller sent (ADR-091 part 6)', async () => {
    const review = {
      type: 'tool_review' as const,
      toolUseId: 'call-1',
      reviewId: 'r',
      reviewer: 'auto-mode' as const,
      decision: 'denied' as const
    }
    const { hooks } = setup({ sendReview: vi.fn(() => review) }, [
      '<block>yes</block>',
      '<block>yes</block>'
    ])
    expect(await runJudgePipeline(bash, hooks)).toMatchObject({ kind: 'hold', review })
  })

  it("ADR-091 part 6: the user's grant allows on the JUDGED input before the judge-model check, and resets the streak", async () => {
    const judged = { command: 'rm -rf JUDGED' }
    const judgeAvailable = vi.fn(() => true)
    const consumeGrant = vi.fn(() => true)
    const { hooks, judge, sendReview } = setup({
      inputFor: async (stage) => (stage === 'judge' ? judged : null),
      judgeAvailable,
      consumeGrant
    })
    const allow = vi.spyOn(hooks.denials, 'recordAllow')
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(consumeGrant).toHaveBeenCalledWith('bash', judged)
    expect(judgeAvailable).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
    expect(sendReview).not.toHaveBeenCalled()
    expect(allow).toHaveBeenCalledTimes(1)
  })

  it('ADR-091 part 6: no grant → judged as usual; the read-only gate still runs first', async () => {
    mockReadOnlyGate.mockResolvedValue({ allow: true })
    const consumeGrant = vi.fn(() => true)
    const { hooks } = setup({ consumeGrant })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(consumeGrant).not.toHaveBeenCalled()
    mockReadOnlyGate.mockResolvedValue({ allow: false, reason: 'not-read-only' })
    const { hooks: h2, judge } = setup({ consumeGrant: () => false }, ['<block>no</block>'])
    expect(await runJudgePipeline(bash, h2)).toEqual({ kind: 'allow' })
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('the third block in a row hands over to the human with the cap sentence, no review', async () => {
    // Two samples per block (decision 3): each judgement needs a block twice.
    const yes = '<block>yes</block>'
    const { hooks, sendReview } = setup({}, [yes, yes, yes, yes, yes, yes])
    expect((await runJudgePipeline(bash, hooks)).kind).toBe('hold')
    expect((await runJudgePipeline(bash, hooks)).kind).toBe('hold')
    sendReview.mockClear()
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'human',
      reason: 'Auto mode blocked 3 actions in a row — asking you instead.'
    })
    expect(sendReview).not.toHaveBeenCalled()
  })

  it('a transport failure is unavailable → human with the reason, warned with the cause, no review', async () => {
    const { hooks, sendReview } = setup({}, [new Error('HTTP 503')])
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'human',
      reason: unavailableReason('HTTP 503')
    })
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      expect.stringMatching(/stage=error.*HTTP 503/)
    )
    expect(sendReview).not.toHaveBeenCalled()
  })

  it('the unavailable warning says the judge was unavailable, never BLOCK', async () => {
    const { hooks } = setup({}, [new Error('HTTP 503')])
    await runJudgePipeline(bash, hooks)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      'auto-mode judge unavailable (stage=error) bash — HTTP 503'
    )
    expect(mockLogger.warn.mock.calls.flat().join(' ')).not.toContain('BLOCK')
  })

  it('a 429 on the judge call: the reason keeps the route, status and reset time, not the body', async () => {
    const body = JSON.stringify({
      error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan: 'x' }
    })
    const message = `ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z): ${body}`
    const { hooks } = setup({}, [new Error(message)])
    const out = await runJudgePipeline(bash, hooks)
    expect(out).toEqual({
      kind: 'human',
      reason:
        'Auto-mode judge unavailable: ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z). ' +
        'Review this call yourself.'
    })
    // The full text still reaches the log for diagnosis.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      expect.stringContaining('usage_limit_reached')
    )
  })

  it('a throw outside classify → human with the reason and the classify-failed warning', async () => {
    const { hooks } = setup({
      environment: async () => {
        throw new Error('boom')
      }
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'human',
      reason: unavailableReason('boom')
    })
    expect(mockLogger.warn).toHaveBeenCalledWith('TestSource', 'auto-mode classify failed: boom')
  })

  it('a throw after the ask was settled elsewhere → settled, not human (no card for an answered ask)', async () => {
    let pending = true
    const { hooks } = setup({
      stillPending: () => pending,
      environment: async () => {
        pending = false
        throw new Error('boom')
      }
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'settled' })
  })

  it('settled while the judge ran → settled, no review, no G10 line', async () => {
    let pending = true
    const { hooks, sendReview } = setup({ stillPending: () => pending })
    hooks.judgeTransport = () => async () => {
      pending = false
      return '<block>no</block>'
    }
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'settled' })
    expect(sendReview).not.toHaveBeenCalled()
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it('G10: the mode left auto while the judge ran → verdict discarded, human', async () => {
    const ctl = setup()
    ctl.hooks.judgeTransport = () => async () => {
      ctl.setMode('default')
      return '<block>no</block>'
    }
    expect(await runJudgePipeline(bash, ctl.hooks)).toEqual({ kind: 'human', reason: MODE_LEFT })
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSource',
      'auto-mode verdict discarded — permission mode changed to "default" while the judge ran'
    )
    expect(ctl.sendReview).not.toHaveBeenCalled()
  })

  it('read-only gate allow → allow with the read-only review, zero judge calls', async () => {
    mockReadOnlyGate.mockResolvedValue({ allow: true, summary: 'ls' })
    const { hooks, judge, sendReview } = setup({ honoursWorkdir: true })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(sendReview).toHaveBeenCalledWith('call-1', 'read-only')
    expect(judge).not.toHaveBeenCalled()
    expect(mockReadOnlyGate).toHaveBeenCalledWith(
      expect.objectContaining({ honoursWorkdir: true, logSource: 'TestSource', cwd: '/repo' })
    )
  })

  it('settled during the read-only gate → settled, nothing else runs', async () => {
    const { hooks, judge } = setup({ stillPending: () => false })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'settled' })
    expect(judge).not.toHaveBeenCalled()
    expect(mockAllowRuleGate).not.toHaveBeenCalled()
  })

  it('skipReadOnlyGate → the gate is never consulted', async () => {
    const { hooks } = setup({ skipReadOnlyGate: true })
    await runJudgePipeline(bash, hooks)
    expect(mockReadOnlyGate).not.toHaveBeenCalled()
  })

  it('the category fast path allows with no gate, no judge, no review', async () => {
    const { hooks, judge, sendReview } = setup()
    expect(
      await runJudgePipeline({ toolUseId: 'r', toolName: 'read', input: { path: 'a' } }, hooks)
    ).toEqual({ kind: 'allow' })
    expect(mockReadOnlyGate).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
    expect(sendReview).not.toHaveBeenCalled()
  })

  it('judgeAvailable false → human with the stale-model reason and zero judge calls', async () => {
    const { hooks, judge } = setup({ judgeAvailable: async () => false })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'human', reason: MODEL_GONE })
    expect(judge).not.toHaveBeenCalled()
  })

  it('allowRuleAction absent → the allow-rule gate is skipped', async () => {
    const { hooks } = setup()
    await runJudgePipeline(bash, hooks)
    expect(mockAllowRuleGate).not.toHaveBeenCalled()
  })

  it('allowRuleAction present and the gate allows → allow with the rule review, zero judge calls', async () => {
    mockAllowRuleGate.mockReturnValue({ allow: true, rule: 'Bash(rm:*)', rules: ['Bash(rm:*)'] })
    const { hooks, judge, sendReview } = setup({
      allowRuleAction: (_t, input) => ({ kind: 'shell', command: String(input.command) }),
      subagent: { type: 'explore' }
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(sendReview).toHaveBeenCalledWith('call-1', { allowRule: 'Bash(rm:*)' })
    expect(judge).not.toHaveBeenCalled()
    expect(mockAllowRuleGate).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: 'explore', toolName: 'bash' })
    )
  })

  it('passes the outcomes and action meta through to the judge prompt', async () => {
    const { hooks, judge } = setup({
      messages: () => [
        ...messages,
        {
          id: 'a1',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolUseId: 'prev',
              toolName: 'bash',
              toolInput: { command: 'rm -rf build' }
            }
          ],
          timestamp: 0
        }
      ],
      outcomes: () => ({ prev: 'automode-blocked' }),
      captureActionMeta: async () => ({ gitStatus: { clean: false } })
    })
    await runJudgePipeline(bash, hooks)
    expect(judge.mock.calls[0][0].user).toContain('"meta"')
    // …and the outcomes reach classify: the prior call is annotated in the transcript.
    expect(judge.mock.calls[0][0].user).toContain('automode-blocked')
  })
})

describe('runJudgePipeline — staged input and settle checks (S4, opencode on the pipeline)', () => {
  it('J-T1: inputFor("read-only") null skips the gate and makes no stillPending call', async () => {
    const stillPending = vi.fn(() => true)
    // Both stages answer null: no read-only input, and the judge reads action.input.
    const inputFor = vi.fn(async (_stage: 'read-only' | 'judge') => null)
    const { hooks } = setup({ inputFor, stillPending, judgeAvailable: () => false })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'human', reason: MODEL_GONE })
    expect(mockReadOnlyGate).not.toHaveBeenCalled()
    expect(stillPending).not.toHaveBeenCalled()
  })

  it('J-T1: an object from inputFor("read-only") is what the gate reads', async () => {
    const roInput = { command: 'ls', workdir: '/repo/sub' }
    const { hooks } = setup({
      inputFor: async (stage) => (stage === 'read-only' ? roInput : null),
      judgeAvailable: () => false
    })
    await runJudgePipeline(bash, hooks)
    expect(mockReadOnlyGate).toHaveBeenCalledWith(
      expect.objectContaining({ action: { toolName: 'bash', input: roInput } })
    )
  })

  it('J-T1: "settled" from inputFor("read-only") returns settled before the allow-rule hook', async () => {
    const allowRuleAction = vi.fn(() => ({ kind: 'shell' as const, command: 'x' }))
    const { hooks, judge } = setup({
      inputFor: async () => 'settled',
      allowRuleAction
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'settled' })
    expect(allowRuleAction).not.toHaveBeenCalled()
    expect(mockReadOnlyGate).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('J-T2: the allow-rule hook runs BEFORE inputFor("judge"); an allow-rule allow never asks for the judge input', async () => {
    const order: string[] = []
    const inputFor = vi.fn(async (stage: 'read-only' | 'judge') => {
      order.push(`inputFor:${stage}`)
      return null
    })
    const allowRuleAction = vi.fn(() => {
      order.push('allowRuleAction')
      return { kind: 'shell' as const, command: 'rm -rf build' }
    })
    const { hooks } = setup({ inputFor, allowRuleAction, judgeAvailable: () => false })
    await runJudgePipeline(bash, hooks)
    expect(order).toEqual(['inputFor:read-only', 'allowRuleAction', 'inputFor:judge'])

    mockAllowRuleGate.mockReturnValue({ allow: true, rule: 'Bash(rm:*)', rules: ['Bash(rm:*)'] })
    inputFor.mockClear()
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(inputFor.mock.calls.map(([stage]) => stage)).toEqual(['read-only'])
  })

  it('J-T3: ground truth and the judge read the inputFor("judge") object, which resolves before judgeAvailable', async () => {
    const order: string[] = []
    const judged = { command: 'rm -rf JUDGED-INPUT' }
    const captureActionMeta = vi.fn(async () => undefined)
    const { hooks, judge } = setup(
      {
        inputFor: async (stage) => {
          order.push(`inputFor:${stage}`)
          return stage === 'judge' ? judged : null
        },
        judgeAvailable: () => {
          order.push('judgeAvailable')
          return true
        },
        captureActionMeta
      },
      ['<block>no</block>']
    )
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'allow' })
    expect(order).toEqual(['inputFor:read-only', 'inputFor:judge', 'judgeAvailable'])
    expect(captureActionMeta).toHaveBeenCalledWith('bash', judged)
    expect(judge.mock.calls[0][0].user).toContain('JUDGED-INPUT')
  })

  it('J-T3: "settled" from inputFor("judge") returns settled with no judge call', async () => {
    const judgeAvailable = vi.fn(() => true)
    const { hooks, judge } = setup({
      inputFor: async (stage) => (stage === 'judge' ? 'settled' : null),
      judgeAvailable
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'settled' })
    expect(judgeAvailable).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('J-T4: stillPending receives its stage at each check', async () => {
    const stages: string[] = []
    const stillPending = (stage: string): boolean => {
      stages.push(stage)
      return true
    }
    // read-only + judge
    await runJudgePipeline(bash, setup({ stillPending }, ['<block>no</block>']).hooks)
    expect(stages).toEqual(['read-only', 'judge'])
    // error
    stages.length = 0
    await runJudgePipeline(
      bash,
      setup({
        stillPending,
        skipReadOnlyGate: true,
        environment: async () => {
          throw new Error('boom')
        }
      }).hooks
    )
    expect(stages).toEqual(['error'])
    // allow-rule
    stages.length = 0
    mockAllowRuleGate.mockReturnValue({ allow: true, rule: 'Bash(rm:*)', rules: ['Bash(rm:*)'] })
    await runJudgePipeline(
      bash,
      setup({
        stillPending,
        skipReadOnlyGate: true,
        allowRuleAction: () => ({ kind: 'shell', command: 'rm -rf build' })
      }).hooks
    )
    expect(stages).toEqual(['allow-rule'])
  })

  it('J-T4: an allow-rule allow for an ask settled meanwhile → settled, no review', async () => {
    mockAllowRuleGate.mockReturnValue({ allow: true, rule: 'Bash(rm:*)', rules: ['Bash(rm:*)'] })
    const { hooks, sendReview } = setup({
      stillPending: (stage) => stage !== 'allow-rule',
      allowRuleAction: () => ({ kind: 'shell', command: 'rm -rf build' })
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'settled' })
    expect(sendReview).not.toHaveBeenCalled()
  })
})

describe('runJudgePipelineDetailed — the verdict detail the outcome drops (ADR-105 §3, slice B-3c)', () => {
  const handBack = {
    toolUseId: '',
    toolName: 'hand_back',
    input: { report: 'Done.' },
    handBack: true
  }

  it('an allow carries the verdict; a block carries the reason and rule behind the hold', async () => {
    const a = await runJudgePipelineDetailed(bash, setup({}, ['<block>no</block>']).hooks)
    expect(a.outcome).toEqual({ kind: 'allow' })
    expect(a.detail).toMatchObject({ kind: 'verdict', result: { block: false } })

    const b = await runJudgePipelineDetailed(
      bash,
      setup({}, [
        '<block>yes</block><reason>[Containment Escape] runs a remote script</reason>',
        '<block>yes</block><reason>[Containment Escape] runs a remote script</reason>'
      ]).hooks
    )
    expect(b.outcome.kind).toBe('hold')
    expect(b.detail).toMatchObject({
      kind: 'verdict',
      result: { block: true, reason: '[Containment Escape] runs a remote script' }
    })
  })

  it('tells a judge that could not answer apart from a block, and says why', async () => {
    const down = await runJudgePipelineDetailed(bash, setup({}, [new Error('HTTP 503')]).hooks)
    expect(down.outcome).toEqual({ kind: 'human', reason: unavailableReason('HTTP 503') })
    expect(down.detail).toEqual({ kind: 'unavailable', cause: 'judge', error: 'HTTP 503' })

    const stale = await runJudgePipelineDetailed(bash, setup({ judgeAvailable: () => false }).hooks)
    expect(stale.detail).toEqual({ kind: 'unavailable', cause: 'model' })

    const ctl = setup()
    ctl.hooks.judgeTransport = () => async () => {
      ctl.setMode('default')
      return '<block>no</block>'
    }
    expect((await runJudgePipelineDetailed(bash, ctl.hooks)).detail).toEqual({
      kind: 'unavailable',
      cause: 'mode'
    })

    const threw = await runJudgePipelineDetailed(
      bash,
      setup({
        environment: async () => {
          throw new Error('boom')
        }
      }).hooks
    )
    expect(threw.detail).toEqual({ kind: 'unavailable', cause: 'error', error: 'boom' })
  })

  it('a denial cap is reported with the block that tripped it; gates and settled ask say nothing', async () => {
    // Two samples per judgement (decision 3).
    const yes = '<block>yes</block>'
    const { hooks } = setup({}, [yes, yes, yes, yes, yes, yes])
    await runJudgePipelineDetailed(bash, hooks)
    await runJudgePipelineDetailed(bash, hooks)
    const third = await runJudgePipelineDetailed(bash, hooks)
    expect(third.outcome.kind).toBe('human')
    expect(third.detail).toMatchObject({
      kind: 'verdict',
      result: { block: true },
      capped: 'Auto mode blocked 3 actions in a row — asking you instead.'
    })

    expect(
      (await runJudgePipelineDetailed({ ...bash, toolName: 'read' }, setup().hooks)).detail
    ).toEqual({ kind: 'none' })
    let pending = true
    const settled = setup({ stillPending: () => pending })
    settled.hooks.judgeTransport = () => async () => {
      pending = false
      return '<block>no</block>'
    }
    expect((await runJudgePipelineDetailed(bash, settled.hooks)).detail).toEqual({ kind: 'none' })
  })

  it('judges a hand-back as the hand-back it is: framed as one, sent to stage 2 even in both mode', async () => {
    const { hooks, judge } = setup({ skipReadOnlyGate: true, twoStageMode: () => 'both' }, [
      '<thinking>ok</thinking><block>no</block>'
    ])
    const r = await runJudgePipelineDetailed(handBack, hooks)
    expect(r.outcome).toEqual({ kind: 'allow' })
    expect(judge).toHaveBeenCalledTimes(1)
    const req = judge.mock.calls[0][0]
    expect(req.stage).toBe('thinking')
    expect(req.user).toContain('Final entry to evaluate - a hand-back')
    expect(req.user).toContain('"Done."')
    expect(req.user).not.toContain('Proposed next action')
  })

  it('runJudgePipeline is the same pipeline minus the detail', async () => {
    const replies = ['<block>yes</block><reason>[X] y</reason>']
    const plain = await runJudgePipeline(bash, setup({}, [...replies]).hooks)
    const detailed = await runJudgePipelineDetailed(bash, setup({}, [...replies]).hooks)
    expect(plain).toEqual(detailed.outcome)
  })
})

describe('runJudgePipeline — fallback judge', () => {
  const LABEL = 'OpenAI · gpt-4.1-mini'
  const PRIMARY_DOWN = 'ChatGPT · gpt-6-luna: HTTP 429 (resets at 2026-10-28T13:34:58.000Z)'
  const blockReply = '<block>yes</block><reason>wipes the build</reason>'

  /** The primary scripted by `primary`, the fallback judge by `fallback`. */
  function withFallback(
    primary: Array<string | Error>,
    fallback: Array<string | Error>,
    over: Partial<JudgePipelineHooks> = {}
  ) {
    const ctl = setup(over, primary)
    const fallbackJudge = vi.fn(async (_req: JudgeRequest): Promise<string> => {
      const next = fallback.shift()
      if (next instanceof Error) throw next
      return next ?? '<block>no</block>'
    })
    const fallbackHook = vi.fn(() => ({ transport: fallbackJudge, label: LABEL }))
    ctl.hooks.fallbackJudgeTransport = fallbackHook
    return { ...ctl, fallbackJudge, fallbackHook }
  }

  it('primary unavailable → the fallback judges, and its allow is allowed like a primary one', async () => {
    const { hooks, judge, fallbackJudge, sendReview } = withFallback(
      [new Error(PRIMARY_DOWN)],
      ['<block>no</block>']
    )
    const allow = vi.spyOn(hooks.denials, 'recordAllow')
    const r = await runJudgePipelineDetailed(bash, hooks)

    expect(r.outcome).toEqual({ kind: 'allow' })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(fallbackJudge).toHaveBeenCalledTimes(1)
    expect(allow).toHaveBeenCalledTimes(1)
    expect(sendReview).toHaveBeenCalledWith('call-1', expect.objectContaining({ block: false }))
    expect(r.detail).toMatchObject({
      kind: 'verdict',
      result: { block: false },
      judgedBy: 'fallback'
    })
  })

  it('logs the primary as unavailable, then the verdict line says judge=fallback <label>', async () => {
    const { hooks } = withFallback([new Error(PRIMARY_DOWN)], ['<block>no</block>'])
    await runJudgePipeline(bash, hooks)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      `auto-mode judge unavailable (stage=error) bash — ${PRIMARY_DOWN}`
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSource',
      `auto-mode allow (stage=fast, judge=fallback ${LABEL}) bash`
    )
  })

  it('primary unavailable → the fallback blocks → held exactly as a primary block would be', async () => {
    // A block is confirmed by a second sample — of the FALLBACK, never mixed with the primary.
    const { hooks, judge, fallbackJudge, sendReview } = withFallback(
      [new Error(PRIMARY_DOWN)],
      [blockReply, blockReply]
    )
    const block = vi.spyOn(hooks.denials, 'recordBlock')
    const allow = vi.spyOn(hooks.denials, 'recordAllow')
    const r = await runJudgePipelineDetailed(bash, hooks)

    expect(r.outcome).toEqual({ kind: 'hold', reason: 'Auto mode blocked: wipes the build' })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(fallbackJudge).toHaveBeenCalledTimes(2)
    expect(block).toHaveBeenCalledTimes(1)
    expect(allow).not.toHaveBeenCalled()
    expect(sendReview).toHaveBeenCalledWith('call-1', expect.objectContaining({ block: true }))
    expect(r.detail).toMatchObject({
      kind: 'verdict',
      result: { block: true },
      judgedBy: 'fallback'
    })
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSource',
      expect.stringContaining(`judge=fallback ${LABEL}`)
    )
  })

  it("a fallback's block counts toward the denial caps like any other", async () => {
    const { hooks } = withFallback(
      [new Error('HTTP 503'), new Error('HTTP 503'), new Error('HTTP 503')],
      Array(6).fill('<block>yes</block>')
    )
    await runJudgePipeline(bash, hooks)
    await runJudgePipeline(bash, hooks)
    const third = await runJudgePipelineDetailed(bash, hooks)
    expect(third.outcome).toEqual({
      kind: 'human',
      reason: 'Auto mode blocked 3 actions in a row — asking you instead.'
    })
    expect(third.detail).toMatchObject({ kind: 'verdict', judgedBy: 'fallback' })
  })

  it('the whole classification is re-run on the fallback: both stages, identical input', async () => {
    const { hooks, judge, fallbackJudge } = withFallback(
      ['<severity>90</severity>', new Error('HTTP 503')],
      ['<severity>90</severity>', '<block>no</block>'],
      { twoStageMode: () => 'both' }
    )
    const benign = { toolUseId: 'call-2', toolName: 'bash', input: { command: 'npm test' } }
    expect(await runJudgePipeline(benign, hooks)).toEqual({ kind: 'allow' })

    // The primary got as far as stage 2; the fallback starts over at stage 1.
    expect(judge.mock.calls.map(([req]) => req.stage)).toEqual(['fast', 'thinking'])
    expect(fallbackJudge.mock.calls.map(([req]) => req.stage)).toEqual(['fast', 'thinking'])
    expect(fallbackJudge.mock.calls[0][0].system).toBe(judge.mock.calls[0][0].system)
    expect(fallbackJudge.mock.calls[0][0].user).toBe(judge.mock.calls[0][0].user)
  })

  it('both unavailable → the human, with both causes on the card and in the detail', async () => {
    const { hooks, sendReview } = withFallback([new Error(PRIMARY_DOWN)], [new Error('HTTP 503')])
    const r = await runJudgePipelineDetailed(bash, hooks)

    const why = `${PRIMARY_DOWN}; fallback ${LABEL}: HTTP 503`
    expect(r.outcome).toEqual({
      kind: 'human',
      reason: `Auto-mode judge unavailable: ${why}. Review this call yourself.`
    })
    expect(r.detail).toEqual({ kind: 'unavailable', cause: 'judge', error: why })
    expect(sendReview).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      `auto-mode judge unavailable (stage=error, judge=fallback ${LABEL}) bash — HTTP 503`
    )
  })

  it('both causes are the short clauses, not the response bodies', async () => {
    const body = JSON.stringify({ error: { type: 'usage_limit_reached' } })
    const { hooks } = withFallback(
      [new Error(`${PRIMARY_DOWN}: ${body}`)],
      [new Error(`${LABEL}: HTTP 500: {"error":"boom"}`)]
    )
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'human',
      reason:
        `Auto-mode judge unavailable: ${PRIMARY_DOWN}; fallback ${LABEL}: ${LABEL}: HTTP 500. ` +
        'Review this call yourself.'
    })
  })

  it('no fallback hook → today: the human with the primary cause, the hook is never needed', async () => {
    const { hooks, judge } = setup({}, [new Error('HTTP 503')])
    expect(hooks.fallbackJudgeTransport).toBeUndefined()
    expect(await runJudgePipelineDetailed(bash, hooks)).toEqual({
      outcome: { kind: 'human', reason: unavailableReason('HTTP 503') },
      detail: { kind: 'unavailable', cause: 'judge', error: 'HTTP 503' }
    })
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('a hook that yields no fallback (none configured) behaves as no hook', async () => {
    const { hooks } = setup({ fallbackJudgeTransport: () => undefined }, [new Error('HTTP 503')])
    expect(await runJudgePipelineDetailed(bash, hooks)).toEqual({
      outcome: { kind: 'human', reason: unavailableReason('HTTP 503') },
      detail: { kind: 'unavailable', cause: 'judge', error: 'HTTP 503' }
    })
  })

  it('a hook that throws is no fallback: the human, with the primary cause, and a warning', async () => {
    const { hooks } = setup(
      {
        fallbackJudgeTransport: () => {
          throw new Error('bad config')
        }
      },
      [new Error('HTTP 503')]
    )
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'human',
      reason: unavailableReason('HTTP 503')
    })
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      'auto-mode fallback judge not available: bad config'
    )
  })

  it('a primary that answers never touches the fallback', async () => {
    const { hooks, fallbackHook, fallbackJudge } = withFallback(['<block>no</block>'], [])
    const r = await runJudgePipelineDetailed(bash, hooks)
    expect(r.outcome).toEqual({ kind: 'allow' })
    expect(r.detail).toEqual({
      kind: 'verdict',
      result: expect.objectContaining({ block: false })
    })
    expect(fallbackHook).not.toHaveBeenCalled()
    expect(fallbackJudge).not.toHaveBeenCalled()
  })

  it('a primary block is not a failure: no fallback second opinion', async () => {
    const { hooks, fallbackHook } = withFallback([blockReply, blockReply], [])
    expect((await runJudgePipeline(bash, hooks)).kind).toBe('hold')
    expect(fallbackHook).not.toHaveBeenCalled()
  })

  it('an unreadable primary reply is a block, not unavailable: no fallback', async () => {
    const { hooks, fallbackHook } = withFallback(['no verdict here'], [])
    expect((await runJudgePipeline(bash, hooks)).kind).toBe('hold')
    expect(fallbackHook).not.toHaveBeenCalled()
  })

  it('a mode change while the primary ran → the human, and the fallback is not tried', async () => {
    const ctl = withFallback([], [])
    ctl.hooks.judgeTransport = () => async () => {
      ctl.setMode('default')
      throw new Error('HTTP 503')
    }
    expect(await runJudgePipeline(bash, ctl.hooks)).toEqual({ kind: 'human', reason: MODE_LEFT })
    expect(ctl.fallbackHook).not.toHaveBeenCalled()
    expect(ctl.fallbackJudge).not.toHaveBeenCalled()
  })

  it('a mode change while the fallback ran → its verdict is discarded too', async () => {
    const ctl = withFallback([new Error('HTTP 503')], [])
    ctl.fallbackHook.mockReturnValue({
      label: LABEL,
      transport: vi.fn(async () => {
        ctl.setMode('default')
        return '<block>no</block>'
      })
    })
    const r = await runJudgePipelineDetailed(bash, ctl.hooks)
    expect(r.outcome).toEqual({ kind: 'human', reason: MODE_LEFT })
    expect(r.detail).toEqual({ kind: 'unavailable', cause: 'mode' })
    expect(ctl.sendReview).not.toHaveBeenCalled()
  })

  it('settled while the primary ran → settled, and the fallback is not tried', async () => {
    let pending = true
    const ctl = withFallback([], [], { stillPending: () => pending })
    ctl.hooks.judgeTransport = () => async () => {
      pending = false
      throw new Error('HTTP 503')
    }
    expect(await runJudgePipeline(bash, ctl.hooks)).toEqual({ kind: 'settled' })
    expect(ctl.fallbackHook).not.toHaveBeenCalled()
  })

  it('settled while the fallback ran → settled, no review', async () => {
    let pending = true
    const ctl = withFallback([new Error('HTTP 503')], [], { stillPending: () => pending })
    ctl.fallbackHook.mockReturnValue({
      label: LABEL,
      transport: vi.fn(async () => {
        pending = false
        return '<block>no</block>'
      })
    })
    expect(await runJudgePipeline(bash, ctl.hooks)).toEqual({ kind: 'settled' })
    expect(ctl.sendReview).not.toHaveBeenCalled()
  })

  it('the configured model is gone → the fallback judges instead, and the primary is never built', async () => {
    const judgeTransport = vi.fn()
    const { hooks, fallbackJudge, sendReview } = withFallback([], ['<block>no</block>'], {
      judgeAvailable: () => false,
      judgeTransport
    })
    const r = await runJudgePipelineDetailed(bash, hooks)

    expect(r.outcome).toEqual({ kind: 'allow' })
    expect(judgeTransport).not.toHaveBeenCalled()
    expect(fallbackJudge).toHaveBeenCalledTimes(1)
    expect(sendReview).toHaveBeenCalledWith('call-1', expect.objectContaining({ block: false }))
    expect(r.detail).toMatchObject({ kind: 'verdict', judgedBy: 'fallback' })
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSource',
      `auto-mode allow (stage=fast, judge=fallback ${LABEL}) bash`
    )
  })

  it('the configured model is gone and the fallback fails too → the human, with both causes', async () => {
    const { hooks } = withFallback([], [new Error('HTTP 503')], { judgeAvailable: () => false })
    const r = await runJudgePipelineDetailed(bash, hooks)

    const why = `the configured judge model is no longer available; fallback ${LABEL}: HTTP 503`
    expect(r.outcome).toEqual({ kind: 'human', reason: unavailableReason(why) })
    expect(r.detail).toEqual({ kind: 'unavailable', cause: 'model', error: why })
  })

  it('the configured model is gone, no fallback → today: the stale-model human, zero judge calls', async () => {
    const { hooks, judge } = setup({
      judgeAvailable: () => false,
      fallbackJudgeTransport: () => undefined
    })
    const r = await runJudgePipelineDetailed(bash, hooks)
    expect(r.outcome).toEqual({ kind: 'human', reason: MODEL_GONE })
    expect(r.detail).toEqual({ kind: 'unavailable', cause: 'model' })
    expect(judge).not.toHaveBeenCalled()
  })

  // D9: stage 1 answering unusably (off-format / over budget) escalates to stage 2, so the
  // primary DOES answer — the fallback only runs when that stage 2 then fails.
  // `ls` rather than `rm -rf build`: a destructive shape skips stage 1 for full review.
  const stage1Action = { toolUseId: 'call-1', toolName: 'bash', input: { command: 'ls' } }
  const offFormat = () =>
    new JudgeWireError('judge reply does not open with an allowed prefix', {
      code: JUDGE_OFF_FORMAT_CODE
    })

  it('a stage-1 off-format reply escalates; stage 2 allows → the fallback is never asked', async () => {
    const ctl = withFallback([offFormat(), '<block>no</block>'], [], { twoStageMode: () => 'both' })
    const r = await runJudgePipelineDetailed(stage1Action, ctl.hooks)

    expect(r.outcome).toEqual({ kind: 'allow' })
    // Stage 1 threw, stage 2 decided: the primary DID answer the call, so no second opinion.
    expect(ctl.judge).toHaveBeenCalledTimes(2)
    expect(ctl.judge.mock.calls[1][0].stage).toBe('thinking')
    expect(ctl.fallbackHook).not.toHaveBeenCalled()
    expect(r.detail).toMatchObject({
      kind: 'verdict',
      result: { block: false, stage1Unusable: 'off-format' }
    })
  })

  it('a stage-1 off-format reply whose stage 2 then fails → the fallback IS asked', async () => {
    const ctl = withFallback(
      [offFormat(), new JudgeWireError('ChatGPT · gpt-6-luna: HTTP 500', { status: 500 })],
      // A stage-1 allow short-circuits the fallback's own `both` mode: one call.
      ['<severity>0</severity>'],
      { twoStageMode: () => 'both' }
    )
    const r = await runJudgePipelineDetailed(stage1Action, ctl.hooks)

    expect(r.outcome).toEqual({ kind: 'allow' })
    expect(ctl.judge).toHaveBeenCalledTimes(2)
    expect(ctl.fallbackHook).toHaveBeenCalledTimes(1)
    expect(ctl.fallbackJudge).toHaveBeenCalledTimes(1)
    expect(r.detail).toMatchObject({
      kind: 'verdict',
      result: { block: false },
      judgedBy: 'fallback'
    })
  })

  it('the stage=error WARN of an escalation whose stage 2 failed carries the s1 facet', async () => {
    const { hooks } = withFallback(
      [offFormat(), new JudgeWireError('ChatGPT · gpt-6-luna: HTTP 500', { status: 500 })],
      // A stage-1 allow short-circuits the fallback's own `both` mode: one call.
      ['<severity>0</severity>'],
      { twoStageMode: () => 'both' }
    )
    await runJudgePipeline(stage1Action, hooks)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      'auto-mode judge unavailable (stage=error, s1=off-format) bash — ChatGPT · gpt-6-luna: HTTP 500'
    )
  })
})
