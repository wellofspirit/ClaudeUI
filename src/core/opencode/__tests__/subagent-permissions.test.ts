/**
 * @vitest-environment node
 *
 * ADR-085 S4 — per-agent static asks for opencode task subagents, and the
 * parent-side `task:<name>` backstop. Synthetic agents and rules only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import {
  agentWhollyDenies,
  buildSubagentPermissionConfig,
  evaluateChildCall,
  categoryMayAllow,
  childSessionRuleset,
  CHILD_GATED_CATEGORIES,
  subagentBackstopRules,
  subagentPermissionConfigFor,
  TASK_BACKSTOP_FAIL_CLOSED_RULE,
  type SubagentScanEntry,
  type V1AgentRow as OpencodeAgentInfo
} from '../subagent-permissions'
import { buildSessionRuleset, wireOrder, type V2Rule } from '../permission-v2'
import { evaluateV2Call, v2ToolHidden } from '../wildcard'
import { mergeDeep, withToolsPermission } from '../opencode-config-permissions'
import type { OpencodePermissionRule } from '../permission-compiler'

const r = (permission: string, pattern: string, action: 'allow' | 'ask' | 'deny') =>
  ({ permission, pattern, action }) as OpencodePermissionRule

const GENERAL: SubagentScanEntry = {
  name: 'general',
  kind: 'builtin',
  mode: 'subagent',
  scope: null
}
const EXPLORE: SubagentScanEntry = {
  name: 'explore',
  kind: 'builtin',
  mode: 'subagent',
  scope: null
}
const HIDDEN_BUILTINS: SubagentScanEntry[] = ['title', 'summary', 'compaction'].map((name) => ({
  name,
  kind: 'builtin',
  mode: 'subagent',
  scope: null
}))
const PRIMARIES: SubagentScanEntry[] = ['build', 'plan'].map((name) => ({
  name,
  kind: 'builtin',
  mode: 'primary',
  scope: null
}))

describe('buildSubagentPermissionConfig', () => {
  it('general (no file): bash, edit, webfetch and every MCP key except claudeui', () => {
    const out = buildSubagentPermissionConfig({
      agents: [GENERAL],
      mcpServers: ['lsphub', 'claudeui']
    })
    expect(out).toEqual({
      general: { permission: { bash: 'ask', edit: 'ask', webfetch: 'ask', 'lsphub_*': 'ask' } }
    })
  })

  it('explore (no file): bash and webfetch ONLY — never edit or MCP (its own `{*: deny}` holds)', () => {
    const out = buildSubagentPermissionConfig({ agents: [EXPLORE], mcpServers: ['lsphub'] })
    expect(out).toEqual({ explore: { permission: { bash: 'ask', webfetch: 'ask' } } })
  })

  it("a custom agent with its own `bash: 'deny'` keeps bash out but gets edit, webfetch and MCP", () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        {
          name: 'mybuilder',
          kind: 'custom',
          mode: 'subagent',
          scope: 'project',
          permission: { bash: 'deny' }
        }
      ],
      mcpServers: ['lsphub']
    })
    expect(out).toEqual({
      mybuilder: { permission: { edit: 'ask', webfetch: 'ask', 'lsphub_*': 'ask' } }
    })
  })

  it("a custom agent with its own `bash: 'allow'` → ask (the parent's rules decide)", () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        {
          name: 'mybuilder',
          kind: 'custom',
          mode: 'all',
          scope: 'global',
          permission: { bash: 'allow' }
        }
      ],
      mcpServers: []
    })
    expect(out.mybuilder.permission.bash).toBe('ask')
    expect(Object.keys(out.mybuilder.permission)).toEqual([...CHILD_GATED_CATEGORIES])
  })

  it('a custom agent whose own `"*": "deny"` it does not re-open gets nothing for those categories', () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        {
          name: 'reader',
          kind: 'custom',
          mode: 'subagent',
          scope: 'project',
          permission: { '*': 'deny', read: 'allow', webfetch: 'allow' }
        }
      ],
      mcpServers: ['lsphub']
    })
    expect(out).toEqual({ reader: { permission: { webfetch: 'ask' } } })
  })

  it('an all-deny pattern map counts as a deny; a mixed one is replaced by the ask', () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        {
          name: 'mybuilder',
          kind: 'custom',
          mode: 'subagent',
          scope: 'project',
          permission: {
            bash: { '*': 'deny', 'rm *': 'deny' },
            edit: { '*': 'deny', 'docs/*': 'allow' }
          } as unknown as Record<string, 'allow' | 'ask' | 'deny'>
        }
      ],
      mcpServers: []
    })
    expect(out).toEqual({ mybuilder: { permission: { edit: 'ask', webfetch: 'ask' } } })
  })

  it('skips primaries, disabled agents and the tool-less hidden built-ins', () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        ...PRIMARIES,
        ...HIDDEN_BUILTINS,
        { name: 'off', kind: 'custom', mode: 'subagent', scope: 'project', disabled: true },
        { name: 'primaryfile', kind: 'custom', mode: 'primary', scope: 'project' }
      ],
      mcpServers: ['lsphub']
    })
    expect(out).toEqual({})
  })

  it("a file-backed explore gets its native allows minus its own string denies, never an ask over explore's native deny", () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        {
          name: 'explore',
          kind: 'builtin',
          mode: 'subagent',
          scope: 'global',
          permission: { webfetch: 'deny' }
        }
      ],
      mcpServers: ['lsphub']
    })
    expect(out).toEqual({ explore: { permission: { bash: 'ask' } } })

    // …and a file that opens a category explore natively denies gets the ask for it.
    const opened = buildSubagentPermissionConfig({
      agents: [
        {
          name: 'explore',
          kind: 'builtin',
          mode: 'subagent',
          scope: 'project',
          permission: { edit: 'allow' }
        }
      ],
      mcpServers: ['lsphub']
    })
    expect(opened).toEqual({
      explore: { permission: { bash: 'ask', edit: 'ask', webfetch: 'ask' } }
    })
  })

  it('never a top-level key; agent names sorted; only names from the input', () => {
    const out = buildSubagentPermissionConfig({
      agents: [
        { name: 'zeta', kind: 'custom', mode: 'subagent', scope: 'project' },
        EXPLORE,
        GENERAL,
        { name: 'alpha', kind: 'custom', mode: 'all', scope: 'global' }
      ],
      mcpServers: []
    })
    expect(Object.keys(out)).toEqual(['alpha', 'explore', 'general', 'zeta'])
    expect(out).not.toHaveProperty('permission')
    expect(out).not.toHaveProperty('mybuilder')
  })

  describe('legacy `tools` frontmatter (R2 — a `false` is a deny)', () => {
    const custom = (extra: Partial<SubagentScanEntry>): SubagentScanEntry => ({
      name: 'mybuilder',
      kind: 'custom',
      mode: 'subagent',
      scope: 'project',
      ...extra
    })

    it('`tools: {bash: false}` → no bash ask', () => {
      const out = buildSubagentPermissionConfig({
        agents: [custom({ tools: { bash: false } })],
        mcpServers: []
      })
      expect(out).toEqual({ mybuilder: { permission: { edit: 'ask', webfetch: 'ask' } } })
    })

    it('`tools: {write: false}` → no edit ask (write/edit/patch are `edit`)', () => {
      const out = buildSubagentPermissionConfig({
        agents: [custom({ tools: { write: false } })],
        mcpServers: []
      })
      expect(out).toEqual({ mybuilder: { permission: { bash: 'ask', webfetch: 'ask' } } })
    })

    it('an explicit `permission` key wins over the tools-derived one', () => {
      const out = buildSubagentPermissionConfig({
        agents: [custom({ tools: { bash: false }, permission: { bash: 'allow' } })],
        mcpServers: []
      })
      expect(out.mybuilder.permission.bash).toBe('ask')
    })
  })

  describe("the user's top-level opencode `permission` (R3 — the vendor's `user` rules)", () => {
    const agents: SubagentScanEntry[] = [
      GENERAL,
      EXPLORE,
      { name: 'mybuilder', kind: 'custom', mode: 'subagent', scope: 'project' }
    ]

    it('`webfetch: deny` → no webfetch ask for general, explore or a custom agent', () => {
      const out = buildSubagentPermissionConfig({
        agents,
        mcpServers: [],
        userPermission: { webfetch: 'deny' }
      })
      for (const name of ['general', 'explore', 'mybuilder']) {
        expect(out[name].permission).not.toHaveProperty('webfetch')
        expect(out[name].permission.bash).toBe('ask')
      }
    })

    it('`bash: allow` → explore still gets its bash ask (no widening either way)', () => {
      const out = buildSubagentPermissionConfig({
        agents,
        mcpServers: [],
        userPermission: { bash: 'allow' }
      })
      expect(out.explore).toEqual({ permission: { bash: 'ask', webfetch: 'ask' } })
    })

    it("`edit: allow` re-opens explore's native deny → an edit ask for explore", () => {
      const out = buildSubagentPermissionConfig({
        agents: [EXPLORE],
        mcpServers: ['lsphub'],
        userPermission: { edit: 'allow' }
      })
      expect(out).toEqual({
        explore: { permission: { bash: 'ask', edit: 'ask', webfetch: 'ask' } }
      })
    })

    it("the agent's own config comes after the user's (an own allow re-opens a user deny)", () => {
      const out = buildSubagentPermissionConfig({
        agents: [
          {
            name: 'mybuilder',
            kind: 'custom',
            mode: 'subagent',
            scope: 'project',
            permission: { webfetch: 'allow' }
          }
        ],
        mcpServers: [],
        userPermission: { webfetch: 'deny', '*': 'deny' }
      })
      expect(out).toEqual({ mybuilder: { permission: { webfetch: 'ask' } } })
    })
  })
})

describe('mergeDeep / withToolsPermission (the vendor merge + decode)', () => {
  it('a non-object value replaces; objects merge key-wise; key positions are kept', () => {
    expect(mergeDeep({ bash: 'deny', edit: 'ask' }, { bash: 'allow' })).toEqual({
      bash: 'allow',
      edit: 'ask'
    })
    const merged = mergeDeep(
      { bash: { '*': 'deny' } },
      { bash: { 'git *': 'allow' }, edit: 'deny' }
    )
    expect(merged).toEqual({ bash: { '*': 'deny', 'git *': 'allow' }, edit: 'deny' })
    expect(Object.keys(mergeDeep({ a: 1, b: 2 }, { a: 3 }))).toEqual(['a', 'b'])
    expect(mergeDeep({ bash: { '*': 'deny' } }, { bash: 'ask' })).toEqual({ bash: 'ask' })
  })

  it('tools-derived keys first, the explicit permission over them; a bare string is `{"*": …}`', () => {
    expect(withToolsPermission({ bash: 'allow' }, { bash: false, patch: false })).toEqual({
      bash: 'allow',
      edit: 'deny'
    })
    expect(withToolsPermission('deny', undefined)).toEqual({ '*': 'deny' })
    expect(Object.keys(withToolsPermission({ '*': 'allow' }, { bash: false }))).toEqual([
      'bash',
      '*'
    ])
  })
})

describe('subagentPermissionConfigFor (real fs)', () => {
  let configDir: string
  let cwd: string
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.OPENCODE_CONFIG_DIR
    configDir = path.join(os.tmpdir(), 'oc-subperm-cfg-' + crypto.randomUUID())
    cwd = path.join(os.tmpdir(), 'oc-subperm-cwd-' + crypto.randomUUID())
    fs.mkdirSync(configDir, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = originalEnv
    for (const dir of [configDir, cwd]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  })

  function writeAgent(name: string, frontmatter: string): void {
    const dir = path.join(cwd, '.opencode', 'agent')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\nbody\n`, 'utf8')
  }

  it('a project subagent file + the built-ins; a `mode: primary` file is excluded', () => {
    writeAgent('mybuilder', 'mode: subagent\npermission:\n  bash: allow')
    writeAgent('myprimary', 'mode: primary')
    const out = subagentPermissionConfigFor(cwd, ['lsphub'])
    expect(Object.keys(out)).toEqual(['explore', 'general', 'mybuilder'])
    expect(out.mybuilder).toEqual({
      permission: { bash: 'ask', edit: 'ask', webfetch: 'ask', 'lsphub_*': 'ask' }
    })
    expect(out.explore).toEqual({ permission: { bash: 'ask', webfetch: 'ask' } })
    expect(out).not.toHaveProperty('myprimary')
  })

  it('reads the file-backed agent’s own denies', () => {
    writeAgent('mybuilder', 'mode: subagent\npermission:\n  bash: deny')
    const out = subagentPermissionConfigFor(cwd, [])
    expect(out.mybuilder).toEqual({ permission: { edit: 'ask', webfetch: 'ask' } })
  })

  it('reads a legacy `tools: {bash: false}` frontmatter as a deny (R2)', () => {
    writeAgent('mybuilder', 'mode: subagent\ntools:\n  bash: false')
    const out = subagentPermissionConfigFor(cwd, [])
    expect(out.mybuilder).toEqual({ permission: { edit: 'ask', webfetch: 'ask' } })
  })

  describe("the user's opencode config files (R3)", () => {
    const writeJson = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
    }
    const globalFile = (name = 'opencode.json'): string => path.join(configDir, name)
    const projectFile = (name = 'opencode.json'): string => path.join(cwd, name)
    const dotFile = (name = 'opencode.json'): string => path.join(cwd, '.opencode', name)

    it('a global `agent.general.permission.bash: deny` → no bash ask for general', () => {
      writeJson(
        globalFile(),
        JSON.stringify({ agent: { general: { permission: { bash: 'deny' } } } })
      )
      const out = subagentPermissionConfigFor(cwd, [])
      expect(out.general).toEqual({ permission: { edit: 'ask', webfetch: 'ask' } })
    })

    it('an inline `agent.inlineagent` with `bash: allow` → an entry with bash/edit/webfetch asks', () => {
      writeJson(
        projectFile(),
        JSON.stringify({ agent: { inlineagent: { permission: { bash: 'allow' } } } })
      )
      const out = subagentPermissionConfigFor(cwd, [])
      expect(out.inlineagent).toEqual({
        permission: { bash: 'ask', edit: 'ask', webfetch: 'ask' }
      })
    })

    it('an inline agent that is a primary or disabled gets nothing', () => {
      writeJson(
        projectFile(),
        JSON.stringify({ agent: { lead: { mode: 'primary' }, off: { disable: true } } })
      )
      const out = subagentPermissionConfigFor(cwd, [])
      expect(out).not.toHaveProperty('lead')
      expect(out).not.toHaveProperty('off')
    })

    it('mergeDeep across sources: a global `bash: deny` replaced by a later `bash: allow` → ask', () => {
      writeJson(globalFile(), JSON.stringify({ permission: { bash: 'deny' } }))
      writeJson(dotFile(), JSON.stringify({ permission: { bash: 'allow' } }))
      expect(subagentPermissionConfigFor(cwd, []).general.permission.bash).toBe('ask')
    })

    it('with OPENCODE_CONFIG_DIR set, its files merge again after the project files (vendor order)', () => {
      writeJson(globalFile(), JSON.stringify({ permission: { bash: 'deny' } }))
      writeJson(projectFile(), JSON.stringify({ permission: { bash: 'allow' } }))
      expect(subagentPermissionConfigFor(cwd, []).general.permission).not.toHaveProperty('bash')
    })

    it('a config pattern map merged with an md pattern map → not fully denied → ask', () => {
      writeJson(
        globalFile(),
        JSON.stringify({ agent: { mybuilder: { permission: { bash: { '*': 'deny' } } } } })
      )
      writeAgent('mybuilder', 'mode: subagent')
      expect(subagentPermissionConfigFor(cwd, []).mybuilder.permission).not.toHaveProperty('bash')
      writeAgent('mybuilder', "mode: subagent\npermission:\n  bash:\n    'git *': allow")
      expect(subagentPermissionConfigFor(cwd, []).mybuilder.permission.bash).toBe('ask')
    })

    it('a `.jsonc` file with comments parses; top-level `tools` fold under `permission`', () => {
      writeJson(
        globalFile('opencode.jsonc'),
        '{\n  // the user turned fetching off\n  "permission": { "webfetch": "deny" },\n  /* legacy */ "tools": { "write": false }\n}\n'
      )
      const out = subagentPermissionConfigFor(cwd, [])
      expect(out.general).toEqual({ permission: { bash: 'ask' } })
    })

    it('real tree: opencode.json (top-level deny + inline agent) + .opencode/agent/x.md', () => {
      writeJson(
        projectFile(),
        JSON.stringify({
          permission: { webfetch: 'deny' },
          agent: { inlineagent: { mode: 'subagent', permission: { edit: 'deny' } } }
        })
      )
      writeAgent('x', 'mode: subagent\npermission:\n  bash: allow')
      const out = subagentPermissionConfigFor(cwd, ['lsphub'])
      expect(Object.keys(out)).toEqual(['explore', 'general', 'inlineagent', 'x'])
      expect(out.inlineagent).toEqual({ permission: { bash: 'ask', 'lsphub_*': 'ask' } })
      expect(out.x).toEqual({ permission: { bash: 'ask', edit: 'ask', 'lsphub_*': 'ask' } })
      expect(out.explore).toEqual({ permission: { bash: 'ask' } })
    })
  })
})

