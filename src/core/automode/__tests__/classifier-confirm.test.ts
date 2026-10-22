/**
 * P2b code items that change `classify`'s and `requiresFullReview`'s contracts:
 *
 * - two-sample confirmation (decision 3) — a parsed block of the deciding stage
 *   is asked again, and only a second parsed block keeps it;
 * - the `retryOf` fact's two routing effects (decision 11): an agent-control
 *   edit target goes to full review, a retry of a refused call does too;
 * - the user prompt's `retryOf` meta line (item 3), including its exact bytes.
 *
 * Scripted fake transport only — no model calls. The system prompt is never
 * asserted for content here (rules.test.ts owns that); only its stability
 * across the two samples.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import {
  STAGE1_BOTH_MAX_TOKENS,
  STAGE1_FAST_MAX_TOKENS,
  STAGE2_MAX_TOKENS,
  UNPARSEABLE_REASON,
  buildUserPrompt,
  classify,
  formatVerdictLine,
  requiresFullReview,
  type ClassifyInput,
  type JudgeRequest,
  type JudgeTransport
} from '../classifier'
import { RETRY_CALL_MAX_CHARS } from '../retry-match'

let seq = 0
function msg(role: 'user' | 'assistant', content: ChatMessage['content']): ChatMessage {
  return { id: `m${seq++}`, role, content, timestamp: 0 }
}

/** One assistant tool call, as the transcript carries it. */
function toolCall(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ChatMessage {
  return {
    id: `m${seq++}`,
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId, toolName, toolInput }],
    timestamp: 0
  }
}

/** A scripted transport: one reply per call; an Error throws; exhausted → throw. */
function scripted(replies: Array<string | Error>) {
  return vi.fn<JudgeTransport>(async (_req: JudgeRequest): Promise<string> => {
    const next = replies.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('scripted transport exhausted')
    return next
  })
}

const reqs = (judge: { mock: { calls: unknown[][] } }): JudgeRequest[] =>
  judge.mock.calls.map((call) => call[0] as JudgeRequest)

const base: ClassifyInput = {
  messages: [msg('user', [{ type: 'text', text: 'hi' }])],
  action: { toolName: 'bash', input: { command: 'ls' } },
  environment: { cwd: '/repo' }
}

const BLOCK =
  '<block>yes</block><category>Git Destructive</category>' +
  '<reason>[Git Destructive] force-push to main</reason>'
const ALLOW = '<thinking>the user asked for it</thinking><block>no</block>'

// ---------------------------------------------------------------------------
// Two-sample confirmation (decision 3)
// ---------------------------------------------------------------------------

