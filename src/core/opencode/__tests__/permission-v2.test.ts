/**
 * opencode 2.x permission compilation (ADR-097 §3, S6): the ADR-022/085
 * compiler cases on the `{action, resource, effect}` shape and 2.x key table,
 * plus the session ruleset per mode, wire ordering and the wholly-denied
 * decision table. `v2ToolHidden` / `evaluateV2Call` are ports of 2.x's own
 * `whollyDisabled` / `evaluateInput`, so "hidden" and "denied" below mean what
 * the engine would do with the rules.
 */
import { describe, expect, it } from 'vitest'
import type { ClaudePermissions } from '../../../shared/types'
import { agentControlEditPatterns } from '../../automode/agent-control-paths'
import { broadBashGlobs } from '../broad-bash-globs'
import {
  CLAUDE_TOOL_TO_V2_ACTION,
  V1_DEAD_KEYS,
  v2ActionForV1Key,
  V2_BUILTIN_ACTIONS
} from '../permission-keys'
import {
  AUTO_MCP_CATCH_ALL,
  agentPermissionOverlay,
  opencodeOwnDirAllows,
  asHostPrecheckRules,
  buildSessionRuleset,
  compileClaudeRulesV2,
  DISPATCH_ASK_RULE,
  EXECUTE_DENY_RULE,
  modeGates,
  THROWAWAY_RULESET,
  withoutAllowRulesV2,
  withoutMutatingAllowRulesV2,
  wireOrder,
  type SessionRulesetInput,
  type V2Rule
} from '../permission-v2'
import { absoluteSpecifier, pathResources } from '../permission-paths'
import { evaluateV2Call, lastMatchingV2Rule, v2ToolHidden } from '../wildcard'

function perms(p: Partial<ClaudePermissions>): ClaudePermissions {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined, ...p }
}

const r = (action: string, effect: V2Rule['effect'], resource = '*'): V2Rule => ({
  action,
  resource,
  effect
})

const HOME = '/home/u'

describe('the 2.x key table', () => {
  it('maps every Claude tool 1.x mapped, under the 2.x action ids', () => {
    expect(CLAUDE_TOOL_TO_V2_ACTION).toMatchObject({
      Bash: 'shell',
      Read: 'read',
      NotebookRead: 'read',
      Edit: 'edit',
      MultiEdit: 'edit',
      Write: 'edit',
      NotebookEdit: 'edit',
      Glob: 'glob',
      Grep: 'grep',
      WebFetch: 'webfetch',
      WebSearch: 'websearch',
      Task: 'subagent',
      Agent: 'subagent',
      Skill: 'skill'
    })
    // LS compiled to the 1.x `list` key, which 2.x has no tool for.
    expect(CLAUDE_TOOL_TO_V2_ACTION.LS).toBeUndefined()
  })

  it('renames 1.x keys the way upstream migrates them, and drops the dead ones', () => {
    expect(v2ActionForV1Key('bash')).toBe('shell')
    expect(v2ActionForV1Key('task')).toBe('subagent')
    for (const key of ['write', 'patch', 'apply_patch', 'multiedit'])
      expect(v2ActionForV1Key(key)).toBe('edit')
    for (const key of V1_DEAD_KEYS) expect(v2ActionForV1Key(key)).toBeNull()
    expect(v2ActionForV1Key('read')).toBe('read')
    expect(v2ActionForV1Key('lsphub_find')).toBe('lsphub_find')
  })

  it('no 2.x action the compiler emits is a dead key', () => {
    for (const action of Object.values(CLAUDE_TOOL_TO_V2_ACTION)) {
      expect(V1_DEAD_KEYS).not.toContain(action)
      expect(V2_BUILTIN_ACTIONS).toContain(action)
    }
  })
})