describe('categoryMayAllow', () => {
  it.each<[string, OpencodePermissionRule[], string, boolean]>([
    [
      'a catch-all ask after the allow',
      [r('*', '*', 'allow'), r('bash', '*', 'ask')],
      'bash',
      false
    ],
    ['the baseline allow alone', [r('*', '*', 'allow')], 'bash', true],
    [
      'explore before injection (its own bash allow after `{*: deny}`)',
      [r('*', '*', 'allow'), r('*', '*', 'deny'), r('bash', '*', 'allow')],
      'bash',
      true
    ],
    [
      'a narrow allow after the catch-all ask',
      [r('*', '*', 'allow'), r('bash', '*', 'ask'), r('bash', 'git *', 'allow')],
      'bash',
      true
    ],
    [
      'a narrow deny after the catch-all ask only carves out',
      [r('*', '*', 'allow'), r('bash', '*', 'ask'), r('bash', 'git *', 'deny')],
      'bash',
      false
    ],
    [
      'an MCP tool allow overlapping the server key',
      [r('*', '*', 'allow'), r('lsphub_*', '*', 'ask'), r('lsphub_find_refs', '*', 'allow')],
      'lsphub_*',
      true
    ],
    [
      'explore’s `{*: deny}` gates edit',
      [r('*', '*', 'allow'), r('*', '*', 'deny'), r('bash', '*', 'allow')],
      'edit',
      false
    ]
  ])('%s', (_label, rules, category, expected) => {
    expect(categoryMayAllow(rules, category, 'linux')).toBe(expected)
  })
})

