/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { computeTokenMetrics } from '../session-history'

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