describe('compileClaudeRulesV2 — ADR-022 cases on the 2.x shape', () => {
  const compile = (p: Partial<ClaudePermissions>, opts = {}) =>
    compileClaudeRulesV2(perms(p), { home: HOME, ...opts })

  it('maps tool names to 2.x actions and emits allow→ask→deny order', () => {
    expect(
      compile({
        allow: ['Bash(git diff:*)', 'Read'],
        ask: ['WebFetch(domain:example.com)'],
        deny: ['Edit(secrets/**)']
      })
    ).toEqual([
      r('shell', 'allow', 'git diff*'),
      r('read', 'allow'),
      ...['http', 'https'].flatMap((scheme) =>
        ['', '/*', ':*', '#*'].map((tail) => r('webfetch', 'ask', `${scheme}://example.com${tail}`))
      ),
      r('edit', 'deny', 'secrets/**')
    ])
  })

  it('Write/MultiEdit/NotebookEdit all compile to `edit`', () => {
    const out = compile({ allow: ['Write(dist/**)', 'MultiEdit', 'NotebookEdit'] })
    expect(out).toEqual([r('edit', 'allow', 'dist/**'), r('edit', 'allow')])
  })

  it('Task and Agent compile to `subagent` with the agent id as the resource', () => {
    expect(compile({ deny: ['Task(general)'], ask: ['Agent'] })).toEqual([
      r('subagent', 'ask'),
      r('subagent', 'deny', 'general')
    ])
  })

  it('skips unmappable tools (LS included) rather than guessing; MCP rules compile to keys', () => {
    expect(compile({ allow: ['mcp__server__tool', 'SomeUnknownTool', 'LS', 'Bash'] })).toEqual([
      r('server_tool', 'allow'),
      r('shell', 'allow')
    ])
  })

  it('additionalDirectories → external_directory allows on the `<dir>/*` resource 2.x asks with', () => {
    expect(compile({ additionalDirectories: ['/extra', '/trail/', '~/notes'] })).toEqual([
      r('external_directory', 'allow', '/extra/*'),
      r('external_directory', 'allow', '/trail/*'),
      r('external_directory', 'allow', `${HOME}/notes/*`)
    ])
  })

  it('a Windows additional directory is sent with forward slashes (2.x resources are slashed)', () => {
    expect(compile({ additionalDirectories: ['D:\\extra'] })).toEqual([
      r('external_directory', 'allow', 'D:/extra/*')
    ])
    // …and still matches the ask on win32 (both sides normalise).
    const rules = compile({ additionalDirectories: ['D:\\extra'] })
    expect(evaluateV2Call(rules, 'external_directory', ['D:/extra/sub/*'], 'win32')).toBe('allow')
  })

  it('deny is emitted last so it wins under last-match-wins', () => {
    const out = compile({ allow: ['Edit(src/**)'], deny: ['Edit(src/secret.ts)'] })
    expect(out[0]).toEqual(r('edit', 'allow', 'src/**'))
    expect(out.at(-1)).toEqual(r('edit', 'deny', 'src/secret.ts'))
    expect(evaluateV2Call(out, 'edit', ['src/secret.ts'], 'linux')).toBe('deny')
    expect(evaluateV2Call(out, 'edit', ['src/ok.ts'], 'linux')).toBe('allow')
  })

  it('empty permissions → empty ruleset', () => {
    expect(compile({})).toEqual([])
  })
})

describe('compileClaudeRulesV2 — path specifiers (2.x asks relative inside the session dir, absolute outside)', () => {
  const compile = (p: Partial<ClaudePermissions>, cwd?: string) =>
    compileClaudeRulesV2(perms(p), { home: HOME, cwd })

  it('`~/x` expands to the home (2.x expands `~` only in its own config, never in a session rule)', () => {
    const rules = compile({ deny: ['Read(~/.ssh/**)'] })
    expect(rules).toEqual([r('read', 'deny', `${HOME}/.ssh/**`)])
    expect(evaluateV2Call(rules, 'read', [`${HOME}/.ssh/id_ed25519`], 'linux')).toBe('deny')
  })

  it('`//abs` is the absolute path; `./x` the relative one; `/x` and globs pass through', () => {
    expect(
      compile({ deny: ['Edit(//etc/hosts)', 'Edit(./build/**)', 'Edit(/src/**)', 'Read(*.pem)'] })
    ).toEqual([
      r('edit', 'deny', '/etc/hosts'),
      r('edit', 'deny', 'build/**'),
      r('edit', 'deny', '/src/**'),
      r('read', 'deny', '*.pem')
    ])
  })

  it('an absolute deny under the session dir also compiles to its location-relative form', () => {
    const rules = compile({ deny: ['Edit(//work/proj/secrets/**)'] }, '/work/proj')
    expect(rules).toEqual(
      expect.arrayContaining([
        r('edit', 'deny', '/work/proj/secrets/**'),
        r('edit', 'deny', 'secrets/**')
      ])
    )
    // 2.x asks with `secrets/a.txt` for a file inside the session directory.
    expect(evaluateV2Call(rules, 'edit', ['secrets/a.txt'], 'linux')).toBe('deny')
    // Outside it, the absolute path.
    expect(evaluateV2Call(rules, 'edit', ['/work/proj/secrets/a.txt'], 'linux')).toBe('deny')
    expect(
      evaluateV2Call(
        compile({ deny: ['Edit(//other/x)'] }, '/work/proj'),
        'edit',
        ['/other/x'],
        'linux'
      )
    ).toBe('deny')
  })

  it('glob/grep specifiers are PATTERN arguments, not paths: verbatim', () => {
    expect(compile({ deny: ['Glob(~/x)', 'Grep(//y)'] })).toEqual([
      r('glob', 'deny', '~/x'),
      r('grep', 'deny', '//y')
    ])
  })
})

