/**
 * @vitest-environment node
 *
 * Unit tests for PiPermissionEngine (permission-engine.ts) — pure decision
 * logic, no fs/network. mergedClaudeRulesFor's tests mock claude-settings so
 * they're hermetic (no dependence on the dev machine's real ~/.claude).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MergedClaudeRules } from '../permission-engine'

const { mockLoadClaudePermissions } = vi.hoisted(() => ({
  mockLoadClaudePermissions: vi.fn()
}))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  decide,
  piToolKind,
  firstMatchingRule,
  sessionAllowKey,
  normalizeWhitespace,
  mergedClaudeRulesFor
} from '../permission-engine'

function rules(partial: Partial<MergedClaudeRules> = {}): MergedClaudeRules {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined, ...partial }
}

const NO_SESSION_ALLOWS = new Set<string>()

beforeEach(() => {
  mockLoadClaudePermissions.mockReset()
})

describe('piToolKind', () => {
  it('maps pi built-in tool names', () => {
    expect(piToolKind('bash')).toBe('command')
    expect(piToolKind('edit')).toBe('fileEdit')
    expect(piToolKind('write')).toBe('fileWrite')
    expect(piToolKind('read')).toBe('fileRead')
    expect(piToolKind('grep')).toBe('search')
    expect(piToolKind('find')).toBe('search')
    expect(piToolKind('ls')).toBe('search')
    expect(piToolKind('mystery')).toBe('unknown')
  })

  it('resolves hosted-MCP tool names engine-independently (M4 readiness)', () => {
    expect(piToolKind('mcp__claude-ui__render_mermaid')).toBe('diagram')
    expect(piToolKind('mcp__some-server__tool')).toBe('mcp')
  })
})

describe('decide — mode base (no rules, no sessionAllows)', () => {
  const ctx = (mode: string) => ({ mode, rules: rules(), sessionAllows: NO_SESSION_ALLOWS })

  const cases: [string, string, 'allow' | 'ask'][] = [
    // default: fileRead/search allow, everything else ask
    ['default', 'read', 'allow'],
    ['default', 'grep', 'allow'],
    ['default', 'find', 'allow'],
    ['default', 'ls', 'allow'],
    ['default', 'edit', 'ask'],
    ['default', 'write', 'ask'],
    ['default', 'bash', 'ask'],
    ['default', 'unknown_tool', 'ask'],
    // acceptEdits: also fileEdit/fileWrite allow, bash/unknown ask
    ['acceptEdits', 'read', 'allow'],
    ['acceptEdits', 'grep', 'allow'],
    ['acceptEdits', 'edit', 'allow'],
    ['acceptEdits', 'write', 'allow'],
    ['acceptEdits', 'bash', 'ask'],
    ['acceptEdits', 'unknown_tool', 'ask'],
    // full / auto / bypassPermissions: allow everything
    ['full', 'bash', 'allow'],
    ['full', 'edit', 'allow'],
    ['full', 'unknown_tool', 'allow'],
    ['auto', 'bash', 'allow'],
    ['auto', 'unknown_tool', 'allow'],
    ['bypassPermissions', 'bash', 'allow'],
    ['bypassPermissions', 'unknown_tool', 'allow'],
    // plan (defensive — pi never advertises this mode) treated as default
    ['plan', 'read', 'allow'],
    ['plan', 'edit', 'ask'],
    ['plan', 'bash', 'ask'],
    // an unrecognised mode string falls back to default's behavior (fail toward asking)
    ['some-future-mode', 'read', 'allow'],
    ['some-future-mode', 'bash', 'ask']
  ]

  it.each(cases)('mode=%s toolName=%s -> %s', (mode, toolName, expected) => {
    expect(decide(toolName, {}, ctx(mode))).toBe(expected)
  })
})

describe('decide — deny > ask > allow precedence', () => {
  it('a matching deny rule wins even when the SAME tool also matches ask and allow rules', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ deny: ['Edit'], ask: ['Edit'], allow: ['Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', {}, ctx)).toBe('deny')
  })

  it('without the deny rule, a matching ask rule wins over allow', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ ask: ['Edit'], allow: ['Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', {}, ctx)).toBe('ask')
  })

  it('without deny/ask, a matching allow rule wins over the mode base', () => {
    const ctx = {
      mode: 'default', // mode base for 'edit' would be 'ask'
      rules: rules({ allow: ['Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', {}, ctx)).toBe('allow')
  })

  it('full mode still honors an explicit ask rule (autonomy is not a bypass of a user rule)', () => {
    const ctx = { mode: 'full', rules: rules({ ask: ['Bash'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'anything' }, ctx)).toBe('ask')
  })

  it('full mode still honors an explicit deny rule', () => {
    const ctx = { mode: 'full', rules: rules({ deny: ['Bash'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'anything' }, ctx)).toBe('deny')
  })
})

describe('decide — Bash prefix/exact rules', () => {
  it('a prefix rule (cmd:*) matches a command starting with that prefix', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['Bash(npm test:*)'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'npm test unit' }, ctx)).toBe('allow')
  })

  it('a prefix rule does not match an unrelated command', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['Bash(npm test:*)'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'npm build' }, ctx)).toBe('ask')
  })

  it('an exact rule (no :*) matches only the identical command', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['Bash(echo hi)'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'echo hi' }, ctx)).toBe('allow')
    expect(decide('bash', { command: 'echo hi there' }, ctx)).toBe('ask')
  })

  it('whitespace-normalizes both the rule and the command before comparing (prefix form)', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['Bash(npm  test:*)'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: '  npm test   unit  ' }, ctx)).toBe('allow')
  })

  it('whitespace-normalizes both the rule and the command before comparing (exact form)', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['Bash(echo   hi)'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: '  echo hi  ' }, ctx)).toBe('allow')
  })

  it('a bare Bash rule (no specifier) matches every command', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['Bash'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'anything at all' }, ctx)).toBe('allow')
  })
})

describe('decide — path-glob (and other non-bash specifier) rules are skipped, never default-allow', () => {
  it('a specifier\'d Edit rule (path glob) never matches — falls through to the mode base', () => {
    const ctx = {
      mode: 'default', // mode base for edit is 'ask'
      rules: rules({ allow: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'src/foo.ts' }, ctx)).toBe('ask')
  })

  it('an unevaluated ask-tier specifier rule does not force ask — still falls through to the (legitimate) mode-base allow', () => {
    const ctx = {
      mode: 'acceptEdits', // mode base for fileEdit is 'allow'
      rules: rules({ ask: ['Edit(src/**)'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'src/foo.ts' }, ctx)).toBe('allow')
  })

  it('a bare Edit rule (no specifier) still matches normally alongside a skipped specifier rule', () => {
    const ctx = {
      mode: 'default',
      rules: rules({ allow: ['Edit(src/**)', 'Edit'] }),
      sessionAllows: NO_SESSION_ALLOWS
    }
    expect(decide('edit', { path: 'anywhere.ts' }, ctx)).toBe('allow')
  })

  it('logs the skipped rule only once even across repeated calls (de-duplicated)', async () => {
    const { logger } = (await import('../../services/logger')) as unknown as {
      logger: { debug: ReturnType<typeof vi.fn> }
    }
    logger.debug.mockClear()
    const ctx = { mode: 'default', rules: rules({ allow: ['Edit(some/unique/glob/**)'] }), sessionAllows: NO_SESSION_ALLOWS }
    decide('edit', {}, ctx)
    decide('edit', {}, ctx)
    decide('edit', {}, ctx)
    const matching = logger.debug.mock.calls.filter((c) => String(c[1] ?? '').includes('some/unique/glob'))
    expect(matching.length).toBeLessThanOrEqual(1)
  })
})

describe('decide — sessionAllows', () => {
  it('honors a bare tool sessionAllows entry', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: new Set(['edit']) }
    expect(decide('edit', { path: 'x.ts' }, ctx)).toBe('allow')
  })

  it('a sessionAllows entry for a DIFFERENT tool does not match', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: new Set(['edit']) }
    expect(decide('write', { path: 'x.ts' }, ctx)).toBe('ask')
  })

  it('scopes bash sessionAllows by the normalized command', () => {
    const ctx = { mode: 'default', rules: rules(), sessionAllows: new Set(['bash:npm test']) }
    expect(decide('bash', { command: 'npm test' }, ctx)).toBe('allow')
    expect(decide('bash', { command: '  npm   test  ' }, ctx)).toBe('allow') // normalized match
    expect(decide('bash', { command: 'npm test unit' }, ctx)).toBe('ask') // different command — not covered
  })

  it('sessionAllows is checked before allow rules but after deny/ask', () => {
    const ctx = { mode: 'default', rules: rules({ deny: ['Bash'] }), sessionAllows: new Set(['bash:npm test']) }
    expect(decide('bash', { command: 'npm test' }, ctx)).toBe('deny')
  })
})

describe('decide — unknown Claude tool names never match a pi tool', () => {
  it('an unmapped allow rule never matches (falls through to mode base)', () => {
    const ctx = { mode: 'default', rules: rules({ allow: ['WebFetch'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('bash', { command: 'x' }, ctx)).toBe('ask')
  })

  it('an unmapped deny rule never matches (full mode still allows)', () => {
    const ctx = { mode: 'full', rules: rules({ deny: ['Task'] }), sessionAllows: NO_SESSION_ALLOWS }
    expect(decide('edit', {}, ctx)).toBe('allow')
  })
})

describe('firstMatchingRule', () => {
  it('returns the first rule string that matches the tool_call', () => {
    expect(firstMatchingRule(['Read', 'Bash(npm:*)'], 'bash', { command: 'npm install' })).toBe('Bash(npm:*)')
  })

  it('returns undefined when nothing matches', () => {
    expect(firstMatchingRule(['Read', 'Write'], 'bash', { command: 'x' })).toBeUndefined()
  })
})

describe('sessionAllowKey', () => {
  it('scopes bash by normalized command', () => {
    expect(sessionAllowKey('bash', { command: '  npm   test  ' })).toBe('bash:npm test')
  })

  it('uses the bare tool name for non-bash tools', () => {
    expect(sessionAllowKey('edit', { path: 'x.ts' })).toBe('edit')
  })
})

describe('normalizeWhitespace', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeWhitespace('  npm   test   unit  ')).toBe('npm test unit')
  })
})

describe('mergedClaudeRulesFor', () => {
  it('merges user + project + local scopes in order', () => {
    mockLoadClaudePermissions.mockImplementation((scope: string) => {
      if (scope === 'user') return { allow: ['Read'], deny: [], ask: [], additionalDirectories: ['/u'] }
      if (scope === 'project') return { allow: ['Edit'], deny: ['Bash(rm:*)'], ask: [], additionalDirectories: [] }
      return { allow: [], deny: [], ask: ['Write'], additionalDirectories: ['/l'] }
    })

    const merged = mergedClaudeRulesFor('/cwd')

    expect(merged.allow).toEqual(['Read', 'Edit'])
    expect(merged.deny).toEqual(['Bash(rm:*)'])
    expect(merged.ask).toEqual(['Write'])
    expect(merged.additionalDirectories).toEqual(['/u', '/l'])
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('user', '/cwd')
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('project', '/cwd')
    expect(mockLoadClaudePermissions).toHaveBeenCalledWith('local', '/cwd')
  })

  it('is best-effort — a throwing loader yields empty rules rather than throwing', () => {
    mockLoadClaudePermissions.mockImplementation(() => {
      throw new Error('disk on fire')
    })
    expect(() => mergedClaudeRulesFor('/cwd')).not.toThrow()
    expect(mergedClaudeRulesFor('/cwd')).toEqual(rules())
  })
})
