/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  computeTokenMetrics,
  computeTurnSpanDurationMs,
  createTurnSpanAccumulator,
  loadBackgroundOutput
} from '../../../core/services/session-history'

// ---------------------------------------------------------------------------
// Replicate private parser functions from session-history.ts for testing
// ---------------------------------------------------------------------------

interface TaskNotification {
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  summary: string
  usage?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
}

function parseTaskNotificationXml(
  text: string
): Omit<TaskNotification, 'toolUseId' | 'outputFile'> | null {
  const match = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)
  if (!match) return null

  const xml = match[1]
  const get = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }

  const taskId = get('task-id')
  const status = get('status') as 'completed' | 'failed' | 'stopped'
  const summary = get('summary')

  const usageStr = get('usage')
  let usage: TaskNotification['usage'] | undefined
  if (usageStr) {
    const getNum = (key: string): number => {
      const m = usageStr.match(new RegExp(`${key}:\\s*(\\d+)`))
      return m ? Number(m[1]) : 0
    }
    usage = {
      totalTokens: getNum('total_tokens'),
      toolUses: getNum('tool_uses'),
      durationMs: getNum('duration_ms')
    }
  }

  if (!taskId || !status) return null
  return { taskId, status, summary, usage }
}

function parseCliCommand(
  text: string
): { commandName: string; commandArgs?: string; commandOutput?: string } | null {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (nameMatch) {
    const commandName = nameMatch[1].trim()
    const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    return {
      commandName,
      commandArgs: argsMatch ? argsMatch[1].trim() : undefined
    }
  }
  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
  const stderrMatch = text.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/)
  if (stdoutMatch || stderrMatch) {
    const output =
      (stdoutMatch?.[1] || '') + (stderrMatch ? (stdoutMatch ? '\n' : '') + stderrMatch[1] : '')
    return {
      commandName: 'output',
      commandOutput: output.trim() || undefined
    }
  }
  if (text.includes('<local-command-caveat>')) return null
  return null
}

function extractOutputFile(text: string): string {
  const m = text.match(/<output-file>([\s\S]*?)<\/output-file>/)
  return m ? m[1].trim() : ''
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseTaskNotificationXml', () => {
  it('parses a complete task notification', () => {
    const text = `<task-notification>
<task-id>agent-123</task-id>
<status>completed</status>
<summary>Task finished successfully</summary>
<usage>total_tokens: 5000, tool_uses: 3, duration_ms: 12000</usage>
</task-notification>`

    const result = parseTaskNotificationXml(text)
    expect(result).not.toBeNull()
    expect(result!.taskId).toBe('agent-123')
    expect(result!.status).toBe('completed')
    expect(result!.summary).toBe('Task finished successfully')
    expect(result!.usage).toEqual({
      totalTokens: 5000,
      toolUses: 3,
      durationMs: 12000
    })
  })

  it('parses notification without usage', () => {
    const text = `<task-notification>
<task-id>agent-456</task-id>
<status>failed</status>
<summary>Something went wrong</summary>
</task-notification>`

    const result = parseTaskNotificationXml(text)
    expect(result).not.toBeNull()
    expect(result!.taskId).toBe('agent-456')
    expect(result!.status).toBe('failed')
    expect(result!.usage).toBeUndefined()
  })

  it('returns null for text without task-notification', () => {
    expect(parseTaskNotificationXml('Just regular text')).toBeNull()
  })

  it('returns null when taskId is missing', () => {
    const text = `<task-notification>
<status>completed</status>
<summary>No task ID</summary>
</task-notification>`

    expect(parseTaskNotificationXml(text)).toBeNull()
  })

  it('returns null when status is missing', () => {
    const text = `<task-notification>
<task-id>agent-789</task-id>
<summary>No status</summary>
</task-notification>`

    expect(parseTaskNotificationXml(text)).toBeNull()
  })

  it('handles stopped status', () => {
    const text = `<task-notification>
<task-id>agent-stop</task-id>
<status>stopped</status>
<summary>User stopped the task</summary>
</task-notification>`

    const result = parseTaskNotificationXml(text)
    expect(result!.status).toBe('stopped')
  })

  it('handles embedded XML in surrounding text', () => {
    const text = `Some prefix text <task-notification>
<task-id>embedded</task-id>
<status>completed</status>
<summary>Found in middle</summary>
</task-notification> and some suffix`

    const result = parseTaskNotificationXml(text)
    expect(result).not.toBeNull()
    expect(result!.taskId).toBe('embedded')
  })

  it('handles multiline summary', () => {
    const text = `<task-notification>
<task-id>multi</task-id>
<status>completed</status>
<summary>Line 1
Line 2
Line 3</summary>
</task-notification>`

    const result = parseTaskNotificationXml(text)
    expect(result!.summary).toContain('Line 1')
    expect(result!.summary).toContain('Line 3')
  })
})