describe('compileClaudeRulesV2 — broad shell deny/ask globs (ADR-085 §3)', () => {
  it.each(['linux', 'win32'] as const)(
    'a broader allow does not answer a reordered form of a narrower deny (%s)',
    (platform) => {
      const rules = compileClaudeRulesV2(
        perms({ allow: ['Bash(git:*)'], deny: ['Bash(git push --force:*)'] })
      )
      expect(evaluateV2Call(rules, 'shell', ['git push origin main --force'], platform)).toBe(
        'deny'
      )
      expect(evaluateV2Call(rules, 'shell', ['git status'], platform)).toBe('allow')
    }
  )

  it.each(['linux', 'win32'] as const)(
    'nor a reordered form of a narrower ask (%s)',
    (platform) => {
      const rules = compileClaudeRulesV2(
        perms({ allow: ['Bash(docker:*)'], ask: ['Bash(docker run:*)'] })
      )
      expect(evaluateV2Call(rules, 'shell', ['docker --context x run alpine'], platform)).toBe(
        'ask'
      )
      expect(evaluateV2Call(rules, 'shell', ['docker build -t runtime .'], platform)).toBe('allow')
    }
  )

  it('a deny/ask compiles to its verbatim resource, then the broad globs, all in its tier', () => {
    const out = compileClaudeRulesV2(
      perms({ ask: ['Bash(docker run:*)'], deny: ['Bash(git push --force:*)'] })
    )
    const ask = out.filter((x) => x.effect === 'ask').map((x) => x.resource)
    const deny = out.filter((x) => x.effect === 'deny').map((x) => x.resource)
    expect(ask).toEqual(['docker run*', ...broadBashGlobs('docker run:*')])
    expect(deny).toEqual(['git push --force*', ...broadBashGlobs('git push --force:*')])
    expect(new Set(deny).size).toBe(deny.length)
    expect(out.every((x) => x.action === 'shell')).toBe(true)
  })

  it('a shell allow stays verbatim (broadening an allow is an over-grant); bare Bash is one `*`', () => {
    expect(compileClaudeRulesV2(perms({ allow: ['Bash(git push --force:*)'] }))).toEqual([
      r('shell', 'allow', 'git push --force*')
    ])
    expect(compileClaudeRulesV2(perms({ deny: ['Bash'] }))).toEqual([r('shell', 'deny')])
  })

  it('a multi-statement ask is denied when ANY statement resource is denied (2.x evaluates each)', () => {
    const rules = compileClaudeRulesV2(perms({ deny: ['Bash(rm -rf:*)'] }))
    expect(evaluateV2Call(rules, 'shell', ['ls', 'rm -rf /tmp/x'], 'linux')).toBe('deny')
  })
})