describe('subagentBackstopRules', () => {
  const gatedRules = [
    r('*', '*', 'allow'),
    r('bash', '*', 'ask'),
    r('edit', '*', 'ask'),
    r('webfetch', '*', 'ask')
  ]
  const agent = (
    name: string,
    mode: OpencodeAgentInfo['mode'],
    permission: OpencodePermissionRule[]
  ): OpencodeAgentInfo => ({ name, mode, permission })

  it('primaries are skipped; a fully gated agent gets no ask', () => {
    expect(
      subagentBackstopRules(
        [
          agent('build', 'primary', [r('*', '*', 'allow')]),
          agent('general', 'subagent', gatedRules)
        ],
        CHILD_GATED_CATEGORIES,
        'linux'
      )
    ).toEqual([])
  })

  it('an agent with bash gated but webfetch open → one task ask', () => {
    const open = [r('*', '*', 'allow'), r('bash', '*', 'ask'), r('edit', '*', 'ask')]
    expect(
      subagentBackstopRules([agent('mybuilder', 'all', open)], CHILD_GATED_CATEGORIES, 'linux')
    ).toEqual([{ permission: 'task', pattern: 'mybuilder', action: 'ask' }])
  })

  it('MCP counts only when passed in `gated`; output sorted by name', () => {
    const agents = [agent('zed', 'subagent', gatedRules), agent('general', 'subagent', gatedRules)]
    expect(subagentBackstopRules(agents, CHILD_GATED_CATEGORIES, 'linux')).toEqual([])
    expect(subagentBackstopRules(agents, [...CHILD_GATED_CATEGORIES, 'lsphub_*'], 'linux')).toEqual(
      [
        { permission: 'task', pattern: 'general', action: 'ask' },
        { permission: 'task', pattern: 'zed', action: 'ask' }
      ]
    )
  })

  it('a malformed row (no permission array) fails toward the ask', () => {
    const row = { name: 'weird', mode: 'subagent' } as unknown as OpencodeAgentInfo
    expect(subagentBackstopRules([row], CHILD_GATED_CATEGORIES, 'linux')).toEqual([
      { permission: 'task', pattern: 'weird', action: 'ask' }
    ])
  })

  it('the fail-closed rule asks for every task spawn', () => {
    expect(TASK_BACKSTOP_FAIL_CLOSED_RULE).toEqual({
      permission: 'task',
      pattern: '*',
      action: 'ask'
    })
  })
})

