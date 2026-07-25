/**
 * Unit tests for the Claude→opencode permission rule compiler (ADR-022).
 * Pure function: ClaudePermissions (Tool(specifier) strings) → opencode ruleset.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  parseClaudeRule,
  translateSpecifierPatterns,
  compileClaudeRulesToOpencode,
  suggestOpencodeAllowRule,
  suggestionRuleToClaudeString,
  suggestionDestinationToScope
} from '../permission-compiler'
import type { ClaudePermissions } from '../../../shared/types'

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
    expect(translateSpecifierPatterns('webfetch', 'https://example.com/*')).toEqual(['https://example.com/*'])
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
    const out = compileClaudeRulesToOpencode(perms({ allow: ['Write(dist/**)', 'MultiEdit', 'NotebookEdit'] }))
    expect(out.every((r) => r.permission === 'edit')).toBe(true)
    expect(out).toHaveLength(3)
  })

  it('skips unmappable tools (e.g. MCP) rather than guessing', () => {
    const out = compileClaudeRulesToOpencode(perms({ allow: ['mcp__server__tool', 'Bash'] }))
    expect(out).toEqual([{ permission: 'bash', pattern: '*', action: 'allow' }])
  })

  it('additionalDirectories → external_directory allow rules (platform-correct glob)', () => {
    const dir = process.platform === 'win32' ? 'D:\\extra' : '/extra'
    const out = compileClaudeRulesToOpencode(perms({ additionalDirectories: [dir] }))
    expect(out).toEqual([
      { permission: 'external_directory', pattern: join(dir, '*'), action: 'allow' }
    ])
  })

  it('deny is emitted last so it wins under last-match-wins', () => {
    const out = compileClaudeRulesToOpencode(perms({ allow: ['Edit(src/**)'], deny: ['Edit(src/secret.ts)'] }))
    expect(out[0]).toEqual({ permission: 'edit', pattern: 'src/**', action: 'allow' })
    expect(out[out.length - 1]).toEqual({ permission: 'edit', pattern: 'src/secret.ts', action: 'deny' })
  })

  it('empty permissions → empty ruleset', () => {
    expect(compileClaudeRulesToOpencode(perms({}))).toEqual([])
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
    expect(suggestionRuleToClaudeString({ toolName: 'Bash', ruleContent: 'echo hi' })).toBe('Bash(echo hi)')
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