describe('compileClaudeRulesV2 — MCP rules (ADR-085 §3)', () => {
  const compile = (p: Partial<ClaudePermissions>, mcpServers?: string[]) =>
    compileClaudeRulesV2(perms(p), mcpServers ? { mcpServers } : {})

  it('tool level → the exact action in every tier (a specifier is ignored)', () => {
    expect(
      compile({
        allow: ['mcp__lsphub__find_refs'],
        ask: ['mcp__lsphub__rename(x)'],
        deny: ['mcp__lsphub__delete_all']
      })
    ).toEqual([
      r('lsphub_find_refs', 'allow'),
      r('lsphub_rename', 'ask'),
      r('lsphub_delete_all', 'deny')
    ])
  })

  it('server level deny/ask → `s_*`, known server or not; allow only for a live server', () => {
    expect(compile({ ask: ['mcp__jira'], deny: ['mcp__lsphub__*'] })).toEqual([
      r('jira_*', 'ask'),
      r('lsphub_*', 'deny')
    ])
    expect(compile({ allow: ['mcp__lsphub', 'mcp__other__*'] }, ['lsphub'])).toEqual([
      r('lsphub_*', 'allow')
    ])
    expect(compile({ allow: ['mcp__lsphub'] })).toEqual([])
  })

  it('a server-level allow whose glob hits a 2.x built-in action is skipped; its deny is emitted', () => {
    // `opencode_*` would grant `opencode_read_mcp_resource`; `external_*` `external_directory`.
    expect(compile({ allow: ['mcp__opencode'] }, ['opencode'])).toEqual([])
    expect(compile({ allow: ['mcp__external'] }, ['external'])).toEqual([])
    expect(compile({ deny: ['mcp__external'] }, ['external'])).toEqual([r('external_*', 'deny')])
    // A 1.x-only name no longer collides (`doom_loop` is gone in 2.x).
    expect(compile({ allow: ['mcp__doom'] }, ['doom'])).toEqual([r('doom_*', 'allow')])
  })

  it('names are sanitised like 2.x `McpTool.name` (`[^a-zA-Z0-9_-]` → `_`)', () => {
    expect(compile({ deny: ['mcp__a b__x.y'] })).toEqual([r('a_b_x_y', 'deny')])
  })

  it('a user MCP deny beats an earlier server-level allow', () => {
    const rules = compile({ allow: ['mcp__lsphub'], deny: ['mcp__lsphub__delete_all'] }, ['lsphub'])
    expect(evaluateV2Call(rules, 'lsphub_delete_all', ['*'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'lsphub_find_refs', ['*'], 'linux')).toBe('allow')
  })
})

describe('withoutAllowRulesV2 / withoutMutatingAllowRulesV2', () => {
  const user = compileClaudeRulesV2(
    perms({
      allow: ['Bash(git:*)', 'Edit(src/**)', 'Task(general)', 'Read', 'WebFetch', 'mcp__s__t'],
      ask: ['Bash(docker run:*)'],
      deny: ['Bash(git push --force:*)'],
      additionalDirectories: ['/extra']
    })
  )

  it('auto: every user allow goes, asks and denies stay — the additionalDirectories allows stay too', () => {
    const out = withoutAllowRulesV2(user)
    expect(out.filter((x) => x.effect === 'allow')).toEqual([
      r('external_directory', 'allow', '/extra/*')
    ])
    expect(out.filter((x) => x.effect !== 'allow')).toEqual(
      user.filter((x) => x.effect !== 'allow')
    )
  })

  it('plan: exactly the edit, shell and subagent allows go', () => {
    const out = withoutMutatingAllowRulesV2(user)
    expect(out.filter((x) => x.effect === 'allow').map((x) => x.action)).toEqual([
      'read',
      'webfetch',
      's_t',
      'external_directory'
    ])
    expect(out.filter((x) => x.effect !== 'allow')).toEqual(
      user.filter((x) => x.effect !== 'allow')
    )
  })

  it('neither mutates its input (the host keeps the full user set for provenance)', () => {
    const copy = structuredClone(user)
    withoutAllowRulesV2(user)
    withoutMutatingAllowRulesV2(user)
    expect(user).toEqual(copy)
  })
})

describe('wireOrder — whole-category denies last (re-verified for 2.x `whollyDisabled`)', () => {
  it('moves only `resource:"*"` denies to the end, keeping their order; narrow denies stay put', () => {
    const rules = [
      r('shell', 'ask'),
      r('shell', 'deny'),
      r('edit', 'deny', 'secrets/**'),
      r('lsphub_*', 'deny'),
      r('shell', 'ask', 'git*')
    ]
    expect(wireOrder(rules)).toEqual([
      r('shell', 'ask'),
      r('edit', 'deny', 'secrets/**'),
      r('shell', 'ask', 'git*'),
      r('shell', 'deny'),
      r('lsphub_*', 'deny')
    ])
  })

  it('without it a later narrow rule keeps a wholly denied tool visible; with it the tool is hidden', () => {
    const rules = [r('shell', 'deny'), r('shell', 'ask', 'git*')]
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(false)
    expect(v2ToolHidden(wireOrder(rules), 'shell', 'linux')).toBe(true)
    // Only tightening: every call is denied either way.
    expect(evaluateV2Call(wireOrder(rules), 'shell', ['git push'], 'linux')).toBe('deny')
  })
})

describe('modeGates', () => {
  it('default (and ask / bypassPermissions / unknown / auto with the classifier off): shell, edit, webfetch ask', () => {
    const gated = [r('shell', 'ask'), r('edit', 'ask'), r('webfetch', 'ask')]
    for (const mode of ['default', 'ask', 'bypassPermissions', 'whatever'])
      expect(modeGates(mode)).toEqual(gated)
    expect(modeGates('auto', { autoMode: false })).toEqual(gated)
    expect(modeGates('full')).toEqual(gated)
  })

  it('acceptEdits: shell and webfetch ask, edits only on the agent-control paths', () => {
    expect(modeGates('acceptEdits')).toEqual([
      r('shell', 'ask'),
      r('webfetch', 'ask'),
      ...agentControlEditPatterns().map((p) => r('edit', 'ask', p))
    ])
    expect(modeGates('autoEdit')).toEqual(modeGates('acceptEdits'))
  })

  it('auto (classifier on): every edit asks, every MCP tool asks via the `*_*` catch-all, claudeui allowed', () => {
    const own = [r('external_directory', 'allow', '/data/opencode/tool-output/*')]
    expect(modeGates('auto', { autoMode: true, externalDirAllows: own })).toEqual([
      r('shell', 'ask'),
      r('webfetch', 'ask'),
      r('edit', 'ask'),
      AUTO_MCP_CATCH_ALL,
      r('claudeui_*', 'allow'),
      r('external_directory', 'ask'),
      ...own
    ])
  })

  it('no mode carries a catch-all allow (the agent supplies the baseline; children keep their own narrowing)', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto'])
      for (const autoMode of [false, true])
        expect(
          modeGates(mode, { autoMode }).some(
            (x) =>
              x.effect === 'allow' &&
              (x.action === '*' || x.resource === '*') &&
              x.action !== 'claudeui_*'
          )
        ).toBe(false)
  })
})

