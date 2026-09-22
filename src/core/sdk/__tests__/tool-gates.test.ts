/**
 * The spawn flags and env that decide which TOOLS cli.js offers.
 *
 * Two gates in 2.1.268 are invisible until a card stops appearing, so both are
 * pinned here (probed against the real binary's `system/init` on 2026-09-18,
 * recorded in docs/tool-survey.md § 7):
 *
 *  1. `TodoWrite.isEnabled` is `!z_() && mL()` and the TaskCreate family is
 *     `z_() && mL()`, where `z_()` is "the Tasks system is on" (default true).
 *     With `CLAUDE_CODE_ENABLE_TODO_TOOLS` unset, NEITHER is offered and the
 *     session has no checklist tool at all.
 *  2. `AskUserQuestion` and `ExitPlanMode` share `cCe()`, which needs a
 *     permission-prompt tool whenever the session is non-interactive. Drop
 *     `--permission-prompt-tool` and plan mode loses its exit tool silently.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildEnv, buildArgs } from '../args'

describe('the checklist tools', () => {
  it('asks for the task tools, so the session has a checklist at all', () => {
    const env = buildEnv({})
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('true')
  })

  it("leaves the user's own choice alone, including an explicit opt-out", () => {
    expect(buildEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: 'false' }).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe(
      'false'
    )
    expect(buildEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
  })
})

describe('the plan-mode and question gate', () => {
  it('passes a permission-prompt tool whenever a canUseTool callback is set', () => {
    const args = buildArgs({ canUseTool: vi.fn() } as never)
    const at = args.indexOf('--permission-prompt-tool')
    expect(at, 'without this flag ExitPlanMode and AskUserQuestion are disabled').toBeGreaterThan(
      -1
    )
    expect(args[at + 1]).toBe('stdio')
  })

  it('passes the caller-named tool when one is given instead', () => {
    const args = buildArgs({ permissionPromptToolName: 'mcp__x__ask' } as never)
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__x__ask')
  })

  it('refuses both at once rather than letting one silently win', () => {
    expect(() =>
      buildArgs({ canUseTool: vi.fn(), permissionPromptToolName: 'mcp__x__ask' } as never)
    ).toThrow(/cannot be used with/)
  })
})
