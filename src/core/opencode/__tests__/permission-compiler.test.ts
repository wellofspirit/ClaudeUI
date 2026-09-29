/**
 * Unit tests for the Claude→opencode permission rule compiler (ADR-022).
 * Pure function: ClaudePermissions (Tool(specifier) strings) → opencode ruleset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import {
  parseClaudeRule,
  translateSpecifierPatterns,
  compileClaudeRulesToOpencode,
  suggestOpencodeAllowRule,
  suggestionRuleToClaudeString,
  suggestionDestinationToScope,
  persistAllowSuggestions,
  withoutAllowRules,
  opencodeMcpKey
} from '../permission-compiler'
import { broadBashGlobs } from '../broad-bash-globs'
import { evaluateOpencodeRules } from '../wildcard'
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
  it('bash prefix `cmd:*` → glob `cmd*`', () => {
    expect(translateSpecifierPatterns('bash', 'git diff:*')).toEqual(['git diff*'])
  })
  it('bash existing glob/exact passes through', () => {
    expect(translateSpecifierPatterns('bash', 'npm *')).toEqual(['npm *'])
    expect(translateSpecifierPatterns('bash', 'ls')).toEqual(['ls'])
  })
  it('webfetch domain: → URL-shaped patterns (opencode asks with the FULL URL)', () => {
    // vendor/opencode-src/.../tool/webfetch.ts: `ctx.ask({permission:'webfetch',
    // patterns:[params.url]})` after rejecting non-http(s) URLs. A host-shaped
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

describe('compileClaudeRulesToOpencode', () => {
  it('maps tool names to opencode categories and emits allow→ask→deny order', () => {
    const out = compileClaudeRulesToOpencode(
      perms({
        allow: ['Bash(git diff:*)', 'Read'],
        ask: ['WebFetch(domain:example.com)'],
        deny: ['Edit(secrets/**)']
      })
    )
    expect(out).toEqual([
      { permission: 'bash', pattern: 'git diff*', action: 'allow' },
      { permission: 'read', pattern: '*', action: 'allow' },
      // One WebFetch domain rule expands to the URL forms opencode can
      // actually ask with — all carrying the SAME action, so they remain one
      // rule semantically and the allow→ask→deny tier order is preserved.
      { permission: 'webfetch', pattern: 'http://example.com', action: 'ask' },
      { permission: 'webfetch', pattern: 'http://example.com/*', action: 'ask' },
      { permission: 'webfetch', pattern: 'http://example.com:*', action: 'ask' },
      { permission: 'webfetch', pattern: 'http://example.com#*', action: 'ask' },
      { permission: 'webfetch', pattern: 'https://example.com', action: 'ask' },
      { permission: 'webfetch', pattern: 'https://example.com/*', action: 'ask' },
      { permission: 'webfetch', pattern: 'https://example.com:*', action: 'ask' },
      { permission: 'webfetch', pattern: 'https://example.com#*', action: 'ask' },
      { permission: 'edit', pattern: 'secrets/**', action: 'deny' }
    ])
  })

  it('Write/MultiEdit/NotebookEdit all map to the `edit` category', () => {
    const out = compileClaudeRulesToOpencode(
      perms({ allow: ['Write(dist/**)', 'MultiEdit', 'NotebookEdit'] })
    )
    expect(out.every((r) => r.permission === 'edit')).toBe(true)
    expect(out).toHaveLength(3)
  })

  it('skips unmappable tools rather than guessing; MCP rules compile to opencode keys (ADR-085 §3)', () => {
    const out = compileClaudeRulesToOpencode(
      perms({ allow: ['mcp__server__tool', 'SomeUnknownTool', 'Bash'] })
    )
    expect(out).toEqual([
      { permission: 'server_tool', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' }
    ])
  })

  it('additionalDirectories → external_directory allow rules (platform-correct glob)', () => {
    const dir = process.platform === 'win32' ? 'D:\\extra' : '/extra'
    const out = compileClaudeRulesToOpencode(perms({ additionalDirectories: [dir] }))
    expect(out).toEqual([
      { permission: 'external_directory', pattern: join(dir, '*'), action: 'allow' }
    ])
  })

  it('deny is emitted last so it wins under last-match-wins', () => {
    const out = compileClaudeRulesToOpencode(
      perms({ allow: ['Edit(src/**)'], deny: ['Edit(src/secret.ts)'] })
    )
    expect(out[0]).toEqual({ permission: 'edit', pattern: 'src/**', action: 'allow' })
    expect(out[out.length - 1]).toEqual({
      permission: 'edit',
      pattern: 'src/secret.ts',
      action: 'deny'
    })
  })

  it('empty permissions → empty ruleset', () => {
    expect(compileClaudeRulesToOpencode(perms({}))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ADR-085 §3 — broad Bash deny/ask globs + MCP keys.
// ---------------------------------------------------------------------------

describe('compileClaudeRulesToOpencode — broad Bash deny/ask globs (ADR-085 §3)', () => {
  it.each(['linux', 'win32'] as const)(
    'F1: a broader allow no longer answers a reordered form of a narrower deny (%s)',
    (platform) => {
      const rules = compileClaudeRulesToOpencode(
        perms({ allow: ['Bash(git:*)'], deny: ['Bash(git push --force:*)'] })
      )
      // Before ADR-085 S3 this evaluated to 'allow' (`git*` matched, `git push --force*` did not).
      expect(evaluateOpencodeRules('bash', 'git push origin main --force', rules, platform)).toBe(
        'deny'
      )
      expect(evaluateOpencodeRules('bash', 'git status', rules, platform)).toBe('allow')
    }
  )

  it.each(['linux', 'win32'] as const)(
    'F1 for ask: a broader allow no longer answers a reordered form of a narrower ask (%s)',
    (platform) => {
      const rules = compileClaudeRulesToOpencode(
        perms({ allow: ['Bash(docker:*)'], ask: ['Bash(docker run:*)'] })
      )
      expect(evaluateOpencodeRules('bash', 'docker --context x run alpine', rules, platform)).toBe(
        'ask'
      )
      expect(evaluateOpencodeRules('bash', 'docker build -t runtime .', rules, platform)).toBe(
        'allow'
      )
    }
  )

  it('a deny/ask rule compiles to its verbatim pattern first, then the broad globs, all in its tier', () => {
    const out = compileClaudeRulesToOpencode(
      perms({ ask: ['Bash(docker run:*)'], deny: ['Bash(git push --force:*)'] })
    )
    const ask = out.filter((r) => r.action === 'ask').map((r) => r.pattern)
    const deny = out.filter((r) => r.action === 'deny').map((r) => r.pattern)
    expect(ask).toEqual(['docker run*', ...broadBashGlobs('docker run:*')])
    expect(deny).toEqual(['git push --force*', ...broadBashGlobs('git push --force:*')])
    expect(new Set(deny).size).toBe(deny.length)
    // Tier order holds: every ask before every deny.
    const actions = out.map((r) => r.action)
    expect(actions.lastIndexOf('ask')).toBeLessThan(actions.indexOf('deny'))
  })

  it('allow bash rules emit the verbatim pattern only (broadening an allow is an over-grant)', () => {
    expect(compileClaudeRulesToOpencode(perms({ allow: ['Bash(git push --force:*)'] }))).toEqual([
      { permission: 'bash', pattern: 'git push --force*', action: 'allow' }
    ])
  })

  it('a bare Bash deny stays one `*` rule; a glob-word rule keeps its verbatim form only', () => {
    expect(compileClaudeRulesToOpencode(perms({ deny: ['Bash'] }))).toEqual([
      { permission: 'bash', pattern: '*', action: 'deny' }
    ])
    expect(compileClaudeRulesToOpencode(perms({ deny: ['Bash(rm -rf /*)'] }))).toEqual([
      { permission: 'bash', pattern: 'rm -rf /*', action: 'deny' }
    ])
  })
})

describe('compileClaudeRulesToOpencode — MCP rules (ADR-085 §3)', () => {
  const compile = (p: Partial<ClaudePermissions>, mcpServers?: string[]) =>
    compileClaudeRulesToOpencode(perms(p), mcpServers ? { mcpServers } : undefined)

  it('opencodeMcpKey mirrors opencode `sanitize(server)_sanitize(tool)` and `sanitize(server)_*`', () => {
    expect(opencodeMcpKey('lsphub', 'find_refs')).toBe('lsphub_find_refs')
    expect(opencodeMcpKey('a b', 'x.y')).toBe('a_b_x_y')
    expect(opencodeMcpKey('my-server')).toBe('my-server_*')
  })

  it('tool level → the exact key in every tier (a specifier is ignored)', () => {
    expect(
      compile({
        allow: ['mcp__lsphub__find_refs'],
        ask: ['mcp__lsphub__rename(x)'],
        deny: ['mcp__lsphub__delete_all']
      })
    ).toEqual([
      { permission: 'lsphub_find_refs', pattern: '*', action: 'allow' },
      { permission: 'lsphub_rename', pattern: '*', action: 'ask' },
      { permission: 'lsphub_delete_all', pattern: '*', action: 'deny' }
    ])
  })

  it('server level deny/ask → `s_*`, with or without `__*`, known server or not', () => {
    expect(compile({ ask: ['mcp__jira'], deny: ['mcp__lsphub__*'] })).toEqual([
      { permission: 'jira_*', pattern: '*', action: 'ask' },
      { permission: 'lsphub_*', pattern: '*', action: 'deny' }
    ])
  })

  it('server level allow → `s_*` only for a server in the live set', () => {
    expect(compile({ allow: ['mcp__lsphub', 'mcp__other__*'] }, ['lsphub'])).toEqual([
      { permission: 'lsphub_*', pattern: '*', action: 'allow' }
    ])
    // No live set (existing callers) → never emitted.
    expect(compile({ allow: ['mcp__lsphub'] })).toEqual([])
  })

  it('a server-level allow whose glob hits a built-in key is skipped; its deny is emitted', () => {
    // `external_*` would also match `external_directory`, `doom_*` `doom_loop`.
    expect(compile({ allow: ['mcp__external'] }, ['external'])).toEqual([])
    expect(compile({ allow: ['mcp__doom__*'] }, ['doom'])).toEqual([])
    expect(compile({ deny: ['mcp__external'] }, ['external'])).toEqual([
      { permission: 'external_*', pattern: '*', action: 'deny' }
    ])
  })

  it('names are sanitised like opencode does (`mcp__a b__x`)', () => {
    expect(compile({ deny: ['mcp__a b__x'] })).toEqual([
      { permission: 'a_b_x', pattern: '*', action: 'deny' }
    ])
    expect(compile({ allow: ['mcp__a b'] }, ['a b'])).toEqual([
      { permission: 'a_b_*', pattern: '*', action: 'allow' }
    ])
  })

  it('a user MCP deny beats an earlier server-level allow (tier order)', () => {
    const rules = compile({ allow: ['mcp__lsphub'], deny: ['mcp__lsphub__delete_all'] }, ['lsphub'])
    expect(evaluateOpencodeRules('lsphub_delete_all', '*', rules, 'linux')).toBe('deny')
    expect(evaluateOpencodeRules('lsphub_find_refs', '*', rules, 'linux')).toBe('allow')
  })
})

describe('suggestOpencodeAllowRule (reverse: opencode approval → Claude suggestion)', () => {
  it('bash + command pattern → addRules Bash(command), localSettings', () => {
    expect(suggestOpencodeAllowRule('bash', ['echo hi'])).toEqual({
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
})

describe('suggestionRuleToClaudeString + suggestionDestinationToScope', () => {
  it('rule with content → Tool(content); without → Tool', () => {
    expect(suggestionRuleToClaudeString({ toolName: 'Bash', ruleContent: 'echo hi' })).toBe(
      'Bash(echo hi)'
    )
    expect(suggestionRuleToClaudeString({ toolName: 'Edit' })).toBe('Edit')
  })
  it('round-trips: suggested rule → claude string → compiled opencode rule', () => {
    const s = suggestOpencodeAllowRule('bash', ['git diff'])!
    const ruleStr = suggestionRuleToClaudeString(s.rules![0])
    const compiled = compileClaudeRulesToOpencode(perms({ allow: [ruleStr] }))
    expect(compiled).toEqual([{ permission: 'bash', pattern: 'git diff', action: 'allow' }])
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

describe('withoutAllowRules', () => {
  const compiled = (): ReturnType<typeof compileClaudeRulesToOpencode> =>
    compileClaudeRulesToOpencode(
      perms({
        allow: ['Bash(git:*)', 'WebFetch(domain:example.com)'],
        ask: ['Bash(git push:*)'],
        deny: ['Bash(rm:*)'],
        additionalDirectories: ['/extra']
      })
    )

  it('drops every allow rule and keeps ask + deny intact', () => {
    const filtered = withoutAllowRules(compiled())
    expect(filtered.every((r) => r.action !== 'allow')).toBe(true)
    // The tightening tiers survive verbatim — the filter only ever removes
    // permission, never grants it.
    expect(filtered).toEqual(compiled().filter((r) => r.action !== 'allow'))
    expect(filtered).toContainEqual({ permission: 'bash', pattern: 'git push*', action: 'ask' })
    expect(filtered).toContainEqual({ permission: 'bash', pattern: 'rm*', action: 'deny' })
  })

  it('keeps the broad deny/ask globs (ADR-085 §3) — a reordered denied command stays denied', () => {
    const filtered = withoutAllowRules(
      compileClaudeRulesToOpencode(
        perms({ allow: ['Bash(git:*)'], deny: ['Bash(git push --force:*)'] })
      )
    )
    for (const glob of broadBashGlobs('git push --force:*')) {
      expect(filtered).toContainEqual({ permission: 'bash', pattern: glob, action: 'deny' })
    }
    expect(evaluateOpencodeRules('bash', 'git push origin main --force', filtered, 'linux')).toBe(
      'deny'
    )
  })

  it('drops the external_directory allows compiled from additionalDirectories', () => {
    // Harmless: auto mode's base is buildRuleset('acceptEdits'), whose `{*:allow}`
    // baseline already covers external_directory (ADR-022 leaves that category
    // ungated in every mode) — so this removes nothing that was load-bearing.
    expect(withoutAllowRules(compiled()).some((r) => r.permission === 'external_directory')).toBe(
      false
    )
  })

  it('does NOT mutate its input — the provenance set (G9) shares this array', () => {
    const original = compiled()
    const snapshot = structuredClone(original)
    withoutAllowRules(original)
    expect(original).toEqual(snapshot)
  })
})