describe('buildSessionRuleset', () => {
  const input = (over: Partial<SessionRulesetInput> = {}): SessionRulesetInput => ({
    mode: 'default',
    autoMode: false,
    permissions: perms({}),
    mcpServers: ['claudeui'],
    home: HOME,
    ...over
  })

  it('default: gates, user rules, the Code Mode deny last, the dispatch ask after the user rules', () => {
    const { rules, userRules, agent } = buildSessionRuleset(
      input({ permissions: perms({ allow: ['Bash(npm test)'] }) })
    )
    expect(agent).toBeUndefined()
    expect(userRules).toEqual([r('shell', 'allow', 'npm test')])
    expect(rules).toEqual([
      r('shell', 'ask'),
      r('edit', 'ask'),
      r('webfetch', 'ask'),
      r('shell', 'allow', 'npm test'),
      DISPATCH_ASK_RULE,
      EXECUTE_DENY_RULE
    ])
  })

  it('a user allow for the dispatch tool cannot un-gate it', () => {
    const { rules } = buildSessionRuleset(
      input({ permissions: perms({ allow: ['mcp__claudeui__dispatch_agent'] }) })
    )
    expect(evaluateV2Call(rules, 'claudeui_dispatch_agent', ['*'], 'linux')).toBe('ask')
  })

  it('auto: user allows are withheld from the server but kept in `userRules`', () => {
    const permissions = perms({ allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] })
    const { rules, userRules } = buildSessionRuleset(
      input({ mode: 'auto', autoMode: true, permissions, mcpServers: ['claudeui', 'jira'] })
    )
    expect(rules.filter((x) => x.effect === 'allow')).toEqual([r('claudeui_*', 'allow')])
    expect(userRules.some((x) => x.effect === 'allow')).toBe(true)
    expect(evaluateV2Call(rules, 'shell', ['git status'], 'linux')).toBe('ask')
    expect(evaluateV2Call(rules, 'jira_create', ['*'], 'linux')).toBe('ask')
    expect(evaluateV2Call(rules, 'shell', ['rm x'], 'linux')).toBe('deny')
  })

  it('auto with the classifier off is gated like default (never allow-all)', () => {
    const { rules } = buildSessionRuleset(input({ mode: 'full', autoMode: false }))
    expect(evaluateV2Call(rules, 'edit', ['a.ts'], 'linux')).toBe('ask')
  })

  it('plan: the plan agent, edit wholly denied, `general` denied — a user rule cannot re-open them', () => {
    const permissions = perms({
      allow: ['Edit', 'Bash(git:*)', 'Task(general)', 'Read'],
      ask: ['Edit(docs/**)', 'Task']
    })
    const { rules, agent } = buildSessionRuleset(input({ mode: 'plan', permissions }))
    expect(agent).toBe('plan')
    expect(v2ToolHidden(rules, 'edit', 'linux')).toBe(true)
    expect(evaluateV2Call(rules, 'edit', ['docs/a.md'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'subagent', ['general'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'subagent', ['explore'], 'linux')).toBe('ask')
    // Shell asks; the host judges read-only-ness per command (and applies the git allow there).
    expect(evaluateV2Call(rules, 'shell', ['git status'], 'linux')).toBe('ask')
    expect(evaluateV2Call(rules, 'read', ['a.ts'], 'linux')).toBe('allow')
  })

  it('equal input → equal output (the caller can skip an unchanged PATCH)', () => {
    const a = buildSessionRuleset(input({ permissions: perms({ deny: ['Bash(rm:*)'] }) }))
    const b = buildSessionRuleset(input({ permissions: perms({ deny: ['Bash(rm:*)'] }) }))
    expect(JSON.stringify(a.rules)).toBe(JSON.stringify(b.rules))
  })

  it('every mode: `execute` (Code Mode, ungated fetch) is hidden; no narrow deny became an ask', () => {
    const permissions = perms({ deny: ['Bash(git push --force:*)', 'Edit(secrets/**)'] })
    for (const [mode, autoMode] of [
      ['default', false],
      ['acceptEdits', false],
      ['plan', false],
      ['auto', true],
      ['auto', false]
    ] as const) {
      const { rules } = buildSessionRuleset(input({ mode, autoMode, permissions }))
      expect(v2ToolHidden(rules, 'execute', 'linux')).toBe(true)
      expect(rules).toContainEqual(r('shell', 'deny', 'git push --force*'))
      expect(evaluateV2Call(rules, 'shell', ['git push origin main --force'], 'linux')).toBe('deny')
    }
  })
})

describe('the wholly-denied decision table', () => {
  const build = (p: Partial<ClaudePermissions>, mode = 'default', mcpServers = ['claudeui']) =>
    buildSessionRuleset({
      mode,
      autoMode: mode === 'auto',
      permissions: perms(p),
      mcpServers,
      home: HOME
    }).rules

  it.each([
    ['Bash', 'shell'],
    ['Edit', 'edit'],
    ['Write', 'edit'],
    ['WebFetch', 'webfetch'],
    ['WebSearch', 'websearch'],
    ['Read', 'read'],
    ['Glob', 'glob'],
    ['Grep', 'grep'],
    ['Task', 'subagent'],
    ['Skill', 'skill'],
    ['mcp__lsphub__delete_all', 'lsphub_delete_all'],
    ['mcp__lsphub', 'lsphub_find_refs']
  ])('a user deny on the whole tool `%s` hides `%s` (Claude Code parity)', (claude, toolId) => {
    // A later narrow ask or allow on the same tool must not keep it visible.
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto'])
      expect(
        v2ToolHidden(
          build({ deny: [claude], ask: [`${claude}(x)`], allow: [`${claude}(y)`] }, mode, [
            'claudeui',
            'lsphub'
          ]),
          toolId,
          'linux'
        )
      ).toBe(true)
  })

  it('a NARROW user deny keeps the tool visible and denies the call server-side (not an ask)', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) {
      const rules = build({ deny: ['Bash(rm:*)', 'WebFetch(domain:evil.example)'] }, mode)
      expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(false)
      expect(evaluateV2Call(rules, 'shell', ['rm -rf x'], 'linux')).toBe('deny')
      expect(v2ToolHidden(rules, 'webfetch', 'linux')).toBe(false)
      expect(evaluateV2Call(rules, 'webfetch', ['https://evil.example/x'], 'linux')).toBe('deny')
    }
  })

  it('mode gates never hide a tool; plan mode hides edit/write/patch only', () => {
    for (const mode of ['default', 'acceptEdits', 'auto']) {
      const rules = build({}, mode)
      for (const tool of ['shell', 'edit', 'webfetch', 'read', 'subagent', 'question'])
        expect(v2ToolHidden(rules, tool, 'linux')).toBe(false)
    }
    const plan = build({}, 'plan')
    expect(v2ToolHidden(plan, 'edit', 'linux')).toBe(true)
    for (const tool of ['shell', 'webfetch', 'read', 'subagent', 'question'])
      expect(v2ToolHidden(plan, tool, 'linux')).toBe(false)
  })

  it('the throwaway ruleset hides every tool', () => {
    for (const tool of ['shell', 'edit', 'read', 'question', 'subagent', 'execute', 'x_y'])
      expect(v2ToolHidden(THROWAWAY_RULESET, tool, 'linux')).toBe(true)
  })
})

