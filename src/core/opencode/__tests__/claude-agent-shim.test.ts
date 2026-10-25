import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_AGENT_PREAMBLE,
  claudeAgentDenyRules,
  loadClaudeAgentsForOpencode,
  MAX_INJECTED_AGENT_BYTES,
  MAX_INJECTED_BLOCK_BYTES,
  type ClaudeAgentShimOptions
} from '../claude-agent-shim'
import { opencodeModelAllowed } from '../model-allowlist'

// Every file and directory this suite creates is recorded and removed by its
// explicit name afterwards (files first, then directories deepest-first).
let base: string
const createdFiles: string[] = []
const createdDirs: string[] = []

function mkdir(p: string): string {
  const parts: string[] = []
  let cur = p
  while (!fs.existsSync(cur)) {
    parts.unshift(cur)
    cur = path.dirname(cur)
  }
  for (const d of parts) {
    fs.mkdirSync(d)
    createdDirs.push(d)
  }
  return p
}

function write(p: string, text: string): string {
  mkdir(path.dirname(p))
  fs.writeFileSync(p, text)
  createdFiles.push(p)
  return p
}

const agentMd = (fields: string, body = 'The prompt.'): string => `---\n${fields}\n---\n${body}\n`

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-shim-'))
  createdDirs.push(base)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const f of createdFiles.splice(0)) fs.unlinkSync(f)
  for (const d of createdDirs.splice(0).reverse()) fs.rmdirSync(d)
})

const ORCH_READER_TOOLS = 'Read, Grep, Glob, Bash, WebFetch, WebSearch'

/** A user dir and a project (git root = cwd) dir under `base`, plus a loader over them. */
function rig(opts: Partial<ClaudeAgentShimOptions> = {}): {
  userDir: string
  root: string
  userFile: (name: string, text: string) => string
  projectFile: (name: string, text: string) => string
  load: (over?: Partial<ClaudeAgentShimOptions>) => ReturnType<typeof loadClaudeAgentsForOpencode>
} {
  const userDir = mkdir(path.join(base, 'user-agents'))
  const root = mkdir(path.join(base, 'repo'))
  mkdir(path.join(root, '.git'))
  return {
    userDir,
    root,
    userFile: (name, text) => write(path.join(userDir, `${name}.md`), text),
    projectFile: (name, text) => write(path.join(root, '.claude', 'agents', `${name}.md`), text),
    load: (over = {}) =>
      loadClaudeAgentsForOpencode({
        cwd: root,
        mcpServers: [],
        nativeAgentNames: [],
        modelAllowlist: {},
        claudeUserAgentsDir: userDir,
        ...opts,
        ...over
      })
  }
}

const deny = (action: string): { action: string; resource: string; effect: 'deny' } => ({
  action,
  resource: '*',
  effect: 'deny'
})

/** What a server denied wholesale costs: its tools and its two MCP resource actions (raw server name). */
const denyServer = (
  raw: string,
  id = raw
): Array<{ action: string; resource: string; effect: 'deny' }> => [
  deny(`${id}_*`),
  { action: 'opencode_list_mcp_resources', resource: raw, effect: 'deny' },
  { action: 'opencode_read_mcp_resource', resource: `${raw}:*`, effect: 'deny' }
]