describe('classify — two-sample confirmation', () => {
  it('thinking: block + allow → allow, carrying the overturned block (2 calls)', async () => {
    const judge = scripted([BLOCK, ALLOW])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toEqual({
      block: false,
      stage: 'thinking',
      overturnedBlock: {
        reason: '[Git Destructive] force-push to main',
        category: 'git_destructive'
      }
    })
  })

  it('thinking: block + block → block, with the FIRST sample reason and category (2 calls)', async () => {
    const judge = scripted([
      BLOCK,
      '<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] second</reason>'
    ])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toEqual({
      block: true,
      stage: 'thinking',
      reason: '[Git Destructive] force-push to main',
      category: 'git_destructive'
    })
  })

  it('a credential block stands on ONE sample (credential_exploration / credential_leakage)', async () => {
    for (const [name, slug] of [
      ['Credential Exploration', 'credential_exploration'],
      ['Credential Leakage', 'credential_leakage']
    ]) {
      const judge = scripted([
        `<block>yes</block><category>${name}</category><reason>[${name}] reads the account store</reason>`,
        ALLOW
      ])
      const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
      expect(judge).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ block: true, stage: 'thinking', category: slug })
      expect(r.overturnedBlock).toBeUndefined()
    }
  })

  it('thinking: block + transport error → keep the block, not unavailable (2 calls)', async () => {
    const judge = scripted([BLOCK, new Error('judge down')])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toEqual({
      block: true,
      stage: 'thinking',
      reason: '[Git Destructive] force-push to main',
      category: 'git_destructive'
    })
    expect(r.unavailable).toBeUndefined()
  })

  it('thinking: block + unparseable → keep the block (2 calls)', async () => {
    const judge = scripted([BLOCK, 'I would rather not say'])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r.block).toBe(true)
    expect(r.reason).toBe('[Git Destructive] force-push to main')
  })

  it('thinking: allow → exactly ONE call', async () => {
    const judge = scripted([ALLOW])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ block: false, stage: 'thinking' })
  })

  it('thinking: an unparseable FIRST reply is not a block verdict — no second call (1 call)', async () => {
    const judge = scripted(['no verdict here'])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ block: true, reason: UNPARSEABLE_REASON, raw: 'no verdict here' })
  })

  it('thinking: a transport error on the FIRST call is unchanged — unavailable (1 call)', async () => {
    const judge = scripted([new Error('judge down')])
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ block: true, stage: 'error', unavailable: true })
  })

  it('sends the IDENTICAL request twice: same system, user, stage, budget and stop sequences', async () => {
    const judge = scripted([BLOCK, ALLOW])
    await classify({ ...base, twoStageMode: 'thinking' }, judge)
    const [first, second] = reqs(judge)
    expect(second.system).toBe(first.system)
    expect(second.user).toBe(first.user)
    expect(second.stage).toBe(first.stage)
    expect(second.maxTokens).toBe(first.maxTokens)
    expect(second.stopSequences).toEqual(first.stopSequences)
    // Each sample gets its own abort signal, like every stage call.
    expect(first.signal).not.toBe(second.signal)
  })

  it('the system prompt does not change across the two samples (byte-stability)', async () => {
    const judge = scripted([BLOCK, BLOCK])
    await classify({ ...base, twoStageMode: 'fast' }, judge)
    const [first, second] = reqs(judge)
    expect(second.system).toBe(first.system)
    expect(first.maxTokens).toBe(STAGE1_FAST_MAX_TOKENS)
  })

  it('fast: block + allow → allow (2 calls)', async () => {
    const judge = scripted(['<block>yes</block><reason>force</reason>', '<block>no</block>'])
    const r = await classify({ ...base, twoStageMode: 'fast' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toEqual({
      block: false,
      stage: 'fast',
      overturnedBlock: { reason: 'force' }
    })
  })

  it('fast: block + block → block with the first reason (2 calls)', async () => {
    const judge = scripted([
      '<block>yes</block><reason>force</reason>',
      '<block>yes</block><reason>second</reason>'
    ])
    const r = await classify({ ...base, twoStageMode: 'fast' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ block: true, stage: 'fast', reason: 'force' })
  })

  it('both: a stage-1 allow makes ONE call (the confirmation never runs)', async () => {
    const judge = scripted(['<severity>2'])
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ block: false, stage: 'fast', severity: 2 })
    expect(reqs(judge)[0].maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
  })

  it('both: an escalated block + allow → 3 calls total, allow with the overturned block', async () => {
    const judge = scripted(['<severity>80', BLOCK, ALLOW])
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(judge).toHaveBeenCalledTimes(3)
    expect(r).toEqual({
      block: false,
      stage: 'thinking',
      severity: 80,
      overturnedBlock: {
        reason: '[Git Destructive] force-push to main',
        category: 'git_destructive'
      }
    })
    // The confirmation is stage 2 again, on the same budget.
    expect(reqs(judge)[2].stage).toBe('thinking')
    expect(reqs(judge)[2].maxTokens).toBe(STAGE2_MAX_TOKENS)
  })

  it('both: a full-review action is stage-2 only — block + allow is 2 calls', async () => {
    const judge = scripted([BLOCK, ALLOW])
    const r = await classify(
      {
        ...base,
        action: { toolName: 'bash', input: { command: 'git push --force' } },
        twoStageMode: 'both'
      },
      judge
    )
    expect(judge).toHaveBeenCalledTimes(2)
    expect(reqs(judge)[0].stage).toBe('thinking')
    expect(r.block).toBe(false)
    expect(r.overturnedBlock).toEqual({
      reason: '[Git Destructive] force-push to main',
      category: 'git_destructive'
    })
  })

  it('both: a stage-2 block + allow keeps no severity (stage 1 allow would not have escalated)', async () => {
    // Escalated path with an unparseable stage-1 reply: severity stays absent.
    const judge = scripted(['not a grade', BLOCK, ALLOW])
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(judge).toHaveBeenCalledTimes(3)
    expect(r.severity).toBeUndefined()
    expect(r.overturnedBlock).toBeDefined()
  })

  it('formatVerdictLine names the overturned block so logs show the rate', () => {
    expect(
      formatVerdictLine(
        { block: false, stage: 'thinking', overturnedBlock: { reason: 'x' } },
        'bash'
      )
    ).toBe('auto-mode allow (stage=thinking, overturned=block) bash')
    // …and a normal verdict keeps its old line, byte for byte.
    expect(formatVerdictLine({ block: false, stage: 'fast', severity: 3 }, 'bash')).toBe(
      'auto-mode allow (stage=fast, sev=3) bash'
    )
  })
})

