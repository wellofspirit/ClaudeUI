/**
 * The four phrasings of Claude Code's backgrounded-Bash tool_result (2.1.280
 * `mEn`). The manual and run_in_background texts are the official binary's own
 * (probes/background-task/official.main.jsonl:121 and a run_in_background probe),
 * with the absolute output path replaced; the other two follow the template.
 */
import { describe, it, expect } from 'vitest'
import { backgroundBashOutputFile, backgroundBashTaskId } from '../claude-background-bash'

const PATH = String.raw`C:\Temp\claude\proj\68347dff\tasks\bvup3m1hz.output`

const MANUAL = `Command was manually backgrounded by user with ID: bvup3m1hz. Output is being written to: ${PATH}.`
const RUN_IN_BACKGROUND = `Command running in background with ID: bvup3m1hz. Output is being written to: ${PATH}. You will be notified when it completes. To check interim output, use Read on that file path.`
const MESSAGE = `Command was moved to the background (ID: bvup3m1hz) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: ${PATH}. You will be notified when it completes. To check interim output, use Read on that file path.`
const TIMEOUT = `Command did not complete within its 120s timeout and was moved to the background (ID: bvup3m1hz). Output is being written to: ${PATH}. You will be notified when it completes. To check interim output, use Read on that file path.`

describe('backgroundBashTaskId / backgroundBashOutputFile', () => {
  it.each([
    ['a manual "Send to background"', MANUAL],
    ['run_in_background', RUN_IN_BACKGROUND],
    ['a message that arrived', MESSAGE],
    ['a timeout', TIMEOUT]
  ])('reads the id and the whole path for %s', (_, text) => {
    expect(backgroundBashTaskId(text)).toBe('bvup3m1hz')
    expect(backgroundBashOutputFile(text)).toBe(PATH)
  })

  it('reads the sentence after the output the command printed first', () => {
    const text = `building…\nwarning: slow\n${MANUAL}`
    expect(backgroundBashTaskId(text)).toBe('bvup3m1hz')
    expect(backgroundBashOutputFile(text)).toBe(PATH)
  })

  it('keeps a path whose directories hold spaces and dots', () => {
    const path = '/Users/Jane Q. Doe/tmp/claude/tasks/b1.output'
    const text = `Command running in background with ID: b1. Output is being written to: ${path}. You will be notified when it completes.`
    expect(backgroundBashOutputFile(text)).toBe(path)
  })

  it('does not take a command that prints the phrase for a backgrounded one', () => {
    const grep = `src/x.test.ts:12:  'Command was manually backgrounded by user with ID: bvup3m1hz. Output is being written to: /tmp/x.output'`
    expect(backgroundBashTaskId(grep)).toBeUndefined()
    expect(backgroundBashTaskId('total 0\n')).toBeUndefined()
  })
})
