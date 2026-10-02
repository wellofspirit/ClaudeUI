/**
 * ADR-087 — the shared auto-mode judge pipeline. The two static gates are
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

import { runJudgePipeline, type JudgePipelineHooks } from '../judge-pipeline'
import { AutoModeDenialTracker } from '../denial-tracker'
import type { JudgeRequest } from '../classifier'
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
  const recordOutcome = vi.fn()
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
    recordOutcome,
    denials: new AutoModeDenialTracker(),
    twoStageMode: () => 'fast',
    sendReview,
    ...over
  }
  return { hooks, judge, sendReview, recordOutcome, setMode: (m: string) => (mode = m) }
}

const bash = { toolUseId: 'call-1', toolName: 'bash', input: { command: 'rm -rf build' } }

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

  it('block: deny with the formatted reason, outcome recorded, review sent', async () => {
    const { hooks, sendReview, recordOutcome } = setup({}, [
      '<block>yes</block><reason>wipes the build</reason>'
    ])
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'deny',
      reason: 'Auto mode blocked: wipes the build'
    })
    expect(recordOutcome).toHaveBeenCalledWith('call-1', 'automode-blocked')
    expect(sendReview).toHaveBeenCalledWith('call-1', expect.objectContaining({ block: true }))
  })

  it('the third block in a row hands over to the human with the cap sentence, no review', async () => {
    const { hooks, sendReview, recordOutcome } = setup({}, [
      '<block>yes</block>',
      '<block>yes</block>',
      '<block>yes</block>'
    ])
    expect((await runJudgePipeline(bash, hooks)).kind).toBe('deny')
    expect((await runJudgePipeline(bash, hooks)).kind).toBe('deny')
    sendReview.mockClear()
    recordOutcome.mockClear()
    expect(await runJudgePipeline(bash, hooks)).toEqual({
      kind: 'human',
      reason: 'Auto mode blocked 3 actions in a row — asking you instead.'
    })
    expect(sendReview).not.toHaveBeenCalled()
    expect(recordOutcome).not.toHaveBeenCalled()
  })

  it('a transport failure is unavailable → human, warned with the cause, no review', async () => {
    const { hooks, sendReview } = setup({}, [new Error('HTTP 503')])
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'human' })
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'TestSource',
      expect.stringMatching(/stage=error.*HTTP 503/)
    )
    expect(sendReview).not.toHaveBeenCalled()
  })

  it('a throw outside classify → human with the classify-failed warning', async () => {
    const { hooks } = setup({
      environment: async () => {
        throw new Error('boom')
      }
    })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'human' })
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
    expect(await runJudgePipeline(bash, ctl.hooks)).toEqual({ kind: 'human' })
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

  it('judgeAvailable false → human with zero judge calls', async () => {
    const { hooks, judge } = setup({ judgeAvailable: async () => false })
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'human' })
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
    expect(await runJudgePipeline(bash, hooks)).toEqual({ kind: 'human' })
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