describe('agentPermissionOverlay (the S2 `agents.<name>.permissions` seam)', () => {
  it('only the built-in `plan` agent, denying the `general` subagent (kept out of its list)', () => {
    expect(agentPermissionOverlay()).toEqual({ plan: [r('subagent', 'deny', 'general')] })
  })
})

describe('asHostPrecheckRules', () => {
  it('is the same rule in the host pre-check shape, matched by the same globs', () => {
    const rules = [r('shell', 'deny', 'rm *'), r('edit', 'ask')]
    const host = asHostPrecheckRules(rules)
    expect(host).toEqual([
      { permission: 'shell', pattern: 'rm *', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'ask' }
    ])
    expect(lastMatchingV2Rule('shell', 'rm -rf x', rules, 'linux')).toEqual(rules[0])
  })
})

// ── Review fixes (2026-10-06) ────────────────────────────────────────────────

describe('path deny/ask rules cover every spelling 2.x asks with (review #1)', () => {
  // What the engine evaluates: the agent's defaults, then the session's rules.
  const AGENT = [r('*', 'allow'), r('external_directory', 'ask'), r('read', 'ask', '*.env')]
  const evalIn = (
    p: Partial<ClaudePermissions>,
    action: string,
    resource: string,
    cwd: string,
    extra: Partial<SessionRulesetInput> = {}
  ) =>
    evaluateV2Call(
      [
        ...AGENT,
        ...buildSessionRuleset({
          mode: 'acceptEdits',
          autoMode: false,
          permissions: perms(p),
          mcpServers: ['claudeui'],
          home: HOME,
          cwd,
          ...extra
        }).rules
      ],
      action,
      [resource],
      'darwin'
    )

  // The review probe's cases (`.cache/review-s4s6/probe-paths.ts`): each was `allow` before.
  it.each([
    ['Read(//repo/secrets/**)', 'read', '../secrets/k.pem', '/repo/pkg'],
    ['Edit(//repo/secrets/**)', 'edit', '../secrets/k.pem', '/repo/pkg'],
    ['Read(/secrets/**)', 'read', 'secrets/k.pem', '/repo'],
    ['Read(**/creds.json)', 'read', 'creds.json', '/repo'],
    ['Edit(//**/prod.yaml)', 'edit', 'cfg/prod.yaml', '/repo'],
    ['Read(//repo/secrets/**)', 'read', 'secrets/k.pem', '/repo']
  ])('deny %s blocks %s %s with cwd %s', (rule, action, resource, cwd) => {
    expect(evalIn({ deny: [rule] }, action, resource, cwd)).toBe('deny')
  })

  it('a worktree two levels up, an absolute or settings-relative rule, and the absolute form itself', () => {
    const cwd = '/repo/apps/web'
    expect(evalIn({ deny: ['Edit(//repo/secrets/**)'] }, 'edit', '../../secrets/k', cwd)).toBe(
      'deny'
    )
    expect(evalIn({ deny: ['Edit(//repo/secrets/**)'] }, 'edit', '/repo/secrets/k', cwd)).toBe(
      'deny'
    )
    // `/x` is relative to the project: the worktree root, when the caller knows it.
    expect(
      evalIn({ deny: ['Read(/secrets/**)'] }, 'read', '../../secrets/k', cwd, { worktree: '/repo' })
    ).toBe('deny')
    // …and the session directory either way.
    expect(evalIn({ deny: ['Read(/local/**)'] }, 'read', 'local/x', cwd)).toBe('deny')
  })

  it('`**/` also matches zero directories, at the start or in the middle', () => {
    expect(evalIn({ deny: ['Read(**/creds.json)'] }, 'read', 'a/b/creds.json', '/repo')).toBe(
      'deny'
    )
    expect(evalIn({ deny: ['Edit(src/**/gen.ts)'] }, 'edit', 'src/gen.ts', '/repo')).toBe('deny')
    expect(evalIn({ deny: ['Edit(//**/prod.yaml)'] }, 'edit', 'prod.yaml', '/repo/pkg')).toBe(
      'deny'
    )
    expect(
      evalIn({ deny: ['Edit(//**/prod.yaml)'] }, 'edit', '../cfg/prod.yaml', '/repo/pkg')
    ).toBe('deny')
    expect(evalIn({ deny: ['Edit(//**/prod.yaml)'] }, 'edit', '/etc/prod.yaml', '/repo/pkg')).toBe(
      'deny'
    )
  })

  it('ask rules are just as conservative', () => {
    expect(evalIn({ ask: ['Read(//repo/secrets/**)'] }, 'read', '../secrets/k', '/repo/pkg')).toBe(
      'ask'
    )
  })

  it('the extra forms deny nothing else: a same-named dir under the cwd is not the repo’s', () => {
    expect(evalIn({ deny: ['Edit(//repo/secrets/**)'] }, 'edit', 'secrets/x', '/repo/pkg')).toBe(
      'allow'
    )
  })

  it('a Windows drive path: backslashes, drive root, case folded on win32', () => {
    const resources = pathResources(
      'C:\\Repo\\secrets\\**',
      { cwd: 'c:/repo/pkg', caseInsensitive: true },
      true
    )
    expect(resources).toEqual(expect.arrayContaining(['C:/Repo/secrets/**', '../secrets/**']))
    expect(
      evaluateV2Call(
        resources.map((x) => r('edit', 'deny', x)),
        'edit',
        ['../secrets/k'],
        'win32'
      )
    ).toBe('deny')
  })

  it('allows stay precise: never widened to `../` forms, zero-dir forms or a resolved `/x`', () => {
    expect(
      compileClaudeRulesV2(perms({ allow: ['Edit(//repo/src/**)', 'Read(**/x)', 'Read(/y)'] }), {
        cwd: '/repo/pkg',
        home: HOME,
        worktree: '/repo'
      })
    ).toEqual([
      r('edit', 'allow', '/repo/src/**'),
      r('read', 'allow', '**/x'),
      r('read', 'allow', '/y')
    ])
  })
})

