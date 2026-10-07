/**
 * Unit tests for the wire-shape-independent half of opencode's permission
 * handling (ADR-022): Claude rule parsing, specifier translation, MCP keys,
 * and the reverse direction (an ask → a Claude "always allow" suggestion,
 * persisted). The 2.x compiler itself is `permission-v2.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseClaudeRule,
  translateSpecifierPatterns,
  suggestOpencodeAllowRule,
  suggestionRuleToClaudeString,
  suggestionDestinationToScope,
  persistAllowSuggestions
} from '../permission-compiler'
import { compileClaudeRulesV2 } from '../permission-v2'
import type { ClaudePermissions, PermissionSuggestion } from '../../../shared/types'

// The store the shared persister writes through — never the dev machine's real
// ~/.claude. `loadClaudePermissions` answers from `stored`, `save` writes back.
const stored = vi.hoisted(() => new Map<string, ClaudePermissions>())
const saved = vi.hoisted(() => vi.fn())
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: (scope: string) =>
    stored.get(scope) ?? {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    },
  saveClaudePermissions: saved
}))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

function perms(p: Partial<ClaudePermissions>): ClaudePermissions {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined, ...p }
}

describe('parseClaudeRule', () => {
  it('bare tool name', () => {
    expect(parseClaudeRule('Bash')).toEqual({ tool: 'Bash' })
  })
  it('tool with specifier', () => {
    expect(parseClaudeRule('Bash(git diff:*)')).toEqual({ tool: 'Bash', specifier: 'git diff:*' })
  })
  it('empty / wildcard specifier collapses to whole-tool', () => {
    expect(parseClaudeRule('Bash()')).toEqual({ tool: 'Bash' })
    expect(parseClaudeRule('Bash(*)')).toEqual({ tool: 'Bash' })
  })
  it('malformed (no closing paren) → whole string as tool', () => {
    expect(parseClaudeRule('Bash(oops')).toEqual({ tool: 'Bash(oops' })
  })
  it('empty string → null', () => {
    expect(parseClaudeRule('   ')).toBeNull()
  })
})

describe('translateSpecifierPatterns', () => {
  it('shell prefix `cmd:*` → glob `cmd*`', () => {
    expect(translateSpecifierPatterns('shell', 'git diff:*')).toEqual(['git diff*'])
  })
  it('shell existing glob/exact passes through', () => {
    expect(translateSpecifierPatterns('shell', 'npm *')).toEqual(['npm *'])
    expect(translateSpecifierPatterns('shell', 'ls')).toEqual(['ls'])
  })
  it('webfetch domain: → URL-shaped patterns (opencode asks with the FULL URL)', () => {
    // opencode's webfetch asks with the URL as the resource after rejecting
    // non-http(s) URLs. A host-shaped
    // `example.com*` therefore never matched anything — the rule was inert.
    expect(translateSpecifierPatterns('webfetch', 'domain:example.com')).toEqual([
      'http://example.com',
      'http://example.com/*',
      'http://example.com:*',
      'http://example.com#*',
      'https://example.com',
      'https://example.com/*',
      'https://example.com:*',
      'https://example.com#*'
    ])
  })
  it('webfetch host terminators keep the match anchored (no look-alike suffix host)', () => {
    // Every emitted pattern ends the host at a legal URL boundary, so a bare
    // prefix match on `example.com.evil.example` is impossible.
    for (const p of translateSpecifierPatterns('webfetch', 'domain:example.com')) {
      expect(p.startsWith('http://example.com') || p.startsWith('https://example.com')).toBe(true)
      expect(p).not.toMatch(/example\.com\*$/)
    }
  })
  it('webfetch non-domain specifiers pass through unchanged', () => {
    expect(translateSpecifierPatterns('webfetch', 'https://example.com/*')).toEqual([
      'https://example.com/*'
    ])
  })
  it('websearch keeps the legacy host glob (opencode asks with the QUERY, not a URL)', () => {
    expect(translateSpecifierPatterns('websearch', 'domain:example.com')).toEqual(['example.com*'])
  })
  it('file globs pass through', () => {
    expect(translateSpecifierPatterns('edit', 'src/**')).toEqual(['src/**'])
  })
  it('undefined specifier → *', () => {
    expect(translateSpecifierPatterns('edit', undefined)).toEqual(['*'])
  })
})

describe('suggestOpencodeAllowRule (reverse: opencode approval → Claude suggestion)', () => {
  it('shell + command pattern → addRules Bash(command), localSettings', () => {
    expect(suggestOpencodeAllowRule('shell', ['echo hi'])).toEqual({
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
      rules: [{ toolName: 'Bash', ruleContent: 'echo hi' }]
    })
  })
  it('category with no specific pattern → whole-tool rule', () => {
    expect(suggestOpencodeAllowRule('edit', undefined)).toEqual({
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
      rules: [{ toolName: 'Edit' }]
    })
  })
  it('`*` pattern is treated as no specific pattern', () => {
    expect(suggestOpencodeAllowRule('read', ['*'])?.rules).toEqual([{ toolName: 'Read' }])
  })
  it('unmapped category → null (no suggestion)', () => {
    expect(suggestOpencodeAllowRule('doom_loop', ['*'])).toBeNull()
  })
  it('`subagent` maps back to Task; the suggestion round-trips through the `shell` prefix form', () => {
    expect(suggestOpencodeAllowRule('subagent', ['explore'])?.rules).toEqual([
      { toolName: 'Task', ruleContent: 'explore' }
    ])
    expect(translateSpecifierPatterns('shell', 'git diff:*')).toEqual(['git diff*'])
  })
})

describe('suggestionRuleToClaudeString + suggestionDestinationToScope', () => {
  it('rule with content → Tool(content); without → Tool', () => {
    expect(suggestionRuleToClaudeString({ toolName: 'Bash', ruleContent: 'echo hi' })).toBe(
      'Bash(echo hi)'
    )
    expect(suggestionRuleToClaudeString({ toolName: 'Edit' })).toBe('Edit')
  })
  it('round-trips: suggested rule → claude string → compiled opencode rule', () => {
    const s = suggestOpencodeAllowRule('shell', ['git diff'])!
    const ruleStr = suggestionRuleToClaudeString(s.rules![0])
    const compiled = compileClaudeRulesV2(perms({ allow: [ruleStr] }))
    expect(compiled).toEqual([{ action: 'shell', resource: 'git diff', effect: 'allow' }])
  })
  it('maps destinations to scopes; session/unknown → null', () => {
    expect(suggestionDestinationToScope('userSettings')).toBe('user')
    expect(suggestionDestinationToScope('projectSettings')).toBe('project')
    expect(suggestionDestinationToScope('localSettings')).toBe('local')
    expect(suggestionDestinationToScope('session')).toBeNull()
    expect(suggestionDestinationToScope('cliArg')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// persistAllowSuggestions — the ONE copy behind Codex/pi/opencode sessions.
// ---------------------------------------------------------------------------

describe('persistAllowSuggestions', () => {
  const rule = (destination: string, ruleContent: string): PermissionSuggestion => ({
    type: 'addRules',
    behavior: 'allow',
    destination,
    rules: [{ toolName: 'Bash', ruleContent }]
  })

  beforeEach(() => {
    stored.clear()
    saved.mockClear()
  })

  it('writes each destination to its own scope, merging with what is already there', () => {
    stored.set('user', {
      allow: ['Read'],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    })
    expect(
      persistAllowSuggestions(
        [
          rule('userSettings', 'ls'),
          rule('projectSettings', 'git status'),
          rule('localSettings', 'pwd'),
          // Same scope twice → one write carrying both rules.
          rule('localSettings', 'whoami')
        ],
        '/work'
      )
    ).toBe(true)
    expect(saved.mock.calls.map(([scope, perms, cwd]) => [scope, perms.allow, cwd])).toEqual([
      ['user', ['Read', 'Bash(ls)'], '/work'],
      ['project', ['Bash(git status)'], '/work'],
      ['local', ['Bash(pwd)', 'Bash(whoami)'], '/work']
    ])
  })

  it('skips destinations with no on-disk scope, and reports nothing written', () => {
    // `session`/`cliArg` are the engines' own in-memory grants (opencode's
    // `always` reply, Codex's sessionAllows) — there is no file to touch.
    expect(persistAllowSuggestions([rule('session', 'ls'), rule('cliArg', 'ls')], '/work')).toBe(
      false
    )
    // Non-allow / non-addRules suggestions are not permission grants either.
    expect(
      persistAllowSuggestions(
        [
          { ...rule('userSettings', 'ls'), behavior: 'deny' },
          { ...rule('userSettings', 'ls'), type: 'setMode' },
          { type: 'addRules', behavior: 'allow', destination: 'userSettings' }
        ],
        '/work'
      )
    ).toBe(false)
    expect(saved).not.toHaveBeenCalled()
  })

  it('swallows a failing store write and reports nothing written', () => {
    saved.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(persistAllowSuggestions([rule('userSettings', 'ls')], '/work')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// withoutAllowRules — auto mode's classifier-bypass filter (cli.js §3 step 2).
// ---------------------------------------------------------------------------
