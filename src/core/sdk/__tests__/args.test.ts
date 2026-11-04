/**
 * `--forward-subagent-text` on every spawn.
 *
 * Without it, Anthropic's unpatched binary forwards only a foreground
 * subagent's tool_use/tool_result blocks: its text and thinking never reach the
 * app. The flag hard-errors unless the session is non-interactive and
 * `--output-format` is `stream-json` ("Error: --forward-subagent-text requires
 * --print and --output-format=stream-json."), so the output format is pinned
 * here too.
 *
 * The second suite covers `claudeBehaviorSettings` and the `--settings` JSON it
 * rides in (`claude-session.ts` and the dispatcher merge it in).
 */
import { describe, it, expect } from 'vitest'
import { PRIVACY_PLUGIN_ID, buildArgs, claudeBehaviorSettings } from '../args'
import type { QueryOptions } from '../types'

const flagCount = (args: string[]): number =>
  args.filter((a) => a === '--forward-subagent-text').length

/** The `--settings` JSON cli.js receives, parsed. */
const emittedSettings = (args: string[]): Record<string, unknown> => {
  const at = args.lastIndexOf('--settings')
  expect(at).toBeGreaterThanOrEqual(0)
  return JSON.parse(args[at + 1]) as Record<string, unknown>
}

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

/**
 * The two cli.js behaviour switches ClaudeUI owns (engines/claude.json
 * `claudeConfig`): idle compaction OFF unless set, the built-in email-address
 * privacy check ON unless set — both emitted as `--settings` flag settings, so
 * they outrank the user's `~/.claude/settings.json` (which the terminal
 * `claude` shares) without writing to it.
 */
describe('claudeBehaviorSettings — idle compaction and the privacy check', () => {
  it('defaults to compaction OFF and the privacy check ON', () => {
    expect(claudeBehaviorSettings(undefined)).toEqual({
      idleCompaction: false,
      enabledPlugins: { 'cc-plugin-privacy@builtin': true }
    })
  })

  it('honours both configured values', () => {
    expect(claudeBehaviorSettings({ idleCompaction: true, privacyEmailCheck: false })).toEqual({
      idleCompaction: true,
      enabledPlugins: { 'cc-plugin-privacy@builtin': false }
    })
  })

  it('names the plugin the way enabledPlugins does (name@builtin)', () => {
    expect(PRIVACY_PLUGIN_ID).toBe('cc-plugin-privacy@builtin')
  })

  it('reaches cli.js inside the `--settings` JSON, beside the permission rules', () => {
    const args = buildArgs({
      settings: {
        ...claudeBehaviorSettings(undefined),
        permissions: { allow: ['Edit(/p/.claude/ui/**)'] }
      }
    } as QueryOptions)
    expect(emittedSettings(args)).toEqual({
      idleCompaction: false,
      enabledPlugins: { 'cc-plugin-privacy@builtin': true },
      permissions: { allow: ['Edit(/p/.claude/ui/**)'] }
    })
  })

  it('survives the sandbox merge — one settings object, its keys kept', () => {
    const args = buildArgs({
      settings: claudeBehaviorSettings(undefined),
      sandbox: { enabled: true }
    } as QueryOptions)
    expect(emittedSettings(args)).toEqual({
      idleCompaction: false,
      enabledPlugins: { 'cc-plugin-privacy@builtin': true },
      sandbox: { enabled: true, failIfUnavailable: true }
    })
  })

  it('reaches cli.js flipped when the engine config says so', () => {
    const args = buildArgs({
      settings: claudeBehaviorSettings({ idleCompaction: true, privacyEmailCheck: false })
    } as QueryOptions)
    expect(emittedSettings(args)).toEqual({
      idleCompaction: true,
      enabledPlugins: { 'cc-plugin-privacy@builtin': false }
    })
  })
})