describe('claudeAgentDenyRules', () => {
  const rules = (
    tools: 'inherit' | string[],
    disallowedTools: string[] = [],
    mcpServers: string[] = [],
    diagnostics: string[] = []
  ) =>
    claudeAgentDenyRules({ tools, disallowedTools, filePath: '/x/a.md' }, mcpServers, diagnostics)

  it('a tools list denies exactly the tool actions it does not name, plus question and the hosted server', () => {
    // orch-reader: Read, Grep, Glob, Bash, WebFetch, WebSearch
    expect(rules(ORCH_READER_TOOLS.split(', '))).toEqual([
      ...['edit', 'subagent', 'skill', 'question'].map(deny),
      ...denyServer('claudeui')
    ])
    // The order is fixed (V2_TOOL_ACTIONS, question, MCP ids), whatever the file's order.
    expect(rules(['Skill', 'Read'])).toEqual([
      ...['shell', 'edit', 'glob', 'grep', 'webfetch', 'websearch', 'subagent', 'question'].map(
        deny
      ),
      ...denyServer('claudeui')
    ])
  })

  it("ClaudeUI's hosted server is a live server: denied unless the list names it at server level", () => {
    for (const keep of ['mcp__claudeui', 'mcp__claudeui__*']) {
      const out = rules(['Read', keep])
      expect(out).not.toContainEqual(deny('claudeui_*'))
      expect(out.filter((r) => r.resource.startsWith('claudeui'))).toEqual([])
    }
    // A tool-level entry does not keep it (deny-only), like any other server.
    const diagnostics: string[] = []
    expect(rules(['Read', 'mcp__claudeui__dispatch_agent'], [], [], diagnostics)).toEqual(
      expect.arrayContaining(denyServer('claudeui'))
    )
    expect(diagnostics).toHaveLength(1)
    // No tools restriction: nothing is denied, the hosted server included.
    expect(rules('inherit')).toEqual([])
    // Listing it among the bridged servers does not duplicate the rule.
    const listed = rules(['Read'], [], ['claudeui'])
    expect(listed.filter((r) => r.action === 'claudeui_*')).toHaveLength(1)
    expect(listed.filter((r) => r.action === 'opencode_list_mcp_resources')).toHaveLength(1)
    expect(listed.filter((r) => r.action === 'opencode_read_mcp_resource')).toHaveLength(1)
  })

  it('maps Claude tool names case-insensitively; Write and Edit and friends are all the edit action', () => {
    expect(rules(['bash', 'READ', 'notebookedit', 'Task'])).toEqual([
      ...['glob', 'grep', 'webfetch', 'websearch', 'skill', 'question'].map(deny),
      ...denyServer('claudeui')
    ])
    expect(rules(['Write'])).not.toContainEqual(deny('edit'))
    expect(rules(['Agent'])).not.toContainEqual(deny('subagent'))
  })

  it('no tools restriction means no rules; an empty list means everything denied', () => {
    expect(rules('inherit')).toEqual([])
    expect(rules([])).toEqual([
      ...[
        'shell',
        'read',
        'edit',
        'glob',
        'grep',
        'webfetch',
        'websearch',
        'subagent',
        'skill',
        'question'
      ].map(deny),
      ...denyServer('claudeui')
    ])
  })

  it('disallowedTools adds its own denies, with or without a tools list', () => {
    expect(rules('inherit', ['Edit', 'WebFetch'])).toEqual(['edit', 'webfetch'].map(deny))
    expect(rules(['Read', 'Edit'], ['Edit'])).toContainEqual(deny('edit'))
    expect(rules(['Read', 'Edit'], ['Edit']).filter((r) => r.action === 'edit')).toHaveLength(1)
  })

  it('AskUserQuestion in a tools list keeps question; in disallowedTools it denies question', () => {
    const diagnostics: string[] = []
    for (const name of ['AskUserQuestion', 'askuserquestion']) {
      const out = rules(['Read', name], [], [], diagnostics)
      expect(out).not.toContainEqual(deny('question'))
      // The other tool actions are still denied as for any list.
      expect(out).toContainEqual(deny('edit'))
    }
    expect(diagnostics).toEqual([]) // not "a tool opencode has"-style noise
    expect(rules('inherit', ['AskUserQuestion'])).toEqual([deny('question')])
    // Denying wins over a tools list that keeps it, with the one rule.
    const both = rules(['Read', 'AskUserQuestion'], ['askuserquestion'])
    expect(both.filter((r) => r.action === 'question')).toEqual([deny('question')])
  })

  it('a tools list denies natively configured servers handed in with the bridged ones', () => {
    // The manager passes bridged ∪ opencodeMcpServerNames(cwd): all are live servers.
    const out = rules(['Read'], [], ['bridged', 'github', 'github'])
    for (const server of ['bridged', 'github']) {
      for (const rule of denyServer(server)) expect(out).toContainEqual(rule)
    }
    expect(out.filter((r) => r.action === 'github_*')).toHaveLength(1)
  })

  it('MCP: a live server the list does not name at server level is denied as <server>_*', () => {
    const servers = ['github', 'my.docs', 'lsphub']
    const out = rules(['Read', 'mcp__github', 'mcp__lsphub__*'], [], servers)
    const mcp = out.filter((r) => !['read', 'edit'].includes(r.action) && r.action.includes('_'))
    expect(mcp).toEqual([
      deny('claudeui_*'),
      deny('my_docs_*'),
      { action: 'opencode_list_mcp_resources', resource: 'claudeui', effect: 'deny' },
      { action: 'opencode_list_mcp_resources', resource: 'my.docs', effect: 'deny' },
      { action: 'opencode_read_mcp_resource', resource: 'claudeui:*', effect: 'deny' },
      { action: 'opencode_read_mcp_resource', resource: 'my.docs:*', effect: 'deny' }
    ])
    // No tools list: MCP servers are not touched.
    expect(rules('inherit', [], servers)).toEqual([])
    // disallowedTools names a server or one tool.
    expect(rules('inherit', ['mcp__github', 'mcp__lsphub__find'])).toEqual([
      deny('github_*'),
      deny('lsphub_find'),
      ...denyServer('github').slice(1)
    ])
  })

  it('a tool-level MCP entry does not keep its server (deny-only), and says so', () => {
    const diagnostics: string[] = []
    const out = rules(['mcp__github__issues'], [], ['github'], diagnostics)
    expect(out).toContainEqual(deny('github_*'))
    expect(diagnostics).toEqual([
      '/x/a.md: tools: "mcp__github__issues" names one tool; only a server-level entry (mcp__github) keeps an MCP server'
    ])
  })

  it('a server denied wholesale also loses its MCP resources, under its raw configured name', () => {
    const out = rules(['Read', 'mcp__kept'], [], ['my.docs', 'kept'])
    for (const rule of denyServer('my.docs', 'my_docs')) expect(out).toContainEqual(rule)
    for (const rule of denyServer('claudeui')) expect(out).toContainEqual(rule)
    // The sanitized tool-id segment is not the resource: opencode checks the configured name.
    expect(out.some((r) => r.resource.startsWith('my_docs'))).toBe(false)
    // `kept` is named at server level: nothing for it, tools or resources.
    expect(out.some((r) => r.action.startsWith('kept_') || r.resource.startsWith('kept'))).toBe(
      false
    )
    // disallowedTools naming a server: its tools and both resource rules, no tools list needed.
    expect(rules('inherit', ['mcp__kept'])).toEqual(denyServer('kept'))
    expect(rules('inherit', ['mcp__kept__*'])).toEqual(denyServer('kept'))
    // The raw segment of the entry is the resource, not its sanitized form.
    expect(rules('inherit', ['mcp__my.docs'])).toEqual(denyServer('my.docs', 'my_docs'))
    // Claude's normalized spelling of a live `my.docs`: its configured name is denied too.
    expect(rules('inherit', ['mcp__my_docs'], ['my.docs'])).toEqual([
      deny('my_docs_*'),
      { action: 'opencode_list_mcp_resources', resource: 'my.docs', effect: 'deny' },
      { action: 'opencode_list_mcp_resources', resource: 'my_docs', effect: 'deny' },
      { action: 'opencode_read_mcp_resource', resource: 'my.docs:*', effect: 'deny' },
      { action: 'opencode_read_mcp_resource', resource: 'my_docs:*', effect: 'deny' }
    ])
    // One denied tool adds only that tool.
    expect(rules('inherit', ['mcp__kept__t'])).toEqual([deny('kept_t')])
  })

  it('never emits an allow, a bare *, or *_*; never touches external_directory', () => {
    const out = rules(['Read'], ['Bash'], ['a', 'b-c', 'd e'])
    expect(out.every((r) => r.effect === 'deny')).toBe(true)
    // Only the MCP resource rules carry a resource; every other rule is `*`.
    expect(out.filter((r) => r.resource !== '*').map((r) => `${r.action} ${r.resource}`)).toEqual([
      ...['a', 'b-c', 'claudeui', 'd e'].map((s) => `opencode_list_mcp_resources ${s}`),
      ...['a', 'b-c', 'claudeui', 'd e'].map((s) => `opencode_read_mcp_resource ${s}:*`)
    ])
    const actions = out.map((r) => r.action)
    expect(actions).not.toContain('*')
    expect(actions).not.toContain('*_*')
    expect(actions).not.toContain('external_directory')
    expect(actions.filter((a) => a.endsWith('_*'))).toEqual(['a_*', 'b-c_*', 'claudeui_*', 'd_e_*'])
  })

  it('an unknown tool name is a diagnostic, not a rule', () => {
    const diagnostics: string[] = []
    expect(rules(['Read', 'TodoWrite'], ['LS'], [], diagnostics)).not.toContainEqual(
      deny('todowrite')
    )
    expect(diagnostics).toEqual([
      '/x/a.md: tools: "TodoWrite" is not a tool opencode has; ignored',
      '/x/a.md: disallowedTools: "LS" is not a tool opencode has; ignored'
    ])
  })
})