describe('parseCliCommand', () => {
  it('parses command-name format', () => {
    const text = `<command-name>commit</command-name><command-message>Creating commit</command-message><command-args>-m "fix bug"</command-args>`

    const result = parseCliCommand(text)
    expect(result).not.toBeNull()
    expect(result!.commandName).toBe('commit')
    expect(result!.commandArgs).toBe('-m "fix bug"')
  })

  it('parses command without args', () => {
    const text = `<command-name>status</command-name><command-message>Checking status</command-message>`

    const result = parseCliCommand(text)
    expect(result!.commandName).toBe('status')
    expect(result!.commandArgs).toBeUndefined()
  })

  it('parses local-command-stdout format', () => {
    const text = `<local-command-stdout>file1.ts
file2.ts</local-command-stdout>`

    const result = parseCliCommand(text)
    expect(result!.commandName).toBe('output')
    expect(result!.commandOutput).toBe('file1.ts\nfile2.ts')
  })

  it('parses local-command-stderr', () => {
    const text = `<local-command-stderr>Warning: deprecated</local-command-stderr>`

    const result = parseCliCommand(text)
    expect(result!.commandName).toBe('output')
    expect(result!.commandOutput).toBe('Warning: deprecated')
  })

  it('combines stdout and stderr', () => {
    const text = `<local-command-stdout>output here</local-command-stdout><local-command-stderr>error here</local-command-stderr>`

    const result = parseCliCommand(text)
    expect(result!.commandOutput).toBe('output here\nerror here')
  })

  it('returns null for local-command-caveat', () => {
    const text = `<local-command-caveat>Some caveat text</local-command-caveat>`
    expect(parseCliCommand(text)).toBeNull()
  })

  it('returns null for unrecognized format', () => {
    expect(parseCliCommand('Just regular text')).toBeNull()
  })

  it('handles empty stdout', () => {
    const text = `<local-command-stdout></local-command-stdout>`
    const result = parseCliCommand(text)
    expect(result!.commandName).toBe('output')
    expect(result!.commandOutput).toBeUndefined()
  })
})

describe('extractOutputFile', () => {
  it('extracts output file path', () => {
    const text = `<output-file>/tmp/output.txt</output-file>`
    expect(extractOutputFile(text)).toBe('/tmp/output.txt')
  })

  it('trims whitespace', () => {
    const text = `<output-file>  /tmp/output.txt  </output-file>`
    expect(extractOutputFile(text)).toBe('/tmp/output.txt')
  })

  it('returns empty string when not found', () => {
    expect(extractOutputFile('no output file here')).toBe('')
  })

  it('extracts from within larger text', () => {
    const text = `prefix <output-file>/path/to/file</output-file> suffix`
    expect(extractOutputFile(text)).toBe('/path/to/file')
  })
})