describe('MCP allows never land on a built-in action (review #9)', () => {
  it('a tool-level allow whose action is a built-in is refused; its deny is kept', () => {
    expect(
      compileClaudeRulesV2(
        perms({ allow: ['mcp__external__directory', 'mcp__opencode__models'] }),
        {
          mcpServers: ['external', 'opencode']
        }
      )
    ).toEqual([])
    expect(compileClaudeRulesV2(perms({ deny: ['mcp__external__directory'] }))).toEqual([
      r('external_directory', 'deny')
    ])
    // An ordinary tool-level allow is unaffected.
    expect(compileClaudeRulesV2(perms({ allow: ['mcp__lsphub__find'] }))).toEqual([
      r('lsphub_find', 'allow')
    ])
  })
})

describe('auto mode (review #10)', () => {
  // What the engine evaluates: the agent's own baseline first, then the session's rules.
  const BASELINE = [r('*', 'allow'), r('external_directory', 'ask')]
  const auto = (p: Partial<ClaudePermissions> = {}, extra: Partial<SessionRulesetInput> = {}) => [
    ...BASELINE,
    ...buildSessionRuleset({
      mode: 'auto',
      autoMode: true,
      permissions: perms(p),
      mcpServers: ['claudeui'],
      home: HOME,
      ...extra
    }).rules
  ]

  it('(a) the additionalDirectories allows survive the allow strip', () => {
    const rules = auto({ additionalDirectories: ['/extra'], allow: ['Read'] })
    expect(evaluateV2Call(rules, 'external_directory', ['/extra/sub/*'], 'linux')).toBe('allow')
    expect(evaluateV2Call(rules, 'external_directory', ['/other/*'], 'linux')).toBe('ask')
  })

  it('(b) an MCP server unknown when the rules were built asks; claudeui tools stay allowed, dispatch asks', () => {
    const rules = auto()
    expect(evaluateV2Call(rules, 'late_server_tool', ['*'], 'linux')).toBe('ask')
    expect(evaluateV2Call(rules, 'my-srv_do', ['*'], 'linux')).toBe('ask')
    expect(evaluateV2Call(rules, 'claudeui_render_mermaid', ['*'], 'linux')).toBe('allow')
    expect(evaluateV2Call(rules, 'claudeui_dispatch_agent', ['*'], 'linux')).toBe('ask')
    // A user MCP deny still wins; built-ins without `_` are untouched by the catch-all.
    expect(evaluateV2Call(auto({ deny: ['mcp__late'] }), 'late_x', ['*'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'read', ['a.ts'], 'linux')).toBe('allow') // the agent's baseline
  })

  it("(b) opencode's own directories stay allowed when the agent's allows are passed in", () => {
    const agent = [
      r('*', 'allow'),
      r('external_directory', 'ask'),
      r('external_directory', 'allow', '/data/opencode/tool-output/*'),
      r('external_directory', 'allow', '*')
    ]
    const own = opencodeOwnDirAllows(agent)
    expect(own).toEqual([r('external_directory', 'allow', '/data/opencode/tool-output/*')])
    const rules = auto({}, { externalDirAllows: own })
    expect(
      evaluateV2Call(rules, 'external_directory', ['/data/opencode/tool-output/*'], 'linux')
    ).toBe('allow')
    expect(evaluateV2Call(rules, 'external_directory', ['/etc/*'], 'linux')).toBe('ask')
  })
})

describe('Windows absolute rules: `//c/x` is the canonical drive form (cli.js `ht`/`GSt`)', () => {
  const win = { cwd: 'C:/repo/pkg', worktree: 'C:/repo', home: HOME, platform: 'win32' } as const

  it.each(['//c/repo/secrets/**', '//C:/repo/secrets/**', 'C:\\repo\\secrets\\**'])(
    'win32: deny %s covers the drive form and the worktree-relative form',
    (spec) => {
      const resources = pathResources(spec, win, true)
      expect(resources).toEqual(expect.arrayContaining(['C:/repo/secrets/**', '../secrets/**']))
      // Nothing keeps the `/c/…` spelling that no 2.x ask can produce.
      expect(resources.some((x) => x.startsWith('/c/') || x.startsWith('/C:'))).toBe(false)
    }
  )

  it('win32: the bare drive `//c` is the drive root', () => {
    expect(absoluteSpecifier('//c', HOME, 'win32')).toBe('C:/')
    expect(absoluteSpecifier('//c/', HOME, 'win32')).toBe('C:/')
    expect(absoluteSpecifier('//d/x/y', HOME, 'win32')).toBe('D:/x/y')
  })

  it('win32: a multi-letter first segment is a POSIX-style path, not a drive', () => {
    expect(absoluteSpecifier('//cc/x', HOME, 'win32')).toBe('/cc/x')
  })

  it('POSIX: `//c/x` stays `/c/x`', () => {
    expect(absoluteSpecifier('//c/x', HOME, 'darwin')).toBe('/c/x')
    expect(absoluteSpecifier('//c/x', HOME, 'linux')).toBe('/c/x')
    expect(pathResources('//c/x', { ...win, platform: 'darwin', cwd: '/proj' }, true)).toContain(
      '/c/x'
    )
  })

  it('an allow keeps its own (drive) spelling plus the relative form under the cwd', () => {
    expect(pathResources('//c/repo/pkg/src/**', win, false)).toEqual([
      'C:/repo/pkg/src/**',
      'src/**'
    ])
  })

  it('buildSessionRuleset: the deny blocks the resources 2.x asks with on Windows', () => {
    const { rules } = buildSessionRuleset({
      mode: 'acceptEdits',
      autoMode: false,
      permissions: perms({ deny: ['Edit(//c/repo/secrets/**)'] }),
      mcpServers: ['claudeui'],
      ...win
    })
    const all = [r('*', 'allow'), ...rules]
    // Inside the worktree, outside the `C:/repo/pkg` session directory.
    expect(evaluateV2Call(all, 'edit', ['../secrets/k.pem'], 'win32')).toBe('deny')
    // Outside the worktree: asked by its absolute path (drive case does not matter).
    expect(evaluateV2Call(all, 'edit', ['C:/repo/secrets/k.pem'], 'win32')).toBe('deny')
    expect(evaluateV2Call(all, 'edit', ['c:/repo/secrets/k.pem'], 'win32')).toBe('deny')
    expect(evaluateV2Call(all, 'edit', ['../src/k.ts'], 'win32')).toBe('allow')
  })

  it('compileClaudeRulesV2: additionalDirectories accept `//c/x` on win32', () => {
    expect(
      compileClaudeRulesV2(perms({ additionalDirectories: ['//c/shared'] }), {
        platform: 'win32'
      })
    ).toEqual([r('external_directory', 'allow', 'C:/shared/*')])
  })
})