describe('loadClaudeAgentsForOpencode', () => {
  it('translates a definition into a subagent entry: preamble + body, description, deny-only rules', () => {
    const r = rig()
    r.userFile(
      'orch-reader',
      agentMd(
        `name: orch-reader\ndescription: Collects evidence.\nmodel: sonnet\ntools: ${ORCH_READER_TOOLS}`,
        'You read.'
      )
    )
    const out = r.load()
    expect(out.diagnostics).toEqual([])
    expect(out.agents).toEqual({
      'orch-reader': {
        description: 'Collects evidence.',
        mode: 'subagent',
        system: `${CLAUDE_AGENT_PREAMBLE}\n\nYou read.`,
        permissions: [
          ...['edit', 'subagent', 'skill', 'question'].map(deny),
          ...denyServer('claudeui')
        ]
      }
    })
    // The Claude model alias is not an opencode model: none is emitted.
    expect(out.agents['orch-reader']).not.toHaveProperty('model')
  })

  describe('injected (what the agent type catalog lists)', () => {
    it('matches the agents keys and order, carries scope and colour, and never puts the colour into an agent', () => {
      const r = rig()
      r.userFile('zeta', agentMd('name: zeta\ndescription: d\ncolor: green'))
      r.userFile('alpha', agentMd('name: alpha\ndescription: d\ncolor: "  cyan "'))
      r.userFile('plain', agentMd('name: plain\ndescription: d\ncolor: ""'))
      r.userFile('numeric', agentMd('name: numeric\ndescription: d\ncolor: 5'))
      r.projectFile('proj', agentMd('name: proj\ndescription: d\ncolor: red'))
      const out = r.load()
      expect(out.injected.map((a) => a.name)).toEqual(Object.keys(out.agents))
      expect(out.injected).toEqual([
        { name: 'alpha', scope: 'user', color: 'cyan' },
        { name: 'numeric', scope: 'user' },
        { name: 'plain', scope: 'user' },
        { name: 'proj', scope: 'project', color: 'red' },
        { name: 'zeta', scope: 'user', color: 'green' }
      ])
      expect(JSON.stringify(out.agents)).not.toContain('green')
    })

    it('carries the own model of an injected agent (variant included), and none when it inherits', () => {
      const r = rig()
      r.userFile(
        'withmodel',
        agentMd(
          'name: withmodel\ndescription: d\nharness:\n  opencode:\n    model: openai/gpt-6-luna#high'
        )
      )
      r.userFile('inherits', agentMd('name: inherits\ndescription: d'))
      // A top-level `model` is the Claude and pi key, not opencode's.
      r.userFile('claudeonly', agentMd('name: claudeonly\ndescription: d\nmodel: opus'))
      expect(r.load().injected).toEqual([
        { name: 'claudeonly', scope: 'user' },
        { name: 'inherits', scope: 'user' },
        { name: 'withmodel', scope: 'user', model: 'openai/gpt-6-luna#high' }
      ])
    })

    it('a project definition that overrides a user one is listed once, with the project scope', () => {
      const r = rig()
      r.userFile('twin', agentMd('name: twin\ndescription: user\ncolor: green'))
      r.projectFile('twin', agentMd('name: twin\ndescription: project'))
      expect(r.load().injected).toEqual([{ name: 'twin', scope: 'project' }])
    })

    it('leaves out every skipped agent: native clash, refused or malformed model, size cap, parse error', () => {
      const r = rig()
      r.userFile('kept', agentMd('name: kept\ndescription: d\ncolor: blue'))
      r.userFile('Native', agentMd('name: Native\ndescription: d\ncolor: red'))
      r.userFile(
        'refused',
        agentMd('name: refused\ndescription: d\nharness:\n  opencode:\n    model: openai/gpt-x')
      )
      r.userFile(
        'malformed',
        agentMd('name: malformed\ndescription: d\nharness:\n  opencode:\n    model: nonsense')
      )
      r.userFile('big', agentMd('name: big\ndescription: d', 'x'.repeat(MAX_INJECTED_AGENT_BYTES)))
      r.userFile('broken', 'no front matter at all')
      const out = r.load({ nativeAgentNames: ['native'], modelAllowlist: { openai: ['other'] } })
      expect(Object.keys(out.agents)).toEqual(['kept'])
      expect(out.injected).toEqual([{ name: 'kept', scope: 'user', color: 'blue' }])
    })

    it('leaves out the agents the 24 KiB block cap skips', () => {
      const r = rig()
      for (const n of ['f', 'e', 'd', 'c', 'b', 'a']) {
        r.userFile(n, agentMd(`name: ${n}\ndescription: d`, n.repeat(6 * 1024)))
      }
      expect(r.load().injected.map((a) => a.name)).toEqual(['a', 'b', 'c'])
    })
  })

  it('no tools key: no permissions entry; an empty body is the preamble alone', () => {
    const r = rig()
    r.userFile('plain', agentMd('name: plain\ndescription: d', ''))
    expect(r.load().agents.plain).toEqual({
      description: 'd',
      mode: 'subagent',
      system: CLAUDE_AGENT_PREAMBLE
    })
  })

  it('MCP servers come from the live list', () => {
    const r = rig()
    r.userFile('a', agentMd('name: a\ndescription: d\ntools: Read, mcp__github'))
    const { agents } = r.load({ mcpServers: ['github', 'lsphub'] })
    expect(agents.a.permissions).toContainEqual(deny('lsphub_*'))
    expect(agents.a.permissions).not.toContainEqual(deny('github_*'))
  })

  describe('model', () => {
    const file = (model: string, name = 'm'): string =>
      agentMd(`name: ${name}\ndescription: d\nharness:\n  opencode:\n    model: ${model}`)

    it('user scope: harness.opencode.model (with a variant) is carried when the allowlist permits it', () => {
      const r = rig()
      r.userFile('m', file('openai/gpt-6-luna#high'))
      expect(r.load().agents.m.model).toBe('openai/gpt-6-luna#high')
      // A provider with an allowlist entry that lists the id passes; an id outside it does not.
      expect(r.load({ modelAllowlist: { openai: ['gpt-6-luna'] } }).agents.m).toBeDefined()
    })

    it('user scope: a model outside the allowlist skips the agent with a diagnostic, never a substitute', () => {
      const r = rig()
      const f = r.userFile('m', file('openai/gpt-6-luna'))
      const out = r.load({ modelAllowlist: { openai: ['gpt-5'] } })
      expect(out.agents).toEqual({})
      expect(out.diagnostics).toEqual([
        `${f}: skipped (model "openai/gpt-6-luna" is not in the opencode model allowlist)`
      ])
    })

    it('user scope: a malformed model skips the agent', () => {
      const r = rig()
      const bad = ['"luna"', '"openai/"', '"/gpt"', '"a b/c"', '"openai/x#"', '[openai/x]', '7']
      const files = bad.map((m, i) => r.userFile(`m${i}`, file(m, `m${i}`)))
      const out = r.load()
      expect(out.agents).toEqual({})
      const joined = out.diagnostics.join(' | ')
      for (const f of files) expect(joined).toContain(`${f}: skipped (`)
      expect(out.diagnostics).toHaveLength(bad.length)
    })

    it('project scope: harness.opencode.model is honoured exactly as in user scope', () => {
      const r = rig()
      r.projectFile('m', file('openai/gpt-6-luna#high'))
      const out = r.load()
      expect(out.agents.m.model).toBe('openai/gpt-6-luna#high')
      expect(out.diagnostics).toEqual([])
      expect(r.load({ modelAllowlist: { openai: ['gpt-6-luna'] } }).agents.m).toBeDefined()
    })

    it('project scope: a model outside the allowlist, or a malformed one, skips the agent with a diagnostic', () => {
      const r = rig()
      const refused = r.projectFile('refused', file('openai/gpt-6-luna', 'refused'))
      const malformed = r.projectFile('malformed', file('nonsense', 'malformed'))
      const out = r.load({ modelAllowlist: { openai: ['gpt-5'] } })
      expect(out.agents).toEqual({})
      expect([...out.diagnostics].sort()).toEqual(
        [
          `${refused}: skipped (model "openai/gpt-6-luna" is not in the opencode model allowlist)`,
          `${malformed}: skipped (malformed: harness.opencode.model is not provider/id[#variant])`
        ].sort()
      )
    })

    it('a harness.pi.model or a top-level model is not an opencode model', () => {
      const r = rig()
      r.userFile(
        'm',
        agentMd('name: m\ndescription: d\nmodel: openai/x\nharness:\n  pi:\n    model: openai/y')
      )
      expect(r.load().agents.m).not.toHaveProperty('model')
    })
  })

  describe('effort (R4: the top-level key becomes the model variant)', () => {
    const file = (fields: string, name = 'e'): string =>
      agentMd(`name: ${name}\ndescription: d\n${fields}`)
    const model = (id: string): string => `harness:\n  opencode:\n    model: ${id}`

    it('effort + harness.opencode.model without a variant → model "<p/id>#<effort>", unvalidated', () => {
      const r = rig()
      r.userFile('e', file(`effort: high\n${model('openai/gpt-6-luna')}`))
      const out = r.load()
      expect(out.agents.e.model).toBe('openai/gpt-6-luna#high')
      expect(out.injected).toEqual([
        { name: 'e', scope: 'user', model: 'openai/gpt-6-luna#high', effort: 'high' }
      ])
      expect(out.diagnostics).toEqual([])
      // Whatever the word is: the shim does not know the model's variants.
      r.userFile('x', file(`effort: not-a-variant\n${model('openai/gpt-6-luna')}`, 'x'))
      expect(r.load().agents.x.model).toBe('openai/gpt-6-luna#not-a-variant')
    })

    it('an explicit #variant wins over effort (no effort recorded for validation)', () => {
      const r = rig()
      r.userFile('e', file(`effort: max\n${model('openai/gpt-6-luna#low')}`))
      const out = r.load()
      expect(out.agents.e.model).toBe('openai/gpt-6-luna#low')
      expect(out.injected[0]).not.toHaveProperty('effort')
    })

    it('effort without harness.opencode.model: a diagnostic, the agent is injected unchanged', () => {
      const r = rig()
      const f = r.userFile('e', file('effort: high'))
      const out = r.load()
      expect(out.agents.e).not.toHaveProperty('model')
      expect(out.diagnostics).toEqual([
        `${f}: effort needs harness.opencode.model on opencode; ignored`
      ])
    })

    it('reads the top-level effort only: not `thinking`, not harness.opencode.effort', () => {
      const r = rig()
      r.userFile('e', file(`thinking: high\n${model('openai/gpt-6-luna')}\n    effort: high`))
      const out = r.load()
      expect(out.agents.e.model).toBe('openai/gpt-6-luna')
      expect(out.diagnostics).toEqual([])
    })

    it('a value that is not a single word is ignored with a diagnostic (never a malformed model)', () => {
      const r = rig()
      const files = ['"a b"', '"x#y"', '""', '7', '[high]'].map((value, i) =>
        r.userFile(`e${i}`, file(`effort: ${value}\n${model('openai/gpt-6-luna')}`, `e${i}`))
      )
      const out = r.load()
      for (let i = 0; i < files.length; i++) {
        expect(out.agents[`e${i}`].model).toBe('openai/gpt-6-luna')
        expect(out.diagnostics.join(' | ')).toContain(`${files[i]}: effort is not a single word`)
      }
    })

    it('the allowlist still judges the BASE model (variant ignored)', () => {
      const r = rig()
      r.userFile('e', file(`effort: high\n${model('openai/gpt-6-luna')}`))
      expect(r.load({ modelAllowlist: { openai: ['gpt-6-luna'] } }).agents.e.model).toBe(
        'openai/gpt-6-luna#high'
      )
      expect(r.load({ modelAllowlist: { openai: ['gpt-5'] } }).agents).toEqual({})
    })

    it('is a pure function of the files and the allowlist (same input, same output)', () => {
      const r = rig()
      r.userFile('e', file(`effort: high\n${model('openai/gpt-6-luna')}`))
      expect(JSON.stringify(r.load())).toBe(JSON.stringify(r.load()))
    })

    it('permissionMode and background are not mapped (R4)', () => {
      const r = rig()
      r.userFile('e', file(`permissionMode: plan\nbackground: true\n${model('openai/gpt-6-luna')}`))
      const out = r.load()
      expect(Object.keys(out.agents.e).sort()).toEqual(['description', 'mode', 'model', 'system'])
      expect(out.diagnostics).toEqual([])
    })
  })

  describe('precedence and native agents', () => {
    it('harness-native wins, case-insensitively, with a diagnostic', () => {
      const r = rig()
      const f = r.userFile('explore', agentMd('name: Explore\ndescription: d'))
      r.userFile('mine', agentMd('name: mine\ndescription: d'))
      const out = r.load({ nativeAgentNames: ['explore', 'build'] })
      expect(Object.keys(out.agents)).toEqual(['mine'])
      expect(out.diagnostics).toEqual([
        `${f}: skipped (opencode already has an agent "Explore"; the native one wins)`
      ])
    })

    it('a project definition overrides the user one of the same name, with a diagnostic', () => {
      const r = rig()
      const u = r.userFile('a', agentMd('name: a\ndescription: user one'))
      const p = r.projectFile('a', agentMd('name: A\ndescription: project one'))
      const out = r.load()
      expect(out.agents.A.description).toBe('project one')
      expect(Object.keys(out.agents)).toEqual(['A'])
      expect(out.diagnostics).toEqual([`project agent ${p} overrides the user agent "a" (${u})`])
    })

    describe('a project definition fully replaces the user one it shadows (it owns the agent)', () => {
      const userReader = agentMd(
        `name: orch-reader\ndescription: user one\ntools: ${ORCH_READER_TOOLS}\nharness:\n  opencode:\n    model: openai/gpt-6-luna#high`,
        'User prompt.'
      )

      it('with no tools key it gets no restrictions from the user file, and no model of the user either', () => {
        const r = rig()
        r.userFile('orch-reader', userReader)
        expect(r.load().agents['orch-reader'].permissions?.length).toBeGreaterThan(0)
        r.projectFile(
          'orch-reader',
          agentMd('name: orch-reader\ndescription: project one', 'Project prompt.')
        )
        const merged = r.load().agents['orch-reader']
        expect(merged.description).toBe('project one')
        expect(merged.system).toContain('Project prompt.')
        expect(merged.system).not.toContain('User prompt.')
        expect(merged).not.toHaveProperty('permissions')
        expect(merged).not.toHaveProperty('model')
      })

      it("the project file's model replaces the user's, and is allowlist-checked", () => {
        const r = rig()
        r.userFile('orch-reader', userReader)
        r.projectFile(
          'orch-reader',
          agentMd(
            'name: orch-reader\ndescription: project one\nharness:\n  opencode:\n    model: anthropic/opus'
          )
        )
        expect(r.load().agents['orch-reader'].model).toBe('anthropic/opus')
        const refused = r.load({ modelAllowlist: { anthropic: ['sonnet'] } })
        expect(refused.agents).toEqual({})
        expect(refused.diagnostics.join('\n')).toContain('not in the opencode model allowlist')
      })

      it("the project file's own tools list is the only one that applies", () => {
        const r = rig()
        r.userFile('orch-reader', userReader)
        r.projectFile(
          'orch-reader',
          agentMd('name: orch-reader\ndescription: p\ntools: Read, Edit')
        )
        const rules = r.load().agents['orch-reader'].permissions ?? []
        expect(rules).not.toContainEqual(deny('edit'))
        expect(rules).toContainEqual(deny('glob'))
      })
    })

    it('the nearer project directory wins', () => {
      const r = rig()
      const cwd = mkdir(path.join(r.root, 'pkg'))
      write(path.join(r.root, '.claude', 'agents', 'a.md'), agentMd('name: a\ndescription: root'))
      write(path.join(cwd, '.claude', 'agents', 'a.md'), agentMd('name: a\ndescription: near'))
      expect(r.load({ cwd }).agents.a.description).toBe('near')
    })

    it('a project folder that is the user folder (cwd = home) stays user scope', () => {
      const home = mkdir(path.join(base, 'home'))
      write(
        path.join(home, '.claude', 'agents', 'm.md'),
        agentMd('name: m\ndescription: d\nharness:\n  opencode:\n    model: openai/x')
      )
      const out = loadClaudeAgentsForOpencode({
        cwd: home,
        mcpServers: [],
        nativeAgentNames: [],
        modelAllowlist: {},
        claudeUserAgentsDir: path.join(home, '.claude', 'agents')
      })
      expect(out.agents.m.model).toBe('openai/x')
      expect(out.diagnostics).toEqual([])
    })

    it('reads ~/.claude/agents through os.homedir() by default', () => {
      const home = mkdir(path.join(base, 'home'))
      write(path.join(home, '.claude', 'agents', 'm.md'), agentMd('name: m\ndescription: d'))
      vi.spyOn(os, 'homedir').mockReturnValue(home)
      const out = loadClaudeAgentsForOpencode({
        cwd: mkdir(path.join(base, 'elsewhere')),
        mcpServers: [],
        nativeAgentNames: [],
        modelAllowlist: {}
      })
      expect(Object.keys(out.agents)).toEqual(['m'])
    })
  })

  describe('hostile and unusable files', () => {
    it('refuses ---js, alias bombs, oversized files, and names that are not agent ids', () => {
      const r = rig()
      const js = r.userFile(
        'evil',
        '---js\n(globalThis).__shimPwned = true; module.exports = { name: "evil", description: "x" }\n---\nbody\n'
      )
      const bomb = r.projectFile(
        'bomb',
        agentMd('name: bomb\ndescription: boom\na: &a ["x","x"]\nb: &b [*a,*a]\nc: [*b,*b]')
      )
      const spaced = r.userFile('spaced', agentMd('name: My Agent\ndescription: d'))
      r.userFile('ok', agentMd('name: ok\ndescription: fine'))
      const out = r.load()
      expect((globalThis as Record<string, unknown>).__shimPwned).toBeUndefined()
      expect(Object.keys(out.agents)).toEqual(['ok'])
      expect(out.diagnostics.find((d) => d.startsWith(js))).toMatch(/no front matter/)
      expect(out.diagnostics.find((d) => d.startsWith(bomb))).toMatch(/Alias resolution/)
      expect(out.diagnostics.find((d) => d.startsWith(spaced))).toMatch(/not usable as an opencode/)
      expect(out.diagnostics.join('\n')).not.toContain('globalThis')
    })

    it('a missing directory, or no .claude/agents anywhere, injects nothing silently', () => {
      const out = loadClaudeAgentsForOpencode({
        cwd: mkdir(path.join(base, 'p')),
        mcpServers: [],
        nativeAgentNames: [],
        modelAllowlist: {},
        claudeUserAgentsDir: path.join(base, 'nope')
      })
      expect(out).toEqual({ agents: {}, injected: [], diagnostics: [] })
    })
  })

  describe('size caps', () => {
    it('an agent whose injected JSON is over 8 KiB is skipped; the others stay', () => {
      const r = rig()
      const big = r.userFile(
        'big',
        agentMd('name: big\ndescription: d', 'x'.repeat(MAX_INJECTED_AGENT_BYTES))
      )
      r.userFile('small', agentMd('name: small\ndescription: d'))
      const out = r.load()
      expect(Object.keys(out.agents)).toEqual(['small'])
      expect(out.diagnostics).toHaveLength(1)
      expect(out.diagnostics[0].startsWith(`${big}: skipped (injected agent is `)).toBe(true)
      expect(out.diagnostics[0]).toMatch(/ bytes, over 8192\)$/)
    })

    it('the whole block is capped at 24 KiB: later names (by name order) are skipped, deterministically', () => {
      const r = rig()
      // ~6 KiB each: three fit under 24 KiB, the rest do not.
      for (const n of ['f', 'e', 'd', 'c', 'b', 'a']) {
        r.userFile(n, agentMd(`name: ${n}\ndescription: d`, n.repeat(6 * 1024)))
      }
      const out = r.load()
      expect(Object.keys(out.agents)).toEqual(['a', 'b', 'c'])
      expect(JSON.stringify(out.agents).length).toBeLessThanOrEqual(MAX_INJECTED_BLOCK_BYTES)
      expect(out.diagnostics).toHaveLength(3)
      expect(out.diagnostics.every((d) => /would pass 24576 bytes/.test(d))).toBe(true)
      // The result does not depend on read order.
      expect(Object.keys(r.load().agents)).toEqual(['a', 'b', 'c'])
    })
  })
})

describe('opencodeModelAllowed', () => {
  it('an unlisted provider is unrestricted; a listed one allows only its ids; the variant is ignored', () => {
    const list = { openai: ['gpt-6'], openrouter: ['anthropic/claude-x'] }
    expect(opencodeModelAllowed(list, 'anthropic/claude-opus')).toBe(true)
    expect(opencodeModelAllowed(list, 'openai/gpt-6')).toBe(true)
    expect(opencodeModelAllowed(list, 'openai/gpt-6#high')).toBe(true)
    expect(opencodeModelAllowed(list, 'openai/gpt-7')).toBe(false)
    expect(opencodeModelAllowed(list, 'openrouter/anthropic/claude-x')).toBe(true)
    expect(opencodeModelAllowed(list, 'openrouter/anthropic/other')).toBe(false)
    expect(opencodeModelAllowed(list, 'no-provider')).toBe(false)
    expect(opencodeModelAllowed({}, '__proto__/x')).toBe(true)
    expect(opencodeModelAllowed({ openai: [] }, 'openai/gpt-6')).toBe(false)
  })
})