describe('computeTokenMetrics — context window from transcript model', () => {
  let seq = 0
  function writeTranscript(lines: object[]): string {
    const file = path.join(os.tmpdir(), `claudeui-history-${process.pid}-${seq++}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
    return file
  }
  function assistant(model: string, contextLen: number): object {
    return {
      type: 'assistant',
      message: { model, usage: { input_tokens: contextLen, output_tokens: 0 } }
    }
  }

  it('sizes the window from the transcript model, ignoring the caller alias', async () => {
    // A 1M-context model used 300k tokens → 30%. The caller passes the
    // ambiguous "default" alias, which alone would resolve to 200K (→ 150%).
    const file = writeTranscript([assistant('claude-opus-4-8', 300_000)])
    const m = await computeTokenMetrics(file, 'default')
    fs.unlinkSync(file)
    expect(m.usedPercentage).toBe(30)
  })

  it('falls back to the caller model when the transcript has no model', async () => {
    const file = writeTranscript([
      { type: 'assistant', message: { usage: { input_tokens: 100_000, output_tokens: 0 } } }
    ])
    const m = await computeTokenMetrics(file, 'opus')
    fs.unlinkSync(file)
    expect(m.usedPercentage).toBe(10) // 100k / 1M
  })

  it('keeps a 200K model at its true window', async () => {
    const file = writeTranscript([assistant('claude-sonnet-4-6', 100_000)])
    const m = await computeTokenMetrics(file, 'default')
    fs.unlinkSync(file)
    expect(m.usedPercentage).toBe(50) // 100k / 200k
  })
})

// ---------------------------------------------------------------------------
// computeTurnSpanDurationMs — active-turn duration reconstruction.
//
// Guard: real Claude transcripts carry NO `type: "result"` lines (verified
// across 46 real transcripts), so the pre-fix implementation — which only
// summed duration_ms off result lines — always returned 0 for every real
// session. These tests exercise the turn-span reconstruction that replaces it.
// ---------------------------------------------------------------------------

describe('computeTurnSpanDurationMs', () => {
  function userLine(
    ts: string,
    opts: { isMeta?: boolean; toolUseResult?: boolean } = {}
  ): Record<string, unknown> {
    return {
      type: 'user',
      timestamp: ts,
      ...(opts.isMeta ? { isMeta: true } : {}),
      ...(opts.toolUseResult ? { toolUseResult: { some: 'result' } } : {})
    }
  }
  function assistantLine(ts?: string): Record<string, unknown> {
    return { type: 'assistant', ...(ts ? { timestamp: ts } : {}), message: { content: [] } }
  }

  it('returns 0 for an empty transcript', () => {
    expect(computeTurnSpanDurationMs([])).toBe(0)
  })

  it('sums multiple turns, each bounded by a real user prompt', () => {
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine('2026-01-01T00:00:05.000Z'), // turn 1 span: 5s
      userLine('2026-01-01T00:01:00.000Z'),
      assistantLine('2026-01-01T00:01:03.000Z') // turn 2 span: 3s
    ]
    expect(computeTurnSpanDurationMs(lines)).toBe(8000)
  })

  it('treats tool-result user lines as part of the in-flight turn, not new boundaries', () => {
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine('2026-01-01T00:00:02.000Z'),
      userLine('2026-01-01T00:00:03.000Z', { toolUseResult: true }), // NOT a boundary
      assistantLine('2026-01-01T00:00:10.000Z')
    ]
    // If the tool-result line were (wrongly) treated as a new turn boundary,
    // this would split into two short spans instead of one 10s span.
    expect(computeTurnSpanDurationMs(lines)).toBe(10000)
  })

  it('treats isMeta user lines as part of the in-flight turn, not new boundaries', () => {
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      userLine('2026-01-01T00:00:01.000Z', { isMeta: true }), // NOT a boundary
      assistantLine('2026-01-01T00:00:06.000Z')
    ]
    expect(computeTurnSpanDurationMs(lines)).toBe(6000)
  })

  it('includes the trailing turn (no following user prompt) through EOF', () => {
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine('2026-01-01T00:00:04.000Z')
    ]
    expect(computeTurnSpanDurationMs(lines)).toBe(4000)
  })

  it('skips lines with a missing/unparseable timestamp without breaking the turn', () => {
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine(undefined), // no timestamp at all
      { type: 'assistant', timestamp: 'not-a-date', message: { content: [] } }, // unparseable
      assistantLine('2026-01-01T00:00:07.000Z')
    ]
    expect(computeTurnSpanDurationMs(lines)).toBe(7000)
  })

  it('clamps a negative span (out-of-order timestamps) to 0 rather than going negative', () => {
    const lines = [
      userLine('2026-01-01T00:00:10.000Z'),
      assistantLine('2026-01-01T00:00:05.000Z') // earlier than the prompt itself
    ]
    expect(computeTurnSpanDurationMs(lines)).toBe(0)
  })

  it('incremental accumulator push-per-line equals the batch result', () => {
    // Mixed sequence exercising every state transition: multi-turn, tool-result
    // and isMeta lines mid-turn, missing timestamps, trailing turn.
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine('2026-01-01T00:00:02.000Z'),
      userLine('2026-01-01T00:00:03.000Z', { toolUseResult: true }),
      assistantLine(undefined),
      assistantLine('2026-01-01T00:00:10.000Z'),
      userLine('2026-01-01T00:01:00.000Z'),
      userLine('2026-01-01T00:01:01.000Z', { isMeta: true }),
      assistantLine('2026-01-01T00:01:04.000Z') // trailing turn
    ]
    const acc = createTurnSpanAccumulator()
    for (const line of lines) acc.push(line)
    expect(acc.total()).toBe(computeTurnSpanDurationMs(lines))
    expect(acc.total()).toBe(14000) // 10s (turn 1) + 4s (trailing turn 2)
  })

  it('accumulator total() is a non-destructive read — a later push still extends the open turn', () => {
    const acc = createTurnSpanAccumulator()
    acc.push(userLine('2026-01-01T00:00:00.000Z'))
    acc.push(assistantLine('2026-01-01T00:00:03.000Z'))
    expect(acc.total()).toBe(3000)
    acc.push(assistantLine('2026-01-01T00:00:08.000Z'))
    expect(acc.total()).toBe(8000)
  })
})

describe('computeTokenMetrics — duration reconstruction from turn spans', () => {
  let seq = 0
  function writeTranscript(lines: object[]): string {
    const file = path.join(os.tmpdir(), `claudeui-history-dur-${process.pid}-${seq++}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
    return file
  }

  it('reconstructs totalDurationMs from turn spans, not from (absent) result lines', async () => {
    const file = writeTranscript([
      { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', message: { content: [] } }
    ])
    const m = await computeTokenMetrics(file)
    fs.unlinkSync(file)
    expect(m.totalDurationMs).toBe(5000)
  })
})

// ---------------------------------------------------------------------------
// computeTokenMetrics — modelCosts (Slice B: per-model session cost breakdown,
// recomputed from pricing-table math since real transcripts carry no cost).
// ---------------------------------------------------------------------------

describe('computeTokenMetrics — modelCosts (Slice B)', () => {
  let seq = 0
  function writeTranscript(lines: object[]): string {
    const file = path.join(os.tmpdir(), `claudeui-history-cost-${process.pid}-${seq++}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
    return file
  }
  function assistantMsg(
    id: string,
    model: string,
    usage: { input_tokens: number; output_tokens: number }
  ): object {
    return { type: 'assistant', message: { id, model, usage } }
  }

  it('computes per-model cost using pricing-table math and sums to totalCostUsd', async () => {
    const file = writeTranscript([
      // sonnet: $3/MTok input → 1M input tokens = $3
      assistantMsg('msg_1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 }),
      // opus-4-8: $5/MTok input → 1M input tokens = $5
      assistantMsg('msg_2', 'claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0 })
    ])
    const m = await computeTokenMetrics(file)
    fs.unlinkSync(file)

    expect(m.modelCosts).toBeDefined()
    const sonnet = m.modelCosts!.find((e) => e.modelId === 'claude-sonnet-4-6')
    const opus = m.modelCosts!.find((e) => e.modelId === 'claude-opus-4-8')
    expect(sonnet).toEqual({ engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 3 })
    expect(opus).toEqual({ engineId: 'claude', modelId: 'claude-opus-4-8', costUsd: 5 })
    expect(m.totalCostUsd).toBeCloseTo(8, 6)
  })

  it('dedupes repeated lines sharing the same message id (partial-update writes)', async () => {
    const file = writeTranscript([
      assistantMsg('msg_1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 }),
      // Same message id re-emitted (e.g. a partial update also persisted) —
      // must be counted once, not twice, for the cost breakdown.
      assistantMsg('msg_1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 })
    ])
    const m = await computeTokenMetrics(file)
    fs.unlinkSync(file)

    const sonnet = m.modelCosts!.find((e) => e.modelId === 'claude-sonnet-4-6')
    expect(sonnet?.costUsd).toBeCloseTo(3, 6) // NOT 6
    expect(m.totalCostUsd).toBeCloseTo(3, 6)
  })

  it('omits synthetic/unknown models from the breakdown', async () => {
    const file = writeTranscript([
      { type: 'assistant', message: { id: 'msg_1', model: '<synthetic>', usage: { input_tokens: 100, output_tokens: 0 } } }
    ])
    const m = await computeTokenMetrics(file)
    fs.unlinkSync(file)
    expect(m.modelCosts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// computeTokenMetrics — subagent transcripts fold into modelCosts.
//
// Task-tool subagent transcripts live in SEPARATE files
// (<projectDir>/<sessionId>/subagents/agent-<id>.jsonl), not lines in the
// main transcript. Guard: against the pre-fix implementation (main-file-only
// scan), the multi-model fixture below fails because the subagent-only
// model (opus, never mentioned in the main file) is entirely absent from
// modelCosts.
// ---------------------------------------------------------------------------

describe('computeTokenMetrics — subagent transcripts fold into modelCosts', () => {
  let seq = 0
  function writeTranscript(lines: object[]): string {
    const file = path.join(os.tmpdir(), `claudeui-history-subagent-${process.pid}-${seq++}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
    return file
  }
  function assistantMsg(
    id: string,
    model: string,
    usage: { input_tokens: number; output_tokens: number }
  ): object {
    return { type: 'assistant', message: { id, model, usage } }
  }
  // Mirrors production layout: <projectDir>/<sessionId>.jsonl (main file) +
  // <projectDir>/<sessionId>/subagents/agent-<id>.jsonl (subagent files).
  function subagentsDirFor(mainFile: string): string {
    return path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'), 'subagents')
  }
  function writeSubagentFile(mainFile: string, name: string, lines: object[]): void {
    const dir = subagentsDirFor(mainFile)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n'))
  }
  function cleanup(mainFile: string): void {
    fs.unlinkSync(mainFile)
    const sessionDir = path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'))
    fs.rmSync(sessionDir, { recursive: true, force: true })
  }

  it('folds subagent-file spend into modelCosts/totalCostUsd, leaving legacy sums + duration main-file-only', async () => {
    const file = writeTranscript([
      { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        ...assistantMsg('msg_main_1', 'claude-sonnet-4-6', {
          input_tokens: 500_000,
          output_tokens: 0
        }),
        timestamp: '2026-01-01T00:00:05.000Z'
      }
    ])
    writeSubagentFile(file, 'agent-aaa.jsonl', [
      assistantMsg('msg_sub_1', 'claude-opus-4-8', { input_tokens: 200_000, output_tokens: 0 })
    ])
    writeSubagentFile(file, 'agent-bbb.jsonl', [
      assistantMsg('msg_sub_2', 'claude-opus-4-8', { input_tokens: 800_000, output_tokens: 0 }),
      // Same model as the main file — must ADD to the main-file sonnet cost,
      // not replace it.
      assistantMsg('msg_sub_3', 'claude-sonnet-4-6', { input_tokens: 500_000, output_tokens: 0 })
    ])

    const m = await computeTokenMetrics(file)
    cleanup(file)

    const sonnet = m.modelCosts!.find((e) => e.modelId === 'claude-sonnet-4-6')
    const opus = m.modelCosts!.find((e) => e.modelId === 'claude-opus-4-8')
    // sonnet: main (500k → $1.5) + subagent (500k → $1.5) = $3
    expect(sonnet?.costUsd).toBeCloseTo(3, 6)
    // opus: entirely from subagent files (200k + 800k = 1M → $5) — this
    // model is ABSENT from modelCosts pre-fix.
    expect(opus?.costUsd).toBeCloseTo(5, 6)
    expect(m.totalCostUsd).toBeCloseTo(8, 6)

    // Legacy main-chain sums/duration must be untouched by subagent files —
    // these reflect the main transcript only (500k input tokens, one turn).
    expect(m.totalInputTokens).toBe(500_000)
    expect(m.totalOutputTokens).toBe(0)
    expect(m.cachedTokens).toBe(0)
    expect(m.contextWindowSize).toBe(500_000)
    expect(m.totalDurationMs).toBe(5000)
  })

  it('dedupes a message id repeated across two different subagent files', async () => {
    const file = writeTranscript([{ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }])
    writeSubagentFile(file, 'agent-aaa.jsonl', [
      assistantMsg('msg_dup', 'claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0 })
    ])
    writeSubagentFile(file, 'agent-bbb.jsonl', [
      // Same message id re-emitted in a different subagent file — must be
      // counted once, not twice.
      assistantMsg('msg_dup', 'claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0 })
    ])

    const m = await computeTokenMetrics(file)
    cleanup(file)

    const opus = m.modelCosts!.find((e) => e.modelId === 'claude-opus-4-8')
    expect(opus?.costUsd).toBeCloseTo(5, 6) // NOT 10
    expect(m.totalCostUsd).toBeCloseTo(5, 6)
  })

  it('ignores non-matching files in the subagents dir (.meta.json, notes.txt)', async () => {
    const file = writeTranscript([{ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }])
    const dir = subagentsDirFor(file)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent-aaa.meta.json'), JSON.stringify({ some: 'meta' }))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not json at all')
    writeSubagentFile(file, 'agent-aaa.jsonl', [
      assistantMsg('msg_1', 'claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0 })
    ])

    const m = await computeTokenMetrics(file)
    cleanup(file)

    expect(m.modelCosts!.length).toBe(1)
    const opus = m.modelCosts!.find((e) => e.modelId === 'claude-opus-4-8')
    expect(opus?.costUsd).toBeCloseTo(5, 6)
  })

  it('is unaffected when the subagents dir is absent (existing single-file behavior)', async () => {
    const file = writeTranscript([
      assistantMsg('msg_1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 })
    ])
    const m = await computeTokenMetrics(file)
    fs.unlinkSync(file)
    expect(m.modelCosts).toEqual([{ engineId: 'claude', modelId: 'claude-sonnet-4-6', costUsd: 3 }])
  })
})

// ---------------------------------------------------------------------------
// R6 — loadBackgroundOutput path containment (remote-reachable, caller-supplied
// outputFile). Without confinement this channel is an arbitrary-file-read
// primitive (gpt#8). Reads are confined to the OS temp roots.
// ---------------------------------------------------------------------------

describe('loadBackgroundOutput containment (R6)', () => {
  it('reads a legitimate output file inside the temp root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-out-'))
    const file = path.join(dir, 'tabc123.output')
    fs.writeFileSync(file, 'background stdout here')
    try {
      const res = loadBackgroundOutput('proj-key', 'tabc123', file)
      expect(res).toEqual({ content: 'background stdout here', purged: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an outputFile OUTSIDE the temp root (GUARD — fails pre-fix)', () => {
    // A real, existing file well outside any temp root: this test's own repo.
    const forbidden = path.join(process.cwd(), 'package.json')
    expect(fs.existsSync(forbidden)).toBe(true)
    const forbiddenContent = fs.readFileSync(forbidden, 'utf-8')

    const res = loadBackgroundOutput('proj-key', 'tabc123', forbidden)
    // Pre-fix this returned the file's contents (arbitrary read). Now it's
    // rejected → falls through to the (non-existent) interpolated path → purged.
    expect(res.content).not.toBe(forbiddenContent)
    expect(res).toEqual({ content: null, purged: true })
  })

  it('refuses a projectKey that traverses out of the interpolated root', () => {
    // No outputFile → interpolation path; a crafted projectKey must not escape.
    const res = loadBackgroundOutput('../../../../etc', 'passwd', undefined)
    expect(res).toEqual({ content: null, purged: true })
  })
})

describe('computeTokenMetrics — result-line cost is cumulative-per-process (replace, not add)', () => {
  it('takes the LAST result total_cost_usd, not the SUM of all result lines (GUARD — fails pre-fix)', async () => {
    // Real transcripts carry no `result` lines today (this branch is latent),
    // but if they return, total_cost_usd is cumulative-per-process — the last
    // line already contains the running total. `+=` double-counted it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-result-cost-'))
    const file = path.join(dir, 'x.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'result', total_cost_usd: 5 }),
        JSON.stringify({ type: 'result', total_cost_usd: 8 })
      ].join('\n') + '\n',
      'utf-8'
    )
    try {
      const metrics = await computeTokenMetrics(file)
      // Replace semantics → 8 (the last cumulative), NOT 13 (5 + 8).
      expect(metrics.totalCostUsd).toBe(8)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