// ── opencode 2.x: the child's ruleset (ADR-097 §3, S6) ──────────────────────

describe('2.x subagent children — childSessionRuleset / agentWhollyDenies', () => {
  const v = (action: string, effect: V2Rule['effect'], resource = '*'): V2Rule => ({
    action,
    resource,
    effect
  })
  // The agent rulesets 2.x computes (vendor/opencode-v2-src/packages/schema/src/agent.ts
  // `Info.default`, core/src/plugin/agent.ts), opencode's own data dirs elided.
  const DEFAULTS = [
    v('*', 'allow'),
    v('external_directory', 'ask'),
    v('read', 'ask', '*.env'),
    v('read', 'ask', '*.env.*'),
    v('read', 'allow', '*.env.example')
  ]
  const GENERAL_V2 = [...DEFAULTS, v('question', 'deny'), v('subagent', 'deny')]
  const EXPLORE_V2 = [
    ...DEFAULTS,
    v('*', 'deny'),
    v('shell', 'allow'),
    v('grep', 'allow'),
    v('glob', 'allow'),
    v('webfetch', 'allow'),
    v('websearch', 'allow'),
    v('read', 'allow'),
    v('read', 'ask', '*.env'),
    v('read', 'ask', '*.env.*'),
    v('read', 'allow', '*.env.example'),
    v('subagent', 'deny'),
    v('external_directory', 'ask')
  ]
  const parent = (mode: string, deny: string[] = [], allow: string[] = []) =>
    buildSessionRuleset({
      mode,
      autoMode: mode === 'auto',
      permissions: { allow, deny, ask: [], additionalDirectories: [], defaultMode: undefined },
      mcpServers: ['claudeui', 'lsphub']
    }).rules
  /** What the engine evaluates for a child: its agent's rules, then its session's. */
  const effective = (agent: V2Rule[], session: V2Rule[]) => [...agent, ...session]

  it('agentWhollyDenies reads the agent rules from the end, overlap-aware', () => {
    expect(agentWhollyDenies(EXPLORE_V2, 'edit', 'linux')).toBe(true)
    expect(agentWhollyDenies(EXPLORE_V2, 'claudeui_dispatch_agent', 'linux')).toBe(true)
    expect(agentWhollyDenies(EXPLORE_V2, 'lsphub_*', 'linux')).toBe(true)
    expect(agentWhollyDenies(EXPLORE_V2, 'shell', 'linux')).toBe(false)
    expect(agentWhollyDenies(GENERAL_V2, 'edit', 'linux')).toBe(false)
    expect(agentWhollyDenies(GENERAL_V2, 'question', 'linux')).toBe(true)
    // A narrower deny only carves out.
    expect(agentWhollyDenies([v('*', 'allow'), v('shell', 'deny', 'rm *')], 'shell', 'linux')).toBe(
      false
    )
  })

  it('PRE-FIX: an inherited parent rule re-opens what the child agent denies (why the PATCH exists)', () => {
    const session = parent('default')
    // explore denies edit outright, but the parent's `edit: ask` comes after it.
    expect(v2ToolHidden(effective(EXPLORE_V2, session), 'edit', 'linux')).toBe(false)
    expect(evaluateV2Call(effective(EXPLORE_V2, session), 'edit', ['a.ts'], 'linux')).toBe('ask')
    // …and a user allow turns a custom agent's shell deny into an allow.
    const custom = [...DEFAULTS, v('shell', 'deny')]
    const withAllow = parent('default', [], ['Bash(git status)'])
    expect(evaluateV2Call(effective(custom, withAllow), 'shell', ['git status'], 'linux')).toBe(
      'allow'
    )
  })

  it('explore under a default parent: edit and the dispatch tool hidden again; shell keeps the parent ask', () => {
    const session = parent('default')
    const child = childSessionRuleset(session, EXPLORE_V2, 'linux')
    const rules = effective(EXPLORE_V2, child)
    expect(v2ToolHidden(rules, 'edit', 'linux')).toBe(true)
    expect(v2ToolHidden(rules, 'claudeui_dispatch_agent', 'linux')).toBe(true)
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(false)
    expect(evaluateV2Call(rules, 'shell', ['ls'], 'linux')).toBe('ask') // ruling 4
    expect(evaluateV2Call(rules, 'read', ['a.ts'], 'linux')).toBe('allow')
    // The parent's rules are all still there, in order, ahead of the narrowing.
    expect(child.slice(0, session.length - 1)).toEqual(session.slice(0, -1))
  })

  it('a custom agent that denies shell stays shell-less under a parent that allows a command', () => {
    const custom = [...DEFAULTS, v('shell', 'deny')]
    const session = parent('default', [], ['Bash(git status)'])
    const rules = effective(custom, childSessionRuleset(session, custom, 'linux'))
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(true)
    expect(evaluateV2Call(rules, 'shell', ['git status'], 'linux')).toBe('deny')
  })

  it('general (allow-all): only its own denies are restated after the parent; nothing else changes', () => {
    const session = parent('default')
    const child = childSessionRuleset(session, GENERAL_V2, 'linux')
    expect(child).toEqual(wireOrder([...session, v('question', 'deny'), v('subagent', 'deny')]))
    expect(v2ToolHidden(effective(GENERAL_V2, child), 'question', 'linux')).toBe(true)
    expect(evaluateV2Call(effective(GENERAL_V2, child), 'edit', ['a.ts'], 'linux')).toBe('ask')
  })

  it('auto mode: claudeui tools the agent wholly denies are re-denied; MCP tools ask (judged)', () => {
    const session = parent('auto')
    const child = childSessionRuleset(session, EXPLORE_V2, 'linux')
    expect(child).toContainEqual(v('claudeui_*', 'deny'))
    expect(v2ToolHidden(effective(EXPLORE_V2, child), 'claudeui_render_mermaid', 'linux')).toBe(
      true
    )
    // The `*_*` catch-all overlaps explore's own `external_directory` ask, so it
    // is not a wholly denied action: an MCP call asks and the judge decides.
    expect(evaluateV2Call(effective(EXPLORE_V2, child), 'lsphub_find', ['*'], 'linux')).toBe('ask')
  })

  it("review #5: a custom agent's NARROW deny survives the parent's gate and a user allow", () => {
    const custom = [...DEFAULTS, v('shell', 'deny', 'git push*'), v('edit', 'deny', 'src/secret/*')]
    // PRE-FIX shape: the parent's later `shell *` ask / allow outranks the agent deny.
    const withAllow = parent('default', [], ['Bash(git:*)'])
    expect(
      evaluateV2Call(effective(custom, withAllow), 'shell', ['git push origin main'], 'linux')
    ).toBe('allow')
    const rules = effective(custom, childSessionRuleset(withAllow, custom, 'linux'))
    expect(evaluateV2Call(rules, 'shell', ['git push origin main'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'shell', ['git status'], 'linux')).toBe('allow')
    expect(evaluateV2Call(rules, 'edit', ['src/secret/k'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'edit', ['src/ok.ts'], 'linux')).toBe('ask')
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(false)
  })

  it('an agent deny its own later rules carve is left to the host backstop, not over-applied', () => {
    const carved = [...DEFAULTS, v('shell', 'deny', 'git *'), v('shell', 'allow', 'git status')]
    const child = childSessionRuleset(parent('default'), carved, 'linux')
    expect(child).not.toContainEqual(v('shell', 'deny', 'git *'))
    expect(evaluateChildCall(carved, 'shell', 'git push', 'linux')).toBe('deny')
    expect(evaluateChildCall(carved, 'shell', 'git status', 'linux')).toBe('allow')
  })

  it('evaluateChildCall: last match over the agent rules, no match = ask', () => {
    expect(evaluateChildCall(EXPLORE_V2, 'edit', 'a.ts', 'linux')).toBe('deny')
    expect(evaluateChildCall(EXPLORE_V2, 'shell', 'ls', 'linux')).toBe('allow')
    expect(evaluateChildCall([], 'shell', 'ls', 'linux')).toBe('ask')
  })

  it('re-derived for a switched agent (session.agent.selected): same parent, the new agent', () => {
    const session = parent('default')
    const before = childSessionRuleset(session, GENERAL_V2, 'linux')
    const after = childSessionRuleset(session, EXPLORE_V2, 'linux')
    expect(v2ToolHidden(effective(GENERAL_V2, before), 'edit', 'linux')).toBe(false)
    expect(v2ToolHidden(effective(EXPLORE_V2, after), 'edit', 'linux')).toBe(true)
  })

  it("the parent's denies need nothing: inherited, they hold in the child", () => {
    const session = parent('plan', ['Bash(rm:*)'])
    const child = childSessionRuleset(session, GENERAL_V2, 'linux')
    expect(v2ToolHidden(effective(GENERAL_V2, child), 'edit', 'linux')).toBe(true)
    expect(evaluateV2Call(effective(GENERAL_V2, child), 'shell', ['rm x'], 'linux')).toBe('deny')
  })

  it('does not mutate the parent ruleset', () => {
    const session = parent('default')
    const copy = structuredClone(session)
    childSessionRuleset(session, EXPLORE_V2, 'linux')
    expect(session).toEqual(copy)
  })
})
