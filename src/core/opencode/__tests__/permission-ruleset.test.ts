/**
 * The edit-auto-accepting bases (`acceptEdits`/`autoEdit`) ask for edits to
 * agent-control paths (ADR-084 §3); auto mode's base asks for every edit and
 * leaves the path test to the host-side gate (`agent-control-gate.ts`). Evaluated with the host-side port of opencode's own matcher
 * (`../wildcard.ts`, last-match-wins), on the path form opencode's edit tools
 * ask with: worktree-relative, `\` on Windows, absolute only across drives.
 */
import { describe, it, expect } from 'vitest'
import { buildAutoModeRuleset, buildRuleset } from '../permission-ruleset'
import { evaluateOpencodeRules } from '../wildcard'
import { compileClaudeRulesToOpencode, withoutAllowRules } from '../permission-compiler'
import { agentControlEditPatterns, isAgentControlPath } from '../../automode/agent-control-paths'
import type { ClaudePermissions } from '../../../shared/types'

const perms = (p: Partial<ClaudePermissions>): ClaudePermissions => ({
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined,
  ...p
})

describe.each(['acceptEdits', 'autoEdit'])('buildRuleset(%s) — agent-control edits ask', (mode) => {
  const rs = buildRuleset(mode)
  const edit = (subject: string, platform: NodeJS.Platform = 'linux') =>
    evaluateOpencodeRules('edit', subject, rs, platform)

  it('ends with the agent-control edit asks, after the allow-all baseline and the other gates', () => {
    const tail = agentControlEditPatterns().map((pattern) => ({
      permission: 'edit',
      pattern,
      action: 'ask'
    }))
    expect(rs.slice(-tail.length)).toEqual(tail)
    expect(rs[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    // No blanket edit rule: ordinary edits stay on the allow-all baseline.
    expect(rs.some((r) => r.permission === 'edit' && r.pattern === '*')).toBe(false)
  })

  it.each([
    '.git/config',
    'sub/.git/hooks/pre-commit',
    '.claude/settings.json',
    '.vscode/tasks.json',
    'CLAUDE.md',
    'docs/CLAUDE.md',
    '.mcp.json',
    'opencode.json',
    '.pi/settings.json',
    // outside the worktree: opencode's path.relative yields ../…
    '../other/.git/config',
    // across drives path.relative returns the absolute path
    'E:/elsewhere/.claude/settings.json'
  ])('asks for %s', (subject) => {
    expect(edit(subject)).toBe('ask')
  })

  it('asks for the Windows-separator form opencode sends from edit/write on win32', () => {
    expect(edit('.git\\config', 'win32')).toBe('ask')
    expect(edit('sub\\.git\\hooks\\pre-commit', 'win32')).toBe('ask')
    expect(edit('E:\\x\\.claude\\settings.json', 'win32')).toBe('ask')
  })

  it("follows Wildcard.match's case rule: insensitive on win32 only", () => {
    expect(edit('.GIT/config', 'win32')).toBe('ask')
    expect(edit('docs/claude.md', 'win32')).toBe('ask')
    // Residual off Windows (the pi matcher folds case everywhere; opencode's
    // server matcher does not) — pinned so a change is deliberate.
    expect(edit('.GIT/config', 'darwin')).toBe('allow')
  })

  it.each([
    'src/a.ts',
    'src/.git-hooks-docs.md',
    '.github/workflows/ci.yml',
    '.gitignore',
    'foo.git/config',
    'docs/claude-notes.md'
  ])('still auto-allows %s', (subject) => {
    expect(edit(subject)).toBe('allow')
  })

  it('agrees with the shared matcher on every plain spelling (win32 case rule)', () => {
    const subjects = [
      '.git/config',
      '.git',
      'a/b/.git',
      'a/.husky/pre-commit',
      '.githooks/x',
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
      '.opencode/plugin/p.ts',
      'opencode.jsonc',
      '.agents/skills/s/SKILL.md',
      'AGENTS.md',
      'x/AGENTS.override.md',
      'CLAUDE.local.md',
      'src/a.ts',
      'src/.git-hooks-docs.md',
      'CLAUDE.md.bak',
      '.claudeignore'
    ]
    for (const s of subjects) {
      expect(edit(s, 'win32') === 'ask', s).toBe(isAgentControlPath(s))
    }
  })

  it('a user ALLOW rule appended after the base still wins outside auto mode', () => {
    const composed = [
      ...rs,
      ...compileClaudeRulesToOpencode(perms({ allow: ['Edit(.claude/**)'] }))
    ]
    expect(evaluateOpencodeRules('edit', '.claude/settings.json', composed, 'linux')).toBe('allow')
    // …and with the allow stripped, the base ask stands.
    const auto = [
      ...rs,
      ...withoutAllowRules(compileClaudeRulesToOpencode(perms({ allow: ['Edit(.claude/**)'] })))
    ]
    expect(evaluateOpencodeRules('edit', '.claude/settings.json', auto, 'linux')).toBe('ask')
  })
})

describe('buildRuleset — other modes are unchanged by the agent-control asks', () => {
  it('default still asks for every edit with a single rule; plan still denies every edit', () => {
    const dflt = buildRuleset('default').filter((r) => r.permission === 'edit')
    expect(dflt).toEqual([{ permission: 'edit', pattern: '*', action: 'ask' }])
    const plan = buildRuleset('plan').filter((r) => r.permission === 'edit')
    expect(plan).toEqual([{ permission: 'edit', pattern: '*', action: 'deny' }])
  })
})

describe('buildAutoModeRuleset', () => {
  it('is the acceptEdits base with every edit asking (the host gate clears ordinary ones)', () => {
    const auto = buildAutoModeRuleset()
    expect(auto.filter((r) => r.permission === 'edit')).toEqual([
      { permission: 'edit', pattern: '*', action: 'ask' }
    ])
    expect(auto.filter((r) => r.permission !== 'edit')).toEqual(
      buildRuleset('acceptEdits').filter((r) => r.permission !== 'edit')
    )
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(evaluateOpencodeRules('edit', 'src/a.ts', auto, platform)).toBe('ask')
      expect(evaluateOpencodeRules('edit', '.GIT/config', auto, platform)).toBe('ask')
      expect(evaluateOpencodeRules('bash', 'ls', auto, platform)).toBe('ask')
      expect(evaluateOpencodeRules('read', 'src/a.ts', auto, platform)).toBe('allow')
    }
  })
})
