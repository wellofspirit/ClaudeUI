/**
 * The edit-auto-accepting bases (`acceptEdits`/`autoEdit`) ask for edits to
 * agent-control paths (ADR-084 §3); auto mode's base asks for every edit and
 * leaves the path test to the host-side gate (`agent-control-gate.ts`). Evaluated with the host-side port of opencode's own matcher
 * (`../wildcard.ts`, last-match-wins), on the path form opencode's edit tools
 * ask with: worktree-relative, `\` on Windows, absolute only across drives.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAutoModeRuleset,
  buildRuleset,
  opencodeWireRuleset,
  type PermissionRule
} from '../permission-ruleset'
import {
  evaluateOpencodeAsk,
  evaluateOpencodeRules,
  userDenyRule,
  wildcardMatch
} from '../wildcard'
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
  it('default still asks for every edit with a single rule; plan asks too (refused host-side, ADR-085 §3)', () => {
    const dflt = buildRuleset('default').filter((r) => r.permission === 'edit')
    expect(dflt).toEqual([{ permission: 'edit', pattern: '*', action: 'ask' }])
    const plan = buildRuleset('plan').filter((r) => r.permission === 'edit')
    expect(plan).toEqual([{ permission: 'edit', pattern: '*', action: 'ask' }])
  })
})

describe('buildRuleset(plan) — no server-side deny (ADR-085 §3)', () => {
  it('edit and task:general ask; nothing a task child could copy is a deny', () => {
    const plan = buildRuleset('plan')
    expect(plan).toContainEqual({ permission: 'edit', pattern: '*', action: 'ask' })
    expect(plan).toContainEqual({ permission: 'task', pattern: 'general', action: 'ask' })
    // A child copies every parent deny (`agent/subagent-permissions.ts`), and PATCH appends.
    expect(plan.filter((r) => r.action === 'deny')).toEqual([])
    // explore stays allowed via the baseline.
    expect(evaluateOpencodeRules('task', 'explore', plan, 'linux')).toBe('allow')
  })
})

describe('buildAutoModeRuleset — per-server MCP asks (ADR-085 §3)', () => {
  it('asks for each known server except claudeui, sanitised, never *_*', () => {
    const auto = buildAutoModeRuleset({ mcpServers: ['claudeui', 'lsphub', 'my server'] })
    const mcp = auto.filter((r) => r.permission.endsWith('_*'))
    expect(mcp).toEqual([
      { permission: 'lsphub_*', pattern: '*', action: 'ask' },
      { permission: 'my_server_*', pattern: '*', action: 'ask' }
    ])
    expect(auto.some((r) => r.permission === '*_*')).toBe(false)
    expect(auto.some((r) => r.permission.startsWith('claudeui'))).toBe(false)
    for (const platform of ['linux', 'win32'] as const) {
      expect(evaluateOpencodeRules('lsphub_find_refs', '*', auto, platform)).toBe('ask')
      expect(evaluateOpencodeRules('my_server_x', '*', auto, platform)).toBe('ask')
      // Hosted tools stay allowed; built-in keys with `_` are untouched.
      expect(evaluateOpencodeRules('claudeui_render_mermaid', '*', auto, platform)).toBe('allow')
      expect(evaluateOpencodeRules('external_directory', '/x/*', auto, platform)).toBe('allow')
    }
  })

  it('without servers it is unchanged; default and plan carry no MCP rule', () => {
    expect(buildAutoModeRuleset({ mcpServers: [] })).toEqual(buildAutoModeRuleset())
    for (const mode of ['default', 'plan', 'acceptEdits']) {
      const rs = buildRuleset(mode)
      expect(rs.some((r) => r.permission.endsWith('_*'))).toBe(false)
      expect(evaluateOpencodeRules('lsphub_find_refs', '*', rs, 'linux')).toBe('allow')
    }
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

describe('opencodeWireRuleset — no DeniedError dump (ADR-085 follow-up)', () => {
  const HOST = ['bash', 'edit', 'webfetch']
  const r = (permission: string, pattern: string, action: PermissionRule['action']) => ({
    permission,
    pattern,
    action
  })

  /**
   * opencode's `disabled()` (`vendor/opencode-src/packages/opencode/src/permission/index.ts`):
   * a tool is hidden when the LAST rule whose permission matches it has pattern `*` and denies.
   */
  const hidden = (tool: string, rules: readonly PermissionRule[]): boolean => {
    const rule = rules.findLast((x) => wildcardMatch(tool, x.permission, 'linux'))
    return rule?.pattern === '*' && rule.action === 'deny'
  }

  it('narrow host-decided denies become asks in place; whole-category denies move last, in order', () => {
    const input = [
      r('*', '*', 'allow'),
      r('bash', 'git push --force*', 'deny'),
      r('webfetch', '*', 'deny'),
      r('edit', 'secrets/**', 'deny'),
      r('read', '.env', 'deny'),
      r('bash', '* git push --force*', 'deny'),
      r('srv_*', '*', 'deny'),
      r('task', 'general', 'ask')
    ]
    const before = structuredClone(input)
    expect(opencodeWireRuleset(input, HOST)).toEqual([
      r('*', '*', 'allow'),
      r('bash', 'git push --force*', 'ask'),
      r('edit', 'secrets/**', 'ask'),
      r('read', '.env', 'deny'),
      r('bash', '* git push --force*', 'ask'),
      r('task', 'general', 'ask'),
      r('webfetch', '*', 'deny'),
      r('srv_*', '*', 'deny')
    ])
    expect(input).toEqual(before)
  })

  describe('the server plus the host refuse exactly what the session ruleset denies', () => {
    const user = compileClaudeRulesToOpencode(
      perms({
        allow: ['Bash(git:*)', 'Read'],
        deny: [
          'Bash(git push --force:*)',
          'Edit(secrets/**)',
          'WebFetch(domain:evil.example)',
          'Read(.env)'
        ],
        ask: ['Bash(docker run:*)']
      })
    )
    const session = [...buildRuleset('default'), ...user, r('claudeui_dispatch_agent', '*', 'ask')]
    const wire = opencodeWireRuleset(session, HOST)

    it('the wire carries no deny in a host-decided category, and keeps the read deny', () => {
      expect(wire.filter((x) => x.action === 'deny' && HOST.includes(x.permission))).toEqual([])
      const readDenies = user.filter((x) => x.permission === 'read' && x.action === 'deny')
      expect(readDenies.length).toBeGreaterThan(0)
      for (const rule of readDenies) expect(wire).toContainEqual(rule)
    })

    it.each([
      ['bash', 'git push origin main --force'],
      ['bash', 'sudo git push --force'],
      ['bash', 'git status'],
      ['bash', 'docker run alpine'],
      ['bash', 'hostname'],
      ['edit', 'secrets/key.pem'],
      ['edit', 'src/a.ts'],
      ['webfetch', 'https://evil.example/x'],
      ['webfetch', 'https://ok.example/x']
    ])('%s %s', (permission, pattern) => {
      const expected = evaluateOpencodeAsk(session, permission, [pattern], 'linux')
      const server = evaluateOpencodeAsk(wire, permission, [pattern], 'linux')
      const host = userDenyRule(user, permission, [pattern], 'linux')
      if (expected === 'deny') {
        // The server asks, so the host sees it — and refuses it with the rule.
        expect(server).toBe('ask')
        expect(host?.action).toBe('deny')
      } else {
        expect(server).toBe(expected)
        expect(host).toBeUndefined()
      }
    })

    it('a read the user denies is still denied server-side', () => {
      expect(evaluateOpencodeAsk(wire, 'read', ['.env'], 'linux')).toBe('deny')
    })
  })

  it('a whole-category deny hides the tool even when a narrower deny/ask of the same category follows it', () => {
    const user = compileClaudeRulesToOpencode(
      perms({ deny: ['Bash', 'Bash(rm -rf:*)', 'mcp__srv', 'Task'] })
    )
    const session = [...buildRuleset('default'), ...user, r('task', 'general', 'ask')]
    // Why the move matters: in place, the last bash rule is a broad glob, so
    // bash stays visible and `bash * deny` answers every call with the dump;
    // the backstop's `task general` ask likewise un-hides the task tool.
    expect(hidden('bash', session)).toBe(false)
    expect(hidden('task', session)).toBe(false)
    const wire = opencodeWireRuleset(session, HOST)
    for (const tool of ['bash', 'srv_lookup', 'task']) expect(hidden(tool, wire)).toBe(true)
    expect(hidden('edit', wire)).toBe(false)
  })
})
