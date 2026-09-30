/**
 * ADR-085 §4 — the shared engine glue in front of the auto-mode judge for the
 * allow-rule skip. `allow-rule-skip.ts` owns WHICH rule covers what (its own
 * suite); this suite owns the gate: the auto-mode switch, the fresh
 * `classifyAllShell` read, and the log lines — the info line names the RULE
 * (the user's own text) and never the command, url or query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogger, mockLoadFlags } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockLoadFlags: vi.fn(() => ({ classifyAllShell: false }))
}))
vi.mock('../../services/logger', () => ({ logger: mockLogger }))
vi.mock('../../services/claude-settings', () => ({ loadClaudeAutoModeFlags: mockLoadFlags }))

import { allowRuleGate, type AllowRuleGateInput } from '../allow-rule-gate'

function input(
  command: string,
  allow: string[],
  extra: Partial<AllowRuleGateInput> = {}
): AllowRuleGateInput {
  return {
    action: { kind: 'shell', command },
    toolName: 'bash',
    cwd: '/repo',
    permissions: { allow, ask: [], deny: [], additionalDirectories: [] },
    autoModeActive: () => true,
    logSource: 'TestSession',
    platform: 'linux',
    realpath: (p) => p,
    ...extra
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadFlags.mockReturnValue({ classifyAllShell: false })
})

describe('allowRuleGate — allow', () => {
  it('allows a covered call: info names the rule, the command follows at debug only', () => {
    const secret = 'sk-live-0123456789abcdef'
    const r = allowRuleGate(input(`git log --grep ${secret}`, ['Bash(git log:*)']))
    expect(r).toEqual({ allow: true, rule: 'Bash(git log:*)', rules: ['Bash(git log:*)'] })
    expect(mockLogger.info).toHaveBeenCalledTimes(1)
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSession',
      'auto-mode allow (stage=rule) bash — Bash(git log:*)'
    )
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(secret)
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'TestSession',
      `auto-mode allow-rule skip: git log --grep ${secret}`
    )
  })

  it('never puts a url in the info line either', () => {
    const r = allowRuleGate({
      ...input('', ['WebFetch(domain:example.com)']),
      action: { kind: 'webfetch', url: 'https://api.example.com/private?token=abc' },
      toolName: 'webfetch'
    })
    expect(r).toMatchObject({ allow: true })
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain('token=abc')
  })

  it("names a task child's subagent on the info line", () => {
    allowRuleGate(input('git status', ['Bash(git:*)'], { subagent: 'explore' }))
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSession',
      'auto-mode allow (stage=rule) bash — Bash(git:*) (subagent explore)'
    )
  })

  it('passes the MCP key form through', () => {
    const r = allowRuleGate({
      ...input('', ['mcp__lsp.hub__find.refs']),
      action: { kind: 'mcp', server: 'lsp.hub', tool: 'find_refs' },
      toolName: 'lsp_hub_find_refs',
      mcpToolKey: (t) => t.replace(/[^a-zA-Z0-9_-]/g, '_')
    })
    expect(r).toMatchObject({ allow: true, rule: 'mcp__lsp.hub__find.refs' })
  })
})

describe('allowRuleGate — refusals', () => {
  it('auto mode off: refused quietly, before any settings read', () => {
    const r = allowRuleGate(input('git status', ['Bash(git:*)'], { autoModeActive: () => false }))
    expect(r).toEqual({ allow: false, reason: 'auto-mode-off' })
    expect(mockLoadFlags).not.toHaveBeenCalled()
    expect(mockLogger.debug).not.toHaveBeenCalled()
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it('no usable rule: refused quietly (the common case for a user with no rules)', () => {
    expect(allowRuleGate(input('git status', []))).toEqual({
      allow: false,
      reason: 'rule:none-usable'
    })
    expect(mockLogger.debug).not.toHaveBeenCalled()
  })

  it('any other refusal goes to debug with its reason, never to info', () => {
    const r = allowRuleGate(input('rm -rf ..', ['Bash(rm:*)']))
    expect(r).toEqual({ allow: false, reason: 'write:path:out-of-scope' })
    expect(mockLogger.info).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'TestSession',
      'auto-mode allow-rule skip refused (write:path:out-of-scope)'
    )
  })

  it('classifyAllShell is read FRESH per call from the user settings by default', () => {
    mockLoadFlags.mockReturnValue({ classifyAllShell: true })
    expect(allowRuleGate(input('git status', ['Bash(git:*)']))).toEqual({
      allow: false,
      reason: 'rule:classify-all-shell'
    })
    mockLoadFlags.mockReturnValue({ classifyAllShell: false })
    expect(allowRuleGate(input('git status', ['Bash(git:*)']))).toMatchObject({ allow: true })
    expect(mockLoadFlags).toHaveBeenCalledTimes(2)
    // An explicit value wins and skips the read.
    mockLoadFlags.mockClear()
    expect(
      allowRuleGate(input('git status', ['Bash(git:*)'], { classifyAllShell: true }))
    ).toMatchObject({ allow: false })
    expect(mockLoadFlags).not.toHaveBeenCalled()
  })

  it('never throws: a failing settings read is `internal`', () => {
    mockLoadFlags.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(allowRuleGate(input('git status', ['Bash(git:*)']))).toEqual({
      allow: false,
      reason: 'internal'
    })
  })
})