// ---------------------------------------------------------------------------
// Routing (decision 11 additions)
// ---------------------------------------------------------------------------

describe('requiresFullReview — retryOf (decision 11b)', () => {
  const refused = (
    command: string,
    outcome: 'automode-blocked' | 'rejected-by-user' | 'ok' = 'automode-blocked'
  ): Pick<ClassifyInput, 'messages' | 'outcomes'> => ({
    messages: [toolCall('c1', 'bash', { command })],
    outcomes: { c1: outcome }
  })

  it('a retry of a refused call goes to full review — identical and subset alike', () => {
    const prior = refused('bun run build && bun run test')
    expect(
      requiresFullReview({
        action: { toolName: 'bash', input: { command: 'bun run  build && bun run test' } },
        environment: { cwd: '/repo' },
        ...prior
      })
    ).toBe(true)
    expect(
      requiresFullReview({
        action: { toolName: 'bash', input: { command: 'bun run test' } },
        environment: { cwd: '/repo' },
        ...prior
      })
    ).toBe(true)
  })

  it('a different action, or an earlier call that was not refused, stays with stage 1', () => {
    const prior = refused('bun run build && bun run test')
    expect(
      requiresFullReview({
        action: { toolName: 'bash', input: { command: 'bun run lint' } },
        environment: { cwd: '/repo' },
        ...prior
      })
    ).toBe(false)
    expect(
      requiresFullReview({
        action: { toolName: 'bash', input: { command: 'bun run test' } },
        environment: { cwd: '/repo' },
        ...refused('bun run build && bun run test', 'ok')
      })
    ).toBe(false)
  })

  it('a rejected-by-user call is a retry source too', () => {
    expect(
      requiresFullReview({
        action: { toolName: 'bash', input: { command: 'bun run build' } },
        ...refused('bun run build', 'rejected-by-user')
      })
    ).toBe(true)
  })

  it('the signature stays backward-compatible: action + meta alone still answer', () => {
    expect(
      requiresFullReview({ action: { toolName: 'bash', input: { command: 'git push' } } })
    ).toBe(true)
    expect(requiresFullReview({ action: { toolName: 'bash', input: { command: 'ls' } } })).toBe(
      false
    )
  })

  it('classify applies it: a retry is decided by stage 2, never by a stage-1 grade', async () => {
    const judge = scripted(['<block>no</block>'])
    const prior = refused('bun run build')
    const r = await classify(
      {
        ...base,
        action: { toolName: 'bash', input: { command: 'bun run build' } },
        twoStageMode: 'both',
        ...prior
      },
      judge
    )
    expect(judge).toHaveBeenCalledTimes(1)
    expect(reqs(judge)[0].stage).toBe('thinking')
    expect(r).toEqual({ block: false, stage: 'thinking' })
  })
})

