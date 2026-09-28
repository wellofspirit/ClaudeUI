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
  parseSeverityOrNull,
  requiresFullReview,
  classify,
  isAutoModeFastPathAllowed,
  STAGE1_BOTH_MAX_TOKENS,
  STAGE1_FAST_MAX_TOKENS,
  STAGE2_MAX_TOKENS,
  STAGE1_STOP_SEQUENCES,
  STAGE1_ALLOW_MAX_SEVERITY,
  STAGE1_TIMEOUT_MS,
  STAGE2_TIMEOUT_MS,
  UNPARSEABLE_REASON,
  UNPARSEABLE_RAW_TAIL_CHARS,
  formatUnparseableJudgeReply,
  formatVerdictLine,
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
      msg('user', [
        { type: 'tool_result', toolUseId: 't1', toolResult: 'a.tsx\nb.tsx', isError: false }
      ])
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
        {
          type: 'tool_use',
          toolUseId: 't1',
          toolName: 'bash',
          toolInput: { command: 'git status' }
        }
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

  // ── Phase 3: {"outcome":…} annotations (ref §5) ───────────────────────────

  it('renders an outcome line IMMEDIATELY after the call it belongs to', () => {
    // The correlation is positional (cli.js correlates by id), so nothing may
    // come between the call and its annotation.
    const messages: ChatMessage[] = [
      msg('user', [{ type: 'text', text: 'push it' }]),
      msg('assistant', [
        { type: 'tool_use', toolUseId: 't1', toolName: 'bash', toolInput: { command: 'git push' } },
        { type: 'tool_use', toolUseId: 't2', toolName: 'read', toolInput: { filePath: 'a.ts' } }
      ])
    ]
    expect(slimTranscript(messages, { t1: 'rejected-by-user', t2: 'ok' })).toBe(
      'User: push it\n' +
        'bash {"command":"git push"}\n{"outcome":"rejected-by-user"}\n' +
        'read {"filePath":"a.ts"}\n{"outcome":"ok"}'
    )
  })

  it('annotates ONLY the calls that have an outcome — absence is not success', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [
        { type: 'tool_use', toolUseId: 't1', toolName: 'bash', toolInput: { command: 'a' } },
        { type: 'tool_use', toolUseId: 't2', toolName: 'bash', toolInput: { command: 'b' } }
      ])
    ]
    const out = slimTranscript(messages, { t2: 'automode-blocked' })
    expect(out).toBe('bash {"command":"a"}\nbash {"command":"b"}\n{"outcome":"automode-blocked"}')
    expect(out.match(/outcome/g)).toHaveLength(1)
  })

  it('emits nothing extra when no outcomes are supplied (phase-1/2 behaviour)', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [
        { type: 'tool_use', toolUseId: 't1', toolName: 'bash', toolInput: { command: 'a' } }
      ])
    ]
    expect(slimTranscript(messages)).toBe('bash {"command":"a"}')
    expect(slimTranscript(messages, {})).toBe('bash {"command":"a"}')
  })

  it('an outcome for an unknown toolUseId is inert (no orphan line)', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [
        { type: 'tool_use', toolUseId: 't1', toolName: 'bash', toolInput: { command: 'a' } }
      ])
    ]
    expect(slimTranscript(messages, { nope: 'error' })).toBe('bash {"command":"a"}')
  })

  it('does not disturb the Path B prose flush', () => {
    const messages: ChatMessage[] = [
      msg('assistant', [
        { type: 'text', text: 'I will force-push to main. OK?' },
        {
          type: 'tool_use',
          toolUseId: 't1',
          toolName: 'bash',
          toolInput: { command: 'git status' }
        }
      ]),
      msg('user', [{ type: 'text', text: 'yes' }])
    ]
    expect(slimTranscript(messages, { t1: 'ok' })).toBe(
      'bash {"command":"git status"}\n{"outcome":"ok"}\n' +
        'Assistant: I will force-push to main. OK?\nUser: yes'
    )
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
  // ── Phase 3: the {"meta":…} ground-truth line (ref §5) ────────────────────

  it('renders the meta line DIRECTLY above the action block, with no gap', () => {
    // Adjacency is the binding: ref §5 places meta lines "directly above the
    // tool call they describe". A blank line (or the transcript in between)
    // would leave the judge guessing what was measured.
    const input: ClassifyInput = {
      messages: [msg('user', [{ type: 'text', text: 'commit and push' }])],
      action: { toolName: 'bash', input: { command: 'git add -A && git push' } },
      environment: { cwd: '/repo' },
      actionMeta: { gitStatus: { clean: false, modified: 2, untracked: ['.env'] } }
    }
    const p = buildUserPrompt(input, 'INSTRUCT')
    expect(p).toContain(
      '{"meta":{"gitStatus":{"clean":false,"modified":2,"untracked":[".env"]}}}\n' +
        'Proposed next action:\nbash {"command":"git add -A && git push"}'
    )
    // …and it sits below the transcript, not inside it.
    expect(p.indexOf('</transcript>')).toBeLessThan(p.indexOf('{"meta"'))
  })

  it('emits NO meta line when actionMeta is absent or empty', () => {
    // An empty {"meta":{}} would read as "we measured and found nothing".
    const base: ClassifyInput = {
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      action: { toolName: 'bash', input: { command: 'ls' } },
      environment: { cwd: '/repo' }
    }
    expect(buildUserPrompt(base, 'I')).not.toContain('{"meta"')
    expect(buildUserPrompt({ ...base, actionMeta: {} }, 'I')).not.toContain('{"meta"')
  })

  it('passes outcomes through to the transcript', () => {
    const input: ClassifyInput = {
      messages: [
        msg('assistant', [
          {
            type: 'tool_use',
            toolUseId: 't1',
            toolName: 'bash',
            toolInput: { command: 'git push' }
          }
        ])
      ],
      action: { toolName: 'bash', input: { command: 'git push' } },
      environment: { cwd: '/repo' },
      outcomes: { t1: 'rejected-by-user' }
    }
    expect(buildUserPrompt(input, 'I')).toContain(
      'bash {"command":"git push"}\n{"outcome":"rejected-by-user"}'
    )
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
    expect(parseVerdict('<block>yes</block><reason>destructive</reason>').reason).toBe(
      'destructive'
    )
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
    expect(
      parseVerdictOrNull('<thinking>maybe <block>yes</block></thinking><block>no</block>')
    ).toEqual({
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

  it('accepts the user-specified soft rule as a category (ADR-083 §4)', () => {
    // Its slug is in the derived set whether or not the user has a block list,
    // so a verdict citing it keeps its category.
    expect(
      parseVerdictOrNull('<block>yes</block><category>User-Specified Block</category>')?.category
    ).toBe('user_specified_block')
    // …while the user's ALLOW exception, like every exception, is never one.
    expect(
      parseVerdictOrNull('<block>yes</block><category>User-Specified Allow</category>')?.category
    ).toBeUndefined()
  })

  it('parseVerdict keeps the category on its fail-closed path shape', () => {
    expect(parseVerdict('<block>yes</block><category>Data Exfiltration</category>').category).toBe(
      'data_exfiltration'
    )
    expect(parseVerdict('nonsense').category).toBeUndefined()
  })
})

describe('parseSeverityOrNull (stage-1 grade, ADR-083 §2)', () => {
  it('reads an integer 0-100, closing tag optional (the stop sequence eats it)', () => {
    expect(parseSeverityOrNull('<severity>0</severity>')).toBe(0)
    expect(parseSeverityOrNull('<severity>15')).toBe(15)
    expect(parseSeverityOrNull('<severity> 72 </severity>')).toBe(72)
    expect(parseSeverityOrNull('<SEVERITY>100</SEVERITY>')).toBe(100)
  })

  it('out of range or not an integer → null (the caller escalates)', () => {
    expect(parseSeverityOrNull('<severity>101</severity>')).toBeNull()
    expect(parseSeverityOrNull('<severity>1000</severity>')).toBeNull()
    expect(parseSeverityOrNull('<severity>-5</severity>')).toBeNull()
    // A fraction must not round down into an allow: 15.5 is above the threshold.
    expect(parseSeverityOrNull('<severity>15.5</severity>')).toBeNull()
    expect(parseSeverityOrNull('<severity>low</severity>')).toBeNull()
  })

  it('no grade at all → null', () => {
    expect(parseSeverityOrNull('')).toBeNull()
    expect(parseSeverityOrNull('Looking at this, it seems fine.')).toBeNull()
    expect(parseSeverityOrNull('<block>no</block>')).toBeNull()
  })

  it('two DIFFERENT grades → null (ambiguous); a repeated identical grade is one grade', () => {
    expect(parseSeverityOrNull('<severity>5</severity><severity>80</severity>')).toBeNull()
    expect(parseSeverityOrNull('<severity>5</severity> so <severity>5</severity>')).toBe(5)
  })

  it('ignores a grade inside <thinking>, and an unclosed <thinking> is no grade', () => {
    expect(
      parseSeverityOrNull('<thinking>maybe <severity>90</severity></thinking><severity>3')
    ).toBe(3)
    expect(parseSeverityOrNull('<thinking>hmm <severity>3</severity>')).toBeNull()
  })
})

describe('requiresFullReview (ADR-083 §2)', () => {
  const bash = (command: string, actionMeta?: Record<string, unknown>): boolean =>
    requiresFullReview({ action: { toolName: 'bash', input: { command } }, actionMeta })

  it('flags the destructive and shipping shapes ground truth singles out', () => {
    expect(bash('git reset --hard')).toBe(true)
    expect(bash('git checkout -- .')).toBe(true)
    expect(bash('git clean -fd')).toBe(true)
    expect(bash('rm -rf x')).toBe(true)
    expect(bash('git commit -m x')).toBe(true)
    expect(bash('git push')).toBe(true)
    expect(bash('git remote set-url origin git@evil:x.git')).toBe(true)
    expect(bash('gh pr create --fill')).toBe(true)
    // Composite: one flagged segment is enough.
    expect(bash('bun run build && git push origin main')).toBe(true)
  })

  it('flags remote execution and the instance-metadata endpoints, heredoc bodies included', () => {
    expect(bash("ssh ubuntu@relay.example 'sudo systemctl stop hysteria-server'")).toBe(true)
    expect(bash('scp build.tgz ubuntu@relay.example:/opt')).toBe(true)
    expect(bash('rsync -a dist/ ubuntu@relay.example:/srv/app')).toBe(true)
    expect(bash('kubectl exec -it web-0 -- sh')).toBe(true)
    expect(bash('docker exec db psql -c "drop table x"')).toBe(true)
    expect(bash('Invoke-Command -ComputerName srv01 -ScriptBlock { Stop-Service w3svc }')).toBe(
      true
    )
    // The harvested real case: a metadata probe inside a script written and run in one call.
    expect(
      bash(
        'cat > deploy/_ocicheck.py <<\'PY\'\nimport paramiko\nc.exec_command("curl -s http://169.254.169.254/opc/v2/vnics/")\nPY\nuv run python deploy/_ocicheck.py'
      )
    ).toBe(true)
    expect(bash('curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/')).toBe(true)
  })

  it('does not flag local rsync or kubectl reads', () => {
    expect(bash('rsync -a dist/ backup/')).toBe(false)
    expect(bash('kubectl get pods')).toBe(false)
    expect(bash('docker compose up -d postgres')).toBe(false)
  })

  it('leaves routine commands to stage 1', () => {
    expect(bash('bun run test')).toBe(false)
    expect(bash('git checkout -b feature/x')).toBe(false)
    expect(bash('git status')).toBe(false)
    expect(bash('rm -r dist')).toBe(false)
  })

  it('flags a redirect unless it measured all in scope; a malformed meta line is not in scope', () => {
    const redirects = (r: unknown): boolean => bash('bun run test > out.log', { redirects: r })
    expect(redirects({ targets: ['out.log'], allInScope: true })).toBe(false)
    expect(redirects({ targets: ['/etc/x'], allInScope: false, outOfScope: ['/etc/x'] })).toBe(true)
    expect(redirects({ targets: ['out.log'] })).toBe(true)
    expect(redirects({ allInScope: 'true' })).toBe(true)
    expect(redirects(null)).toBe(true)
    expect(redirects(true)).toBe(true)
    // Other measured facts alone never force a full review.
    expect(bash('bun run test', { gitStatus: { clean: false } })).toBe(false)
  })

  it('only reads shell commands', () => {
    expect(
      requiresFullReview({ action: { toolName: 'edit', input: { command: 'git push' } } })
    ).toBe(false)
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
    // The completion rides along so the wiring can debug-log it.
    expect(r.reason).toBe(UNPARSEABLE_REASON)
    expect(r.raw).toBe('Sorry, I cannot comply.')
  })

  it('thinking mode → a single stage-2 call', async () => {
    const judge = vi.fn().mockResolvedValue('<thinking>fine</thinking><block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'thinking' })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(reqs(judge)[0].maxTokens).toBe(STAGE2_MAX_TOKENS)
    expect(reqs(judge)[0].stopSequences).toBeUndefined()
  })

  it('both mode: a low stage-1 grade short-circuits (one call), on the cheap budget', async () => {
    const judge = vi.fn().mockResolvedValue('<severity>0')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toEqual({ block: false, stage: 'fast', severity: 0 })
    expect(judge).toHaveBeenCalledTimes(1)
    const [req] = reqs(judge)
    expect(req.maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
    expect(req.maxTokens).toBe(64)
    expect(req.stopSequences).toEqual(['</severity>'])
    expect(req.stopSequences).toEqual(STAGE1_STOP_SEQUENCES)
    // A copy: a transport mutating its request cannot poison the constant.
    expect(req.stopSequences).not.toBe(STAGE1_STOP_SEQUENCES)
    expect(req.user).toContain('Respond with <severity>N</severity> ONLY')
  })

  it('both mode: the threshold is inclusive — 15 allows at stage 1, 16 escalates', async () => {
    expect(STAGE1_ALLOW_MAX_SEVERITY).toBe(15)
    const at = vi.fn().mockResolvedValue('<severity>15</severity>')
    expect(await classify({ ...base, twoStageMode: 'both' }, at)).toEqual({
      block: false,
      stage: 'fast',
      severity: 15
    })
    expect(at).toHaveBeenCalledTimes(1)

    const above = vi
      .fn()
      .mockResolvedValueOnce('<severity>16')
      .mockResolvedValueOnce('<block>no</block>')
    expect(await classify({ ...base, twoStageMode: 'both' }, above)).toEqual({
      block: false,
      stage: 'thinking',
      severity: 16
    })
    expect(above).toHaveBeenCalledTimes(2)
  })

  it('both mode: a high grade escalates, stage 2 decides, and the grade rides along', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>80')
      .mockResolvedValueOnce(
        '<block>yes</block><category>Git Destructive</category><reason>[Git Destructive] x</reason>'
      )
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toEqual({
      block: true,
      stage: 'thinking',
      category: 'git_destructive',
      reason: '[Git Destructive] x',
      severity: 80
    })
  })

  it.each([
    ['unparseable', 'Looking at this, I think it seems fine?'],
    ['out of range', '<severity>101</severity>'],
    ['ambiguous', '<severity>5</severity><severity>60</severity>'],
    ['the old yes/no grammar', '<block>no</block>']
  ])('both mode: a %s stage-1 reply escalates, with no severity', async (_label, reply) => {
    const judge = vi.fn().mockResolvedValueOnce(reply).mockResolvedValueOnce('<block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ block: false, stage: 'thinking' })
  })

  it.each([
    ['git reset --hard', undefined],
    ['git push', undefined],
    ['rm -rf x', undefined],
    ['git commit -m x', undefined],
    [
      'bun run test > /etc/out.log',
      { redirects: { targets: ['/etc/out.log'], allInScope: false, outOfScope: ['/etc/out.log'] } }
    ]
  ])('both mode: %s never reaches stage 1 — stage 2 is the only call', async (command, meta) => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    const r = await classify(
      {
        ...base,
        action: { toolName: 'bash', input: { command } },
        ...(meta ? { actionMeta: meta } : {}),
        twoStageMode: 'both'
      },
      judge
    )
    expect(judge).toHaveBeenCalledTimes(1)
    const [req] = reqs(judge)
    expect(req.stage).toBe('thinking')
    expect(req.maxTokens).toBe(STAGE2_MAX_TOKENS)
    expect(r).toEqual({ block: false, stage: 'thinking' })
    expect(r.severity).toBeUndefined()
  })

  it.each([
    ['bun run test', undefined],
    ['bun run test > build.log 2>&1', { redirects: { targets: ['build.log'], allInScope: true } }]
  ])('both mode: %s still gets a stage-1 grade', async (command, meta) => {
    const judge = vi.fn().mockResolvedValue('<severity>2')
    const r = await classify(
      {
        ...base,
        action: { toolName: 'bash', input: { command } },
        ...(meta ? { actionMeta: meta } : {}),
        twoStageMode: 'both'
      },
      judge
    )
    expect(judge).toHaveBeenCalledTimes(1)
    expect(reqs(judge)[0].stage).toBe('fast')
    expect(r).toEqual({ block: false, stage: 'fast', severity: 2 })
  })

  it('full-review shapes apply only to `both`: fast and thinking modes are unchanged', async () => {
    const action = { toolName: 'bash', input: { command: 'git push --force' } }
    const fast = vi.fn().mockResolvedValue('<block>yes</block><reason>force</reason>')
    expect(await classify({ ...base, action, twoStageMode: 'fast' }, fast)).toEqual({
      block: true,
      reason: 'force',
      stage: 'fast'
    })
    expect(reqs(fast)[0].user).toContain('Respond with `<block>yes</block>` or `<block>no</block>`')
    expect(reqs(fast)[0].stopSequences).toBeUndefined()
  })

  it('stage 2 carries the ADR-083 block condition', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>70')
      .mockResolvedValueOnce('<block>no</block>')
    await classify({ ...base, twoStageMode: 'both' }, judge)
    const [, s2] = reqs(judge)
    expect(s2.user).toContain(
      'Block when (a) the action matches the TEXT of a specific HARD or SOFT rule'
    )
    expect(s2.user).toContain('or (b) it crosses an explicit boundary the user set')
    expect(s2.user).toContain('if you cannot name the rule, the action matches none')
    expect(s2.user).toContain('through a user allow rule whose pattern names it')
  })

  it('both mode: stage 1 grades HARM ONLY and defers intent/exceptions to stage 2', async () => {
    // The G1 fix is a division of labour: stage 1 must not be asked the same
    // question as stage 2, or the cheap pass has to be as smart as the
    // expensive one. It is also NOT told its block merely escalates.
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>80')
      .mockResolvedValueOnce('<block>no</block>')
    await classify({ ...base, twoStageMode: 'both' }, judge)
    const [s1, s2] = reqs(judge)
    expect(s1.user).toMatch(/does NOT apply user intent or ALLOW exceptions/i)
    expect(s1.user).toContain('Intent only ever RAISES a grade here')
    expect(s1.user).toMatch(/full effect/i)
    expect(s1.user).not.toMatch(/escalat/i)
    expect(s2.user).toMatch(/apply user intent/i)
    // Same system prompt, different instruction — the stages differ only in job.
    expect(s1.system).toBe(s2.system)
  })

  it('both mode: a stage-1 escalation lets a stage-2 ALLOW WIN', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>90</severity>')
      .mockResolvedValueOnce('<thinking>the user named the branch</thinking><block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'thinking', severity: 90 })
    expect(judge).toHaveBeenCalledTimes(2)
    // Stage 1 cannot emit a final block in `both` mode: its budget/stop
    // sequence prove it only ever produced a grade.
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
      .mockResolvedValueOnce('<severity>90')
      .mockResolvedValueOnce('<block>yes</block><reason>force-push to main</reason>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, stage: 'thinking', reason: 'force-push to main' })
    expect(r.unavailable).toBeUndefined()
  })

  it('both mode: a stage-2 category flows through to the result', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>90')
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
      .mockResolvedValueOnce('<severity>90')
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
      .mockResolvedValueOnce('<severity>90')
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
    const judge = vi.fn().mockResolvedValueOnce('<severity>90').mockResolvedValueOnce('¯\\_(ツ)_/¯')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r.block).toBe(true)
    expect(r.stage).toBe('thinking')
    expect(r.unavailable).toBeUndefined()
    expect(r.reason).toBe(UNPARSEABLE_REASON)
    expect(r.raw).toBe('¯\\_(ツ)_/¯')
  })

  it('carries the raw completion ONLY on an unparseable verdict', async () => {
    // Production shape: a native-reasoning judge burns the whole budget inside
    // <thinking> and the reply is cut off before the verdict.
    const truncated = '<thinking>weighing the rules and the user’s consent, so far'
    const judge = vi.fn().mockResolvedValue(truncated)
    const unreadable = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(unreadable).toMatchObject({
      block: true,
      stage: 'thinking',
      reason: UNPARSEABLE_REASON,
      raw: truncated
    })

    // A verdict we CAN read never carries it — `raw` is the diagnostic channel
    // for the unreadable case, not a transcript of every judge call.
    const readable = await classify(
      { ...base, twoStageMode: 'thinking' },
      vi.fn().mockResolvedValue('<thinking>fine</thinking><block>no</block>')
    )
    expect(readable.raw).toBeUndefined()

    // Nor does a transport error: there is no completion to report.
    const errored = await classify(
      { ...base, twoStageMode: 'thinking' },
      vi.fn().mockRejectedValue(new Error('judge down'))
    )
    expect(errored.raw).toBeUndefined()
  })

  it('transport throws at STAGE 1 → block + unavailable, no escalation, with the thrown message on `error`', async () => {
    const judge = vi.fn().mockRejectedValue(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
    // The CAUSE has to survive: engine wiring logs it, and a bare
    // `stage=error` line is undiagnosable (that is how the pi 0.84.3
    // new_session model reset stayed invisible).
    expect(r.error).toContain('judge down')
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('transport throws at STAGE 2 → block + unavailable (our documented deviation)', async () => {
    // cli.js turns this into a hard block "based on stage 1"; we mark it
    // unavailable, and the wiring maps unavailable → ask the human.
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>90')
      .mockRejectedValueOnce(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
    expect(r.error).toContain('judge down')
    expect(judge).toHaveBeenCalledTimes(2)
  })

  it('transport throws in thinking mode → block + unavailable', async () => {
    const judge = vi.fn().mockRejectedValue(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'thinking' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
  })

  it('defaults to both mode', async () => {
    const judge = vi.fn().mockResolvedValue('<severity>0')
    await classify(base, judge)
    expect(reqs(judge)[0].maxTokens).toBe(STAGE1_BOTH_MAX_TOKENS)
  })

  it('tells the transport which stage is asking, and hands each call its own signal', async () => {
    // The HTTP transport (ADR-081) picks per-stage reasoning settings from
    // `stage`; `signal` is what a stage timeout aborts.
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<severity>90')
      .mockResolvedValueOnce('<block>no</block>')
    await classify({ ...base, twoStageMode: 'both' }, judge)
    const [s1, s2] = reqs(judge)
    expect(s1.stage).toBe('fast')
    expect(s2.stage).toBe('thinking')
    expect(s1.signal).toBeInstanceOf(AbortSignal)
    expect(s2.signal).toBeInstanceOf(AbortSignal)
    expect(s1.signal).not.toBe(s2.signal)
    // A call that answered in time is never aborted.
    expect(s1.signal?.aborted).toBe(false)
    expect(s2.signal?.aborted).toBe(false)

    const fast = vi.fn().mockResolvedValue('<block>no</block>')
    await classify({ ...base, twoStageMode: 'fast' }, fast)
    expect(reqs(fast)[0].stage).toBe('fast')

    const thinking = vi.fn().mockResolvedValue('<block>no</block>')
    await classify({ ...base, twoStageMode: 'thinking' }, thinking)
    expect(reqs(thinking)[0].stage).toBe('thinking')
  })
})

// ---------------------------------------------------------------------------
// Stage-bounded judge timeouts (cli.js parity, ref §2 `ain`/`lin`). A judge that
// never answers must degrade into the SAME `unavailable` state as one that
// threw — otherwise the gated tool call parks forever behind a spinner with no
// approval card. Observed live with GLM-5.2 (plan §7 Q6): >5 minute hangs.
// ---------------------------------------------------------------------------

describe('classify — stage timeouts', () => {
  const base: ClassifyInput = {
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    action: { toolName: 'bash', input: { command: 'ls' } },
    environment: { cwd: '/repo' }
  }
  /** A transport that never settles — the wedged-judge shape. */
  const hang = (): Promise<string> => new Promise<string>(() => {})

  it('cli.js parity: 60 s stage 1, 120 s stage 2', () => {
    expect(STAGE1_TIMEOUT_MS).toBe(60_000)
    expect(STAGE2_TIMEOUT_MS).toBe(120_000)
  })

  it('stage 1 exceeds its budget → unavailable, and stage 2 is never attempted', async () => {
    vi.useFakeTimers()
    try {
      const judge = vi.fn(hang)
      const p = classify({ ...base, twoStageMode: 'both' }, judge)
      // One tick short of the budget the judge is still considered in flight.
      await vi.advanceTimersByTimeAsync(STAGE1_TIMEOUT_MS - 1)
      let settled = false
      void p.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(await p).toEqual({
        block: true,
        stage: 'error',
        unavailable: true,
        error: `auto-mode judge timed out after ${STAGE1_TIMEOUT_MS} ms`
      })
      // A timeout is a transport failure, not a stage-1 verdict: escalating a
      // wedged stage 1 to stage 2 would double the wait before the human is asked.
      expect(judge).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stage 2 gets its OWN 120 s clock after a stage-1 escalation', async () => {
    vi.useFakeTimers()
    try {
      const judge = vi.fn().mockResolvedValueOnce('<severity>90').mockImplementation(hang)
      const p = classify({ ...base, twoStageMode: 'both' }, judge)
      // Stage 1 answered instantly; stage 2 is now hanging. Stage 1's budget
      // must NOT be what bounds it.
      await vi.advanceTimersByTimeAsync(STAGE1_TIMEOUT_MS)
      let settled = false
      void p.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(STAGE2_TIMEOUT_MS - STAGE1_TIMEOUT_MS)
      expect(await p).toEqual({
        block: true,
        stage: 'error',
        unavailable: true,
        error: `auto-mode judge timed out after ${STAGE2_TIMEOUT_MS} ms`,
        // The stage-1 grade survives a stage-2 failure: it is the only
        // judgement the log line can report.
        severity: 90
      })
      expect(judge).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stage timeout ABORTS the request signal — and only once the budget is spent', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const judge = vi.fn((req: JudgeRequest) => {
        if (req.signal) signals.push(req.signal)
        return hang()
      })
      const p = classify({ ...base, twoStageMode: 'fast' }, judge)
      await vi.advanceTimersByTimeAsync(STAGE1_TIMEOUT_MS - 1)
      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(signals[0].aborted).toBe(true)
      // The timeout message still wins over whatever the aborted transport says.
      expect((await p).error).toBe(`auto-mode judge timed out after ${STAGE1_TIMEOUT_MS} ms`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an escalated stage 2 that times out aborts ITS signal, not the stage-1 one', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const judge = vi.fn((req: JudgeRequest) => {
        if (req.signal) signals.push(req.signal)
        return signals.length === 1 ? Promise.resolve('<severity>90') : hang()
      })
      const p = classify({ ...base, twoStageMode: 'both' }, judge)
      await vi.advanceTimersByTimeAsync(STAGE2_TIMEOUT_MS)
      expect(await p).toMatchObject({
        unavailable: true,
        error: `auto-mode judge timed out after ${STAGE2_TIMEOUT_MS} ms`
      })
      expect(signals).toHaveLength(2)
      expect(signals[0].aborted).toBe(false)
      expect(signals[1].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a transport that rejects on abort cannot replace the timeout error', async () => {
    // The shape the HTTP transport has: aborting its signal makes it reject
    // straight away with its own message.
    vi.useFakeTimers()
    try {
      const judge = vi.fn(
        (req: JudgeRequest) =>
          new Promise<string>((_resolve, reject) => {
            req.signal?.addEventListener('abort', () =>
              reject(new Error('auto-mode judge aborted'))
            )
          })
      )
      const p = classify({ ...base, twoStageMode: 'thinking' }, judge)
      await vi.advanceTimersByTimeAsync(STAGE2_TIMEOUT_MS)
      expect(await p).toEqual({
        block: true,
        stage: 'error',
        unavailable: true,
        error: `auto-mode judge timed out after ${STAGE2_TIMEOUT_MS} ms`
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a judge that answers promptly is untouched by the timeout wrapper', async () => {
    vi.useFakeTimers()
    try {
      const judge = vi.fn().mockResolvedValue('<block>no</block>')
      // No timer advance at all — a fast reply must not need one.
      expect(await classify({ ...base, twoStageMode: 'fast' }, judge)).toMatchObject({
        block: false,
        stage: 'fast'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a LATE transport rejection after a timeout is not an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    let rejectLate: (err: unknown) => void = () => {}
    try {
      vi.useFakeTimers()
      const judge = vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectLate = reject
          })
      )
      const p = classify({ ...base, twoStageMode: 'fast' }, judge)
      await vi.advanceTimersByTimeAsync(STAGE1_TIMEOUT_MS)
      expect(await p).toMatchObject({ unavailable: true })
      vi.useRealTimers()

      // The wedged transport finally dies, long after classify() gave up. The
      // rejection must land on the handler withTimeout attached, not on the
      // process (which in Electron main is a crash risk, not a log line).
      rejectLate(new Error('transport died late'))
      // Node reports unhandled rejections on a later macrotask turn.
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      expect(unhandled).toEqual([])
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('formatUnparseableJudgeReply', () => {
  it('reports the stage and the FULL length, but keeps only the tail', () => {
    const raw = `${'x'.repeat(UNPARSEABLE_RAW_TAIL_CHARS * 2)}<thinking>cut off here`
    const line = formatUnparseableJudgeReply({
      block: true,
      stage: 'thinking',
      reason: UNPARSEABLE_REASON,
      raw
    })
    expect(line).toContain('stage=thinking')
    expect(line).toContain(`${raw.length} chars`)
    // The tail is what shows WHERE a truncated reply stopped; the head carries
    // no signal and must not bloat the log.
    expect(line).toContain('<thinking>cut off here')
    expect(line).not.toContain('x'.repeat(UNPARSEABLE_RAW_TAIL_CHARS + 1))
  })

  it('keeps a short reply whole', () => {
    const line = formatUnparseableJudgeReply({
      block: true,
      stage: 'fast',
      reason: UNPARSEABLE_REASON,
      raw: 'I cannot help with that.'
    })
    expect(line).toContain('stage=fast')
    expect(line).toContain('24 chars')
    expect(line).toContain(': I cannot help with that.')
  })
})

describe('formatVerdictLine', () => {
  it('names the verdict, stage, grade and rule, then the subject and reason', () => {
    expect(
      formatVerdictLine(
        {
          block: true,
          stage: 'thinking',
          severity: 70,
          category: 'git_destructive',
          reason: '[Git Destructive] x'
        },
        'bash'
      )
    ).toBe(
      'auto-mode BLOCK (stage=thinking, sev=70, rule=git_destructive) bash — [Git Destructive] x'
    )
  })

  it('omits the facets a verdict does not carry', () => {
    expect(formatVerdictLine({ block: false, stage: 'fast', severity: 4 }, 'bash')).toBe(
      'auto-mode allow (stage=fast, sev=4) bash'
    )
    // A full-review shape never ran stage 1: no grade to report.
    expect(formatVerdictLine({ block: false, stage: 'thinking' }, 'bash')).toBe(
      'auto-mode allow (stage=thinking) bash'
    )
  })
})
