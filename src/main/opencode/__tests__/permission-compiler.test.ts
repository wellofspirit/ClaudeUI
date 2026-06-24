/**
 * Unit tests for the Claude→opencode permission rule compiler (ADR-022).
 * Pure function: ClaudePermissions (Tool(specifier) strings) → opencode ruleset.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  parseClaudeRule,
  translateSpecifier,
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

describe('translateSpecifier', () => {
  it('bash prefix `cmd:*` → glob `cmd*`', () => {
    expect(translateSpecifier('bash', 'git diff:*')).toBe('git diff*')
  })
  it('bash existing glob/exact passes through', () => {
    expect(translateSpecifier('bash', 'npm *')).toBe('npm *')
    expect(translateSpecifier('bash', 'ls')).toBe('ls')
  })
  it('webfetch domain: → host glob', () => {
    expect(translateSpecifier('webfetch', 'domain:example.com')).toBe('example.com*')
  })
  it('file globs pass through', () => {
    expect(translateSpecifier('edit', 'src/**')).toBe('src/**')
  })
  it('undefined specifier → *', () => {
    expect(translateSpecifier('edit', undefined)).toBe('*')
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
      { permission: 'webfetch', pattern: 'example.com*', action: 'ask' },
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