describe('requiresFullReview — agent-control edit targets (decision 11c)', () => {
  const cwd = '/repo'
  const review = (
    toolName: string,
    input: Record<string, unknown>,
    environment: ClassifyInput['environment'] = { cwd }
  ): boolean => requiresFullReview({ action: { toolName, input }, environment })

  it('flags an edit/write of an agent-control path in every engine spelling', () => {
    expect(review('edit', { path: '.claude/settings.json' })).toBe(true)
    expect(review('edit', { file_path: 'CLAUDE.md' })).toBe(true)
    expect(review('edit', { filePath: '.git/config' })).toBe(true)
    expect(review('write', { path: '.claude/hooks/pre-tool.sh' })).toBe(true)
    expect(review('edit', { path: '/repo/.vscode/tasks.json' })).toBe(true)
  })

  it('reads every apply_patch / patch target from its file headers', () => {
    expect(
      review('apply_patch', {
        patchText: '*** Begin Patch\n*** Update File: .git/config\n*** End Patch'
      })
    ).toBe(true)
    expect(review('patch', { patchText: '*** Add File: .claude/settings.json\n' })).toBe(true)
    expect(
      review('apply_patch', {
        patchText: '*** Add File: src/a.ts\n+x\n*** Delete File: dist/x.js\n'
      })
    ).toBe(false)
  })

  it('a patch whose paths cannot be read goes to full review', () => {
    expect(review('apply_patch', { patchText: '*** Begin Patch\n*** End Patch' })).toBe(true)
    expect(review('patch', {})).toBe(true)
  })

  it('leaves an ordinary edit to stage 1', () => {
    expect(review('edit', { path: 'src/a.ts' })).toBe(false)
    expect(review('write', { filePath: 'docs/notes.md' })).toBe(false)
  })

  it('is worktree-relative: a worktree cwd does not make every path a .claude hit', () => {
    const worktree = { cwd: '/repo/.claude/worktrees/wt' }
    expect(review('edit', { path: '.cache/x.log' }, worktree)).toBe(false)
    expect(review('edit', { path: 'src/a.ts' }, worktree)).toBe(false)
    // …while a path that really names the parent's .claude still does.
    expect(review('edit', { path: '../.claude/settings.json' }, worktree)).toBe(true)
  })

  it('flags nothing extra for tools that are not edit-class', () => {
    expect(review('bash', { command: 'ls' })).toBe(false)
    expect(review('read', { path: '.claude/settings.json' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The user prompt's retryOf meta line
// ---------------------------------------------------------------------------

describe('the retryOf meta line', () => {
  const blocked = (command: string): Pick<ClassifyInput, 'messages' | 'outcomes'> => ({
    messages: [toolCall('c1', 'bash', { command })],
    outcomes: { c1: 'automode-blocked' }
  })

  const promptFor = (
    command: string,
    priorCommand: string,
    actionMeta?: Record<string, unknown>
  ): string =>
    buildUserPrompt(
      {
        ...base,
        ...blocked(priorCommand),
        action: { toolName: 'bash', input: { command } },
        ...(actionMeta ? { actionMeta } : {})
      },
      'INSTRUCTION'
    )

  it('renders the exact JSON line for an IDENTICAL retry', () => {
    expect(promptFor('rm -rf build', 'rm -rf  build')).toContain(
      '{"meta":{"retryOf":{"match":"identical","outcome":"automode-blocked","call":"bash {\\"command\\":\\"rm -rf  build\\"}"}}}'
    )
  })

  it('renders the exact JSON line for a SUBSET retry', () => {
    expect(promptFor('git push origin main', 'rm -rf build && git push origin main')).toContain(
      '{"meta":{"retryOf":{"match":"subset","outcome":"automode-blocked","call":"bash {\\"command\\":\\"rm -rf build && git push origin main\\"}"}}}'
    )
  })

  it('carries the same line the transcript shows for that call', () => {
    const prompt = promptFor('rm -rf build', 'rm -rf build')
    const lines = prompt.split('\n')
    const metaIndex = lines.findIndex((line) => line.startsWith('{"meta":'))
    expect(metaIndex).toBeGreaterThan(-1)
    const meta = JSON.parse(lines[metaIndex]) as { meta: { retryOf: { call: string } } }
    expect(lines).toContain(meta.meta.retryOf.call)
  })

  it('is merged into the ONE meta line, after the measured facts', () => {
    const prompt = promptFor('git push origin main', 'rm -rf build && git push origin main', {
      redirects: { targets: ['out.log'], allInScope: true }
    })
    expect(prompt).toContain(
      '{"meta":{"redirects":{"targets":["out.log"],"allInScope":true},"retryOf":{"match":"subset"'
    )
  })

  it('is absent when the action matches no refused call', () => {
    expect(promptFor('bun run test', 'rm -rf build')).not.toContain('"retryOf"')
  })

  it('is capped like the spec says: 300 chars of the call plus …', () => {
    const long = `echo ${'a'.repeat(400)}`
    const prompt = promptFor(long, long)
    const meta = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"meta":'))!) as {
      meta: { retryOf: { call: string } }
    }
    expect(meta.meta.retryOf.call.length).toBe(RETRY_CALL_MAX_CHARS + 1)
    expect(meta.meta.retryOf.call.endsWith('…')).toBe(true)
  })

  it('never changes the system prompt (it is user-turn only)', async () => {
    const judge = scripted(['<block>no</block>'])
    const prior = blocked('ls')
    await classify({ ...base, twoStageMode: 'thinking', ...prior }, judge)
    const plain = scripted(['<block>no</block>'])
    await classify({ ...base, twoStageMode: 'thinking' }, plain)
    expect(reqs(judge)[0].system).toBe(reqs(plain)[0].system)
    expect(reqs(judge)[0].user).toContain('"retryOf"')
    expect(reqs(plain)[0].user).not.toContain('"retryOf"')
  })
})
