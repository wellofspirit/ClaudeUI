/**
 * The last lines a headless Claude Code process wrote to stderr, for the failure its run
 * reports. cli.js says why it refused to start only there (a required sandbox that cannot run
 * on this machine, ADR-116), and without it a run reports a bare exit code. Shared by a
 * dispatched Claude agent (`dispatch-claude-targets.ts`) and an automation run
 * (`automation-manager.ts`); a session keeps its own stderr handling.
 */
import { logger } from './logger'

/** How much of the process's stderr a failure quotes: its last lines, each cut short. */
const CLAUDE_STDERR_TAIL_LINES = 12
const CLAUDE_STDERR_LINE_CHARS = 400

export interface ClaudeStderrTail {
  /** The `stderr` query option: keep the chunk's lines, and pass each to the tail's `log`. */
  note(chunk: Buffer): void
  /**
   * The error of a run whose process died, with what it last wrote to stderr. `err` itself
   * (the same object, when it is an Error) when nothing was kept. Knows nothing about aborts.
   */
  failure(err: unknown): Error
}

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function claudeStderrTail(log: (line: string) => void): ClaudeStderrTail {
  const lines: string[] = []
  return {
    note: (chunk) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.trim()
        if (!line) continue
        // The voice patch's own chatter, as `ClaudeSession` files it.
        if (line.includes('[Voice:Patch]')) {
          logger.debug('Voice', line)
          continue
        }
        log(line)
        lines.push(line.slice(0, CLAUDE_STDERR_LINE_CHARS))
      }
      if (lines.length > CLAUDE_STDERR_TAIL_LINES)
        lines.splice(0, lines.length - CLAUDE_STDERR_TAIL_LINES)
    },
    failure: (err) => {
      if (lines.length === 0) return err instanceof Error ? err : new Error(text(err))
      return new Error(`${text(err)}\nClaude Code stderr:\n${lines.join('\n')}`)
    }
  }
}
