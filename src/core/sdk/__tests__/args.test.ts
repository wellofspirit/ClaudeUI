/**
 * `--forward-subagent-text` on every spawn.
 *
 * Without it, Anthropic's unpatched binary forwards only a foreground
 * subagent's tool_use/tool_result blocks: its text and thinking never reach the
 * app. The flag hard-errors unless the session is non-interactive and
 * `--output-format` is `stream-json` ("Error: --forward-subagent-text requires
 * --print and --output-format=stream-json."), so the output format is pinned
 * here too.
 */
import { describe, it, expect } from 'vitest'
import { buildArgs } from '../args'
import type { QueryOptions } from '../types'

const flagCount = (args: string[]): number =>
  args.filter((a) => a === '--forward-subagent-text').length

describe('buildArgs — --forward-subagent-text', () => {
  it('is passed exactly once with no options at all', () => {
    expect(flagCount(buildArgs({} as QueryOptions))).toBe(1)
  })

  it('is passed exactly once alongside the options a Claude session uses', () => {
    const args = buildArgs({
      model: 'claude-haiku-4-5-20251001',
      includePartialMessages: true,
      includeHookEvents: true,
      thinking: { type: 'adaptive' },
      resume: 'sess-1'
    } as QueryOptions)
    expect(flagCount(args)).toBe(1)
  })

  it('rides with stream-json output, which its upstream precondition needs', () => {
    const args = buildArgs({} as QueryOptions)
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
  })
})
