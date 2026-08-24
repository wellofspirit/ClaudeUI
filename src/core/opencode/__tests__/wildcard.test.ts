/**
 * Tests for the host-side port of opencode's permission matcher (auto-mode G9).
 *
 * The port has to be behaviourally identical to
 * `vendor/opencode-src/packages/opencode/src/util/wildcard.ts` +
 * `permission/index.ts:evaluate()`, because a divergence means we either miss a
 * user `ask` (auto mode silently downgrades a permission the user singled out)
 * or invent one (auto mode stops working).
 */
import { describe, it, expect } from 'vitest'
import { wildcardMatch, evaluateOpencodeRules, matchesUserAskRule } from '../wildcard'
import type { OpencodePermissionRule } from '../permission-compiler'

const rule = (
  permission: string,
  pattern: string,
  action: OpencodePermissionRule['action']
): OpencodePermissionRule => ({ permission, pattern, action })

describe('wildcardMatch', () => {
  it('anchors the pattern (no substring matches)', () => {
    expect(wildcardMatch('bash', 'bash', 'linux')).toBe(true)
    expect(wildcardMatch('bashful', 'bash', 'linux')).toBe(false)
    expect(wildcardMatch('rebash', 'bash', 'linux')).toBe(false)
  })

  it('maps * → .* and ? → .', () => {
    expect(wildcardMatch('git push --force', 'git *', 'linux')).toBe(true)
    expect(wildcardMatch('cat', 'c?t', 'linux')).toBe(true)
    expect(wildcardMatch('coat', 'c?t', 'linux')).toBe(false)
    expect(wildcardMatch('anything', '*', 'linux')).toBe(true)
  })

  it('a pattern ending in " *" also matches the bare prefix', () => {
    // "git *" must match a bare `git`, not just `git <something>`.
    expect(wildcardMatch('git', 'git *', 'linux')).toBe(true)
    expect(wildcardMatch('git status', 'git *', 'linux')).toBe(true)
    expect(wildcardMatch('gitk', 'git *', 'linux')).toBe(false)
  })

  it('escapes regex metacharacters in the pattern', () => {
    expect(wildcardMatch('a.b', 'a.b', 'linux')).toBe(true)
    expect(wildcardMatch('axb', 'a.b', 'linux')).toBe(false)
    expect(wildcardMatch('src/(x)', 'src/(x)', 'linux')).toBe(true)
  })

  it('normalises backslashes to slashes on BOTH sides', () => {
    expect(wildcardMatch('D:\\repo\\src\\a.ts', 'D:/repo/src/*', 'linux')).toBe(true)
    expect(wildcardMatch('D:/repo/src/a.ts', 'D:\\repo\\src\\*', 'linux')).toBe(true)
  })

  it('matches dotall — a newline in the subject does not stop `*`', () => {
    expect(wildcardMatch('echo a\necho b', 'echo *', 'linux')).toBe(true)
  })

  it('is case-INsensitive on win32 and case-sensitive elsewhere', () => {
    expect(wildcardMatch('GIT push', 'git *', 'win32')).toBe(true)
    expect(wildcardMatch('GIT push', 'git *', 'linux')).toBe(false)
  })
})

describe('evaluateOpencodeRules (last match wins)', () => {
  it('returns undefined when nothing matches (no invented fallthrough ask)', () => {
    expect(evaluateOpencodeRules('bash', 'ls', [rule('edit', '*', 'ask')], 'linux')).toBeUndefined()
    expect(evaluateOpencodeRules('bash', 'ls', [], 'linux')).toBeUndefined()
  })

  it('a LATER rule outranks an earlier one on the same pattern', () => {
    const rules = [rule('bash', 'git *', 'ask'), rule('bash', 'git *', 'allow')]
    expect(evaluateOpencodeRules('bash', 'git push', rules, 'linux')).toBe('allow')
    expect(evaluateOpencodeRules('bash', 'git push', [...rules].reverse(), 'linux')).toBe('ask')
  })

  it('matches the permission category with wildcards too', () => {
    expect(evaluateOpencodeRules('bash', 'anything', [rule('*', '*', 'ask')], 'linux')).toBe('ask')
  })
})

describe('matchesUserAskRule (G9 — user ask outranks the classifier)', () => {
  const askGit = [rule('bash', 'git *', 'ask')]

  it('matches when any of the event patterns hits a user ask rule', () => {
    expect(matchesUserAskRule(askGit, 'bash', ['git push'], 'linux')).toBe(true)
    expect(matchesUserAskRule(askGit, 'bash', ['ls -la', 'git push'], 'linux')).toBe(true)
    expect(matchesUserAskRule(askGit, 'bash', ['ls -la'], 'linux')).toBe(false)
  })

  it('a later user ALLOW on the same pattern un-matches it', () => {
    const rules = [...askGit, rule('bash', 'git *', 'allow')]
    expect(matchesUserAskRule(rules, 'bash', ['git push'], 'linux')).toBe(false)
  })

  it('a later user DENY on the same pattern also un-matches it (opencode denies before asking)', () => {
    const rules = [...askGit, rule('bash', 'git *', 'deny')]
    expect(matchesUserAskRule(rules, 'bash', ['git push'], 'linux')).toBe(false)
  })

  it('an absent/empty pattern list degrades to the whole-category "*"', () => {
    const askAllBash = [rule('bash', '*', 'ask')]
    expect(matchesUserAskRule(askAllBash, 'bash', undefined, 'linux')).toBe(true)
    expect(matchesUserAskRule(askAllBash, 'bash', [], 'linux')).toBe(true)
    expect(matchesUserAskRule(askGit, 'bash', undefined, 'linux')).toBe(false)
  })

  it('no user rules at all → never matches (defaults are not user intent)', () => {
    expect(matchesUserAskRule([], 'bash', ['git push'], 'linux')).toBe(false)
  })

  it('honours win32 case-insensitivity end to end', () => {
    expect(matchesUserAskRule(askGit, 'bash', ['GIT PUSH'], 'win32')).toBe(true)
    expect(matchesUserAskRule(askGit, 'bash', ['GIT PUSH'], 'linux')).toBe(false)
  })
})
