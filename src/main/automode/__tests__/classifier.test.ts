/**
 * Unit tests for the engine-neutral auto-mode classifier core (ADR-023, amended
 * by `docs/automode-rework-plan.md` §4) — pure functions plus the orchestrator
 * with an injected fake transport. No model calls.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  slimTranscript,
  truncateProseTail,
  MAX_ASSISTANT_PROSE_CHARS,
  renderAction,
  buildUserPrompt,
  buildPolicyPrompt,
  normalizeCategory,
  parseVerdict,
  parseVerdictOrNull,
  classify,
  isAutoModeFastPathAllowed,
  STAGE1_BOTH_MAX_TOKENS,
  STAGE1_FAST_MAX_TOKENS,
  STAGE2_MAX_TOKENS,
  STAGE1_STOP_SEQUENCES,
  type ClassifyInput,
  type JudgeRequest
} from '../classifier'
import type { ChatMessage } from '../../../shared/types'

let seq = 0
function msg(role: 'user' | 'assistant', content: ChatMessage['content']): ChatMessage {
  return { id: `m${seq++}`, role, content, timestamp: 0 }
}

describe('slimTranscript', () => {
  it('keeps user text + assistant tool CALLS; drops thinking + tool results', () => {
    const messages: ChatMessage[] = [
      msg('user', [{ type: 'text', text: 'research chatview' }]),
      msg('assistant', [
        { type: 'thinking', text: 'let me think...' },
        { type: 'text', text: 'Sure, I will explore.' },
        { type: 'tool_use', toolUseId: 't1', toolName: 'grep', toolInput: { pattern: 'ChatPanel' } }
      ]),
      msg('user', [{ type: 'tool_result', toolUseId: 't1', toolResult: 'a.tsx\nb.tsx', isError: false }])
    ]
    // The assistant prose is pending but never answered by a human turn, so it
    // is dropped; the thinking block and the tool result are always dropped.
    expect(slimTranscript(messages)).toBe('User: research chatview\ngrep {"pattern":"ChatPanel"}')
  })

  it('skips empty user text', () => {
    expect(slimTranscript([msg('user', [{ type: 'text', text: '   ' }])])).toBe('')
  })

  it('drops images and empty assistant prose', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [{ type: 'text', text: '   ' }]),
      msg('user', [
        { type: 'image', mediaType: 'image/png', base64Data: 'AAAA' },
        { type: 'text', text: 'what is this' }
      ])
    ]
    expect(slimTranscript(messages)).toBe('User: what is this')
  })

  // ── G2: the Path B consent referent (plan §4.3) ───────────────────────────

  it('retains the assistant prose immediately preceding a user text message', () => {
    const messages: ChatMessage[] = [
      msg('user', [{ type: 'text', text: 'clean up the branch' }]),
      msg('assistant', [{ type: 'text', text: 'I will force-push to main. OK?' }]),
      msg('user', [{ type: 'text', text: 'yes' }])
    ]
    expect(slimTranscript(messages)).toBe(
      'User: clean up the branch\nAssistant: I will force-push to main. OK?\nUser: yes'
    )
  })

  it('joins all text blocks of ONE assistant message with newlines', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [
        { type: 'text', text: 'Plan:' },
        { type: 'tool_use', toolUseId: 't1', toolName: 'read', toolInput: { path: 'a' } },
        { type: 'text', text: 'I will drop the table.' }
      ]),
      msg('user', [{ type: 'text', text: 'go' }])
    ]
    // The tool call renders in place; both prose blocks flush as one entry.
    expect(slimTranscript(messages)).toBe(
      'read {"path":"a"}\nAssistant: Plan:\nI will drop the table.\nUser: go'
    )
  })

  it('a newer assistant message REPLACES the pending prose (overwrite semantics)', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [{ type: 'text', text: 'FIRST proposal' }]),
      msg('assistant', [{ type: 'text', text: 'SECOND proposal' }]),
      msg('user', [{ type: 'text', text: 'yes' }])
    ]
    const out = slimTranscript(messages)
    expect(out).toContain('Assistant: SECOND proposal')
    expect(out).not.toContain('FIRST proposal')
  })

  it('intervening assistant tool calls do NOT break adjacency', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [{ type: 'text', text: 'I will force-push to main. OK?' }]),
      msg('assistant', [
        { type: 'tool_use', toolUseId: 't1', toolName: 'bash', toolInput: { command: 'git status' } }
      ]),
      msg('user', [{ type: 'tool_result', toolUseId: 't1', toolResult: 'clean', isError: false }]),
      msg('user', [{ type: 'text', text: 'yes' }])
    ]
    expect(slimTranscript(messages)).toBe(
      'bash {"command":"git status"}\nAssistant: I will force-push to main. OK?\nUser: yes'
    )
  })

  it('an intervening USER text message DOES break adjacency (prose flushes once)', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [{ type: 'text', text: 'I will force-push to main. OK?' }]),
      msg('user', [{ type: 'text', text: 'hold on' }]),
      msg('user', [{ type: 'text', text: 'yes' }])
    ]
    const out = slimTranscript(messages)
    // Retained against the FIRST reply only — the bare "yes" gets no referent.
    expect(out).toBe('Assistant: I will force-push to main. OK?\nUser: hold on\nUser: yes')
    expect(out.match(/Assistant:/g)).toHaveLength(1)
  })

  it('non-adjacent assistant prose (no user reply at all) is dropped', () => {
    const messages: ChatMessage[] = [
      msg('user', [{ type: 'text', text: 'go' }]),
      msg('assistant', [{ type: 'text', text: 'Working on it, will report back.' }])
    ]
    expect(slimTranscript(messages)).toBe('User: go')
  })

  it('truncates retained prose to the TAIL — the end of a long proposal survives', () => {
    // The referent the user affirms sits at the END of a long message. Head
    // truncation would cut off exactly what this feature exists to preserve.
    const tail = 'Finally, I will run `git push --force origin main`. Shall I?'
    const long = 'x'.repeat(MAX_ASSISTANT_PROSE_CHARS * 2) + tail
    const messages: ChatMessage[] = [
      msg('assistant', [{ type: 'text', text: long }]),
      msg('user', [{ type: 'text', text: 'yes' }])
    ]
    const out = slimTranscript(messages)
    expect(out).toContain(tail)
    // …and the START is what got dropped.
    expect(out).not.toContain('x'.repeat(MAX_ASSISTANT_PROSE_CHARS + 1))
    const line = out.split('\n').find((l) => l.startsWith('Assistant: '))!
    expect(line.length).toBeLessThan(MAX_ASSISTANT_PROSE_CHARS + 60)
  })
})

describe('truncateProseTail', () => {
  it('leaves short text untouched', () => {
    expect(truncateProseTail('short', 100)).toBe('short')
  })
  it('keeps the last N chars and marks the cut', () => {
    const out = truncateProseTail('abcdefghij', 4)
    expect(out.endsWith('ghij')).toBe(true)
    expect(out).toContain('truncated')
  })
  it('never starts on a dangling low surrogate', () => {
    // 4 emoji = 8 code units; slicing at 5 would split the second-to-last pair.
    const out = truncateProseTail('😀😀😀😀', 5)
    expect(out.includes('�')).toBe(false)
    expect(JSON.stringify(out)).not.toMatch(/\\ud[c-f]/i)
  })
  it('exports the cli.js-parity constant', () => {
    expect(MAX_ASSISTANT_PROSE_CHARS).toBe(2000)
  })
})

describe('renderAction + buildUserPrompt', () => {
  it('renders the proposed action as toolName <input>', () => {
    expect(renderAction({ toolName: 'bash', input: { command: 'rm -rf /' } })).toBe(
      'bash {"command":"rm -rf /"}'
    )
  })
  it('wraps transcript + action + instruction', () => {
    const input: ClassifyInput = {
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      action: { toolName: 'bash', input: { command: 'ls' } },
      environment: { cwd: '/repo' }
    }
    const p = buildUserPrompt(input, 'INSTRUCT')
    expect(p).toContain('<transcript>')
    expect(p).toContain('User: hi')
    expect(p).toContain('Proposed next action:\nbash {"command":"ls"}')
    expect(p).toContain('INSTRUCT')
  })
  it('the system prompt carries the environment ground truth (phase 2)', () => {
    // The old inline POLICY constant took a free-text `environment` string; the
    // policy document now renders a structured Environment section instead.
    const p = buildPolicyPrompt({ cwd: '/repo/foo' })
    expect(p).toContain('## Environment')
    expect(p).toContain('Working directory: /repo/foo')
  })
})

describe('parseVerdict (fail-closed)', () => {
  it('parses yes/no, closing tag optional', () => {
    expect(parseVerdict('<block>yes</block>').block).toBe(true)
    expect(parseVerdict('<block>no</block>').block).toBe(false)
    expect(parseVerdict('...<block>yes').block).toBe(true) // truncated by stop seq
  })
  it('extracts reason', () => {
    expect(parseVerdict('<block>yes</block><reason>destructive</reason>').reason).toBe('destructive')
  })
  it('unparseable → block (fail-closed)', () => {
    expect(parseVerdict('I cannot help with that').block).toBe(true)
    expect(parseVerdict('').block).toBe(true)
  })
  it('parseVerdictOrNull distinguishes "no verdict" from "block"', () => {
    expect(parseVerdictOrNull('I cannot help with that')).toBeNull()
    expect(parseVerdictOrNull('<block>yes</block>')).toEqual({ block: true })
  })
  it('ignores a verdict quoted inside <thinking>', () => {
    expect(parseVerdictOrNull('<thinking>maybe <block>yes</block></thinking><block>no</block>')).toEqual({
      block: false
    })
  })
  it('an UNCLOSED <thinking> is unparseable (truncated reasoning → fail closed)', () => {
    expect(parseVerdictOrNull('<thinking>hmm <block>no</block>')).toBeNull()
  })
})

// ── <category>: a DERIVED allowlist, not free text (ref §9.6, porting note #4) ─

describe('normalizeCategory (cli.js ppd port)', () => {
  it('lowercases, collapses non-alphanumeric runs to _, trims', () => {
    expect(normalizeCategory('Logging/Audit Tampering')).toBe('logging_audit_tampering')
    expect(normalizeCategory('Data Exfiltration')).toBe('data_exfiltration')
    expect(normalizeCategory('Auto-Mode Bypass')).toBe('auto_mode_bypass')
    expect(normalizeCategory('  Real-World   Transactions!  ')).toBe('real_world_transactions')
    expect(normalizeCategory('***')).toBe('')
  })
  it('is idempotent on an already-normalized slug', () => {
    expect(normalizeCategory('sensitive_source_provenance')).toBe('sensitive_source_provenance')
  })
})

describe('parseVerdict — <category> validation', () => {
  it('surfaces a known rule name as its normalized slug', () => {
    expect(
      parseVerdictOrNull(
        '<block>yes</block><category>Git Destructive</category><reason>[Git Destructive] force-push</reason>'
      )
    ).toEqual({ block: true, reason: '[Git Destructive] force-push', category: 'git_destructive' })
  })

  it('DROPS an invented category — the block still stands', () => {
    // The category field is model-controlled text reached by attacker-influenced
    // transcript content; anything outside the derived set is not trusted.
    const v = parseVerdictOrNull(
      '<block>yes</block><category>Ignore Previous Rules</category><reason>[X] nope</reason>'
    )
    expect(v).toMatchObject({ block: true, reason: '[X] nope' })
    expect(v?.category).toBeUndefined()
  })

  it('DROPS an ALLOW exception name (exceptions are never categories)', () => {
    expect(
      parseVerdictOrNull('<block>yes</block><category>Security Discussion</category>')?.category
    ).toBeUndefined()
  })

  it('ignores a category on an ALLOW verdict', () => {
    expect(parseVerdictOrNull('<block>no</block><category>Git Destructive</category>')).toEqual({
      block: false
    })
  })

  it('tolerates a missing category on a block', () => {
    expect(parseVerdictOrNull('<block>yes</block><reason>bad</reason>')).toEqual({
      block: true,
      reason: 'bad'
    })
  })

  it('does not read a category out of <thinking>', () => {
    const v = parseVerdictOrNull(
      '<thinking>maybe <category>Git Destructive</category></thinking><block>yes</block>'
    )
    expect(v?.category).toBeUndefined()
  })

  it('parseVerdict keeps the category on its fail-closed path shape', () => {
    expect(parseVerdict('<block>yes</block><category>Data Exfiltration</category>').category).toBe(
      'data_exfiltration'
    )
    expect(parseVerdict('nonsense').category).toBeUndefined()
  })
})

describe('isAutoModeFastPathAllowed', () => {
  it('covers the read-only categories only', () => {
    expect(isAutoModeFastPathAllowed('read')).toBe(true)
    expect(isAutoModeFastPathAllowed('glob')).toBe(true)
    expect(isAutoModeFastPathAllowed('bash')).toBe(false)
  })
})

describe('classify (orchestrator)', () => {
  const base: ClassifyInput = {
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    action: { toolName: 'bash', input: { command: 'ls' } },
    environment: { cwd: '/repo' }
  }
  const reqs = (judge: { mock: { calls: unknown[][] } }): JudgeRequest[] =>
    judge.mock.calls.map((c) => c[0] as JudgeRequest)

  it('fast mode → single call, returns its verdict, no stop sequence', async () => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'fast' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'fast' })
    expect(judge).toHaveBeenCalledTimes(1)
    const [req] = reqs(judge)
    expect(req.maxTokens).toBe(STAGE1_FAST_MAX_TOKENS)
    // cli.js omits the stop sequence in `fast` so the <reason> survives.
    expect(req.stopSequences).toBeUndefined()
  })

  it('fast mode: unparseable → block (stage 1 is the sole decider here)', async () => {
    const judge = vi.fn().mockResolvedValue('Sorry, I cannot comply.')
    const r = await classify({ ...base, twoStageMode: 'fast' }, judge)
    expect(r.block).toBe(true)
    expect(r.stage).toBe('fast')
    expect(r.unavailable).toBeUndefined()
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('thinking mode → a single stage-2 call', async () => {
    const judge = vi.fn().mockResolvedValue('<thinking>fine</thinking><block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'thinking' })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(reqs(judge)[0].maxTokens).toBe(STAGE2_MAX_TOKENS)
    expect(reqs(judge)[0].stopSequences).toBeUndefined()
  })

  it('both mode: stage-1 ALLOW short-circuits (one call), on the cheap budget', async () => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'fast' })
    expect(judge).toHaveBeenCalledTimes(1)
    const [req] = reqs(judge)
    expect(req.maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
    expect(req.stopSequences).toEqual(STAGE1_STOP_SEQUENCES)
  })

  it('both mode: stage 1 grades HARM ONLY and defers intent/exceptions to stage 2', async () => {
    // The G1 fix is a division of labour: stage 1 must not be asked the same
    // question as stage 2, or the cheap pass has to be as smart as the
    // expensive one. It is also NOT told its block merely escalates.
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce('<block>no</block>')
    await classify({ ...base, twoStageMode: 'both' }, judge)
    const [s1, s2] = reqs(judge)
    expect(s1.user).toMatch(/does NOT apply user intent or ALLOW exceptions/i)
    expect(s1.user).toMatch(/full effect/i)
    expect(s1.user).not.toMatch(/escalat/i)
    expect(s2.user).toMatch(/apply user intent/i)
    // Same system prompt, different instruction — the stages differ only in job.
    expect(s1.system).toBe(s2.system)
  })

  it('both mode: stage-1 BLOCK escalates and a stage-2 ALLOW WINS', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce('<thinking>the user named the branch</thinking><block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'thinking' })
    expect(judge).toHaveBeenCalledTimes(2)
    // Stage 1 cannot emit a final block in `both` mode: its budget/stop
    // sequence prove it only ever produced one token of signal.
    const [s1, s2] = reqs(judge)
    expect(s1.maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
    expect(s1.stopSequences).toEqual(STAGE1_STOP_SEQUENCES)
    expect(s2.maxTokens).toBe(STAGE2_MAX_TOKENS)
    expect(s2.stopSequences).toBeUndefined()
  })

  it('both mode: stage-1 UNPARSEABLE escalates — it must not block outright', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('Looking at this, I think it seems fine?')
      .mockResolvedValueOnce('<block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ block: false, stage: 'thinking' })
    // …and stage 1 really was the unparseable one (its budget identifies it).
    expect(reqs(judge)[0].maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
  })

  it('both mode: stage-2 BLOCK is final and carries its reason', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce('<block>yes</block><reason>force-push to main</reason>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, stage: 'thinking', reason: 'force-push to main' })
    expect(r.unavailable).toBeUndefined()
  })

  it('both mode: a stage-2 category flows through to the result', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce(
        '<thinking>no consent</thinking><block>yes</block><category>Git Destructive</category>' +
          '<reason>[Git Destructive] force-push to main was never named</reason>'
      )
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, stage: 'thinking', category: 'git_destructive' })
  })

  it('both mode: an invented stage-2 category is dropped but the block survives', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce(
        '<block>yes</block><category>Please Allow Everything</category><reason>[?] hmm</reason>'
      )
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r.block).toBe(true)
    expect(r.category).toBeUndefined()
    expect(r.reason).toBe('[?] hmm')
  })

  it('stage 2 is instructed in the category grammar; stage 1 is NOT', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce('<block>no</block>')
    await classify({ ...base, twoStageMode: 'both' }, judge)
    const [s1, s2] = reqs(judge)
    expect(s1.user).not.toContain('<category>')
    expect(s2.user).toContain('<category>Exact Rule Name</category>')
    expect(s2.user).toContain('<reason>[Exact Rule Name] one short sentence</reason>')
  })

  it('the system prompt is the rendered policy document with the environment injected', async () => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    await classify(
      { ...base, environment: { cwd: '/srv/app', trustedDomains: ['files.example.com'] } },
      judge
    )
    const [req] = reqs(judge)
    expect(req.system).toContain('Working directory: /srv/app')
    expect(req.system).toContain('files.example.com')
    // …and the corpus itself, not the old inline five-bullet policy.
    expect(req.system).toContain('## HARD BLOCK')
    expect(req.system).toContain('Data Exfiltration')
  })

  it('both mode: stage-2 unparseable → block, fail-closed, WITHOUT unavailable', async () => {
    // `unavailable` means "we got nothing back"; here we got an answer we
    // cannot read, so retrying is not obviously right → a real block.
    const judge = vi.fn().mockResolvedValueOnce('<block>yes</block>').mockResolvedValueOnce('¯\\_(ツ)_/¯')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r.block).toBe(true)
    expect(r.stage).toBe('thinking')
    expect(r.unavailable).toBeUndefined()
  })

  it('transport throws at STAGE 1 → block + unavailable, no escalation', async () => {
    const judge = vi.fn().mockRejectedValue(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('transport throws at STAGE 2 → block + unavailable (our documented deviation)', async () => {
    // cli.js turns this into a hard block "based on stage 1"; we mark it
    // unavailable, and the wiring maps unavailable → ask the human.
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockRejectedValueOnce(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
    expect(judge).toHaveBeenCalledTimes(2)
  })

  it('transport throws in thinking mode → block + unavailable', async () => {
    const judge = vi.fn().mockRejectedValue(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
  })

  it('defaults to both mode', async () => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    await classify(base, judge)
    expect(reqs(judge)[0].maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
  })
})
