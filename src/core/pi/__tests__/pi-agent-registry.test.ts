import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPiAgentRegistry,
  MAX_AGENT_FILE_BYTES,
  normalizeAgentName,
  parseAgentFile,
  renderAgentListing,
  type PiAgentDefinition
} from '../pi-agent-registry'
import { buildPiSubagentChildArgs } from '../pi-subagents'

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

function agentMd(fields: string, body = 'The prompt.'): string {
  return `---\n${fields}\n---\n${body}\n`
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-registry-'))
  createdDirs.push(base)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const f of createdFiles.splice(0)) fs.unlinkSync(f)
  for (const d of createdDirs.splice(0).reverse()) fs.rmdirSync(d)
})

function emptyUserDir(): string {
  return mkdir(path.join(base, 'user-agents'))
}

describe('loadPiAgentRegistry', () => {
  it('has the three built-ins, general-purpose for an omitted type, matched case/dash-insensitively', () => {
    const reg = loadPiAgentRegistry({
      cwd: mkdir(path.join(base, 'proj')),
      userAgentsDir: emptyUserDir()
    })
    expect(reg.list().map((d) => d.name)).toEqual(['general-purpose', 'Explore', 'Plan'])
    expect(reg.resolve(undefined)?.name).toBe('general-purpose')
    expect(reg.resolve('')?.name).toBe('general-purpose')
    expect(reg.resolve('General_Purpose')?.name).toBe('general-purpose')
    const explore = reg.resolve('explore')
    expect(explore).toBe(reg.resolve('EXPLORE'))
    expect(explore).toMatchObject({
      name: 'Explore',
      scope: 'builtin',
      tools: ['read', 'bash', 'grep', 'find', 'ls'],
      permissionMode: 'plan',
      canSpawn: false
    })
    expect(reg.resolve('plan')).toMatchObject({ permissionMode: 'plan', canSpawn: false })
    expect(reg.resolve('general-purpose')).toMatchObject({ tools: 'inherit', canSpawn: true })
    expect(reg.resolve('nope')).toBeUndefined()
    expect(reg.diagnostics).toEqual([])
  })

  it('precedence: built-in < user < project, and the project dir nearer cwd wins', () => {
    const userDir = emptyUserDir()
    write(path.join(userDir, 'explore.md'), agentMd('name: Explore\ndescription: user explore'))
    write(path.join(userDir, 'reviewer.md'), agentMd('name: reviewer\ndescription: user reviewer'))
    write(path.join(userDir, 'only-user.md'), agentMd('name: only-user\ndescription: only in user'))
    const root = mkdir(path.join(base, 'repo'))
    mkdir(path.join(root, '.git'))
    write(
      path.join(root, '.pi', 'agents', 'reviewer.md'),
      agentMd('name: reviewer\ndescription: root reviewer')
    )
    write(
      path.join(root, '.pi', 'agents', 'root-only.md'),
      agentMd('name: root-only\ndescription: root only')
    )
    const cwd = mkdir(path.join(root, 'pkg'))
    const nearer = write(
      path.join(cwd, '.pi', 'agents', 'reviewer.md'),
      agentMd('name: Reviewer\ndescription: nearer reviewer')
    )

    const reg = loadPiAgentRegistry({ cwd, userAgentsDir: userDir })
    expect(reg.resolve('explore')).toMatchObject({ scope: 'user', description: 'user explore' })
    expect(reg.resolve('reviewer')).toMatchObject({
      scope: 'project',
      description: 'nearer reviewer',
      filePath: nearer
    })
    expect(reg.resolve('root-only')?.scope).toBe('project')
    expect(reg.resolve('only-user')?.scope).toBe('user')
    // Built-ins first (the overridden Explore is no longer one), then by name.
    expect(reg.list().map((d) => d.name)).toEqual([
      'general-purpose',
      'Plan',
      'Explore',
      'only-user',
      'Reviewer',
      'root-only'
    ])
  })

  it('F7: a project definition replacing a BUILT-IN type is noted (file named) and listed as (project)', () => {
    const root = mkdir(path.join(base, 'repo-f7'))
    mkdir(path.join(root, '.git'))
    const file = write(
      path.join(root, '.pi', 'agents', 'gp.md'),
      agentMd('name: general-purpose\ndescription: the repo version')
    )
    write(
      path.join(root, '.pi', 'agents', 'mine.md'),
      agentMd('name: mine\ndescription: a new type')
    )
    const reg = loadPiAgentRegistry({ cwd: root, userAgentsDir: emptyUserDir() })
    expect(reg.resolve('general-purpose')).toMatchObject({
      scope: 'project',
      overrides: 'builtin'
    })
    expect(reg.resolve('mine')?.overrides).toBeUndefined()
    expect(reg.diagnostics).toEqual([
      `project agent ${file} overrides the built-in "general-purpose"`
    ])
    const listing = renderAgentListing(reg)
    expect(listing).toContain('- general-purpose (project): the repo version')
    expect(listing).toContain('- mine: a new type')
  })

  it('a .git FILE marks the project root: no .pi/agents above it is read', () => {
    write(
      path.join(base, '.pi', 'agents', 'outside.md'),
      agentMd('name: outside\ndescription: above the root')
    )
    const root = mkdir(path.join(base, 'worktree'))
    write(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
    write(
      path.join(root, '.pi', 'agents', 'inside.md'),
      agentMd('name: inside\ndescription: at the root')
    )
    const cwd = mkdir(path.join(root, 'sub'))
    const reg = loadPiAgentRegistry({ cwd, userAgentsDir: emptyUserDir() })
    expect(reg.resolve('inside')?.scope).toBe('project')
    expect(reg.resolve('outside')).toBeUndefined()
  })

  it('never evaluates a ---js front matter: the file is skipped and the global stays unset', () => {
    const userDir = emptyUserDir()
    const file = write(
      path.join(userDir, 'evil.md'),
      '---js\n(globalThis).__piAgentRegistryPwned = true; module.exports = { name: "evil", description: "x" }\n---\nbody\n'
    )
    const reg = loadPiAgentRegistry({ cwd: mkdir(path.join(base, 'p')), userAgentsDir: userDir })
    expect((globalThis as Record<string, unknown>).__piAgentRegistryPwned).toBeUndefined()
    expect(reg.resolve('evil')).toBeUndefined()
    const diag = reg.diagnostics.find((d) => d.startsWith(file))
    expect(diag).toMatch(/no front matter/)
    // Diagnostics carry reasons, never file contents.
    expect(reg.diagnostics.join('\n')).not.toContain('globalThis')
  })

  it('skips an alias-bomb, a duplicate key, an oversized file, a non-file and missing name/description', () => {
    const userDir = emptyUserDir()
    const bomb = write(
      path.join(userDir, 'bomb.md'),
      agentMd(
        'name: bomb\ndescription: boom\na: &a ["x","x","x","x"]\nb: &b [*a,*a,*a,*a]\nc: [*b,*b,*b,*b]'
      )
    )
    const dup = write(
      path.join(userDir, 'dup.md'),
      agentMd('name: dup\nname: dup2\ndescription: d')
    )
    const big = write(
      path.join(userDir, 'big.md'),
      agentMd('name: big\ndescription: big', 'x'.repeat(MAX_AGENT_FILE_BYTES + 1))
    )
    const dirMd = mkdir(path.join(userDir, 'folder.md'))
    const noName = write(path.join(userDir, 'noname.md'), agentMd('description: d'))
    const noDesc = write(path.join(userDir, 'nodesc.md'), agentMd('name: nodesc'))
    const listy = write(path.join(userDir, 'listy.md'), agentMd('- name\n- description'))
    write(path.join(userDir, 'ok.md'), agentMd('name: ok\ndescription: fine'))
    write(path.join(userDir, 'notes.txt'), 'not an agent')

    const reg = loadPiAgentRegistry({ cwd: mkdir(path.join(base, 'p')), userAgentsDir: userDir })
    for (const n of ['bomb', 'dup', 'dup2', 'big', 'folder', 'nodesc']) {
      expect(reg.resolve(n)).toBeUndefined()
    }
    expect(reg.resolve('ok')?.scope).toBe('user')
    const reason = (file: string): string | undefined =>
      reg.diagnostics.find((d) => d.startsWith(`${file}: skipped`))
    // Refused because aliases are disabled outright (maxAliasCount: 0), not by a size budget.
    expect(reason(bomb)).toMatch(/invalid front matter: Alias resolution is disabled/)
    expect(reason(dup)).toMatch(/invalid front matter/)
    expect(reason(big)).toMatch(/larger than/)
    expect(reason(dirMd)).toMatch(/not a regular file/)
    expect(reason(noName)).toMatch(/name/)
    expect(reason(noDesc)).toMatch(/description/)
    expect(reason(listy)).toMatch(/not a key\/value map/)
    expect(reg.diagnostics.some((d) => d.includes('notes.txt'))).toBe(false)
  })

  it('a missing user dir is not a diagnostic', () => {
    const reg = loadPiAgentRegistry({
      cwd: mkdir(path.join(base, 'p')),
      userAgentsDir: path.join(base, 'does-not-exist')
    })
    expect(reg.diagnostics).toEqual([])
    expect(reg.list()).toHaveLength(3)
  })
})

describe('Claude agent definitions in pi', () => {
  const claudeMd = (name: string, extra = ''): string =>
    agentMd(`name: ${name}\ndescription: ${name} from claude${extra ? `\n${extra}` : ''}`)

  it('precedence: built-in < claude user < pi user < claude project < pi project', () => {
    const claudeUser = mkdir(path.join(base, 'claude-user'))
    const piUser = mkdir(path.join(base, 'pi-user'))
    const root = mkdir(path.join(base, 'repo'))
    mkdir(path.join(root, '.git'))
    const desc = (name: string, d: string): string => agentMd(`name: ${name}\ndescription: ${d}`)
    // n1: claude-user < pi-user; n2: pi-user < claude-project; n3: claude-project < pi-project;
    // plan: a built-in replaced by the lowest source; n5: only the lowest source has it.
    write(path.join(claudeUser, 'n1.md'), desc('n1', 'claude-user'))
    write(path.join(piUser, 'n1.md'), desc('n1', 'pi-user'))
    write(path.join(piUser, 'n2.md'), desc('n2', 'pi-user'))
    write(path.join(root, '.claude', 'agents', 'n2.md'), desc('n2', 'claude-project'))
    write(path.join(root, '.claude', 'agents', 'n3.md'), desc('n3', 'claude-project'))
    const n3 = write(path.join(root, '.pi', 'agents', 'n3.md'), desc('n3', 'pi-project'))
    write(path.join(claudeUser, 'plan.md'), desc('Plan', 'claude-user plan'))
    write(path.join(claudeUser, 'n5.md'), desc('n5', 'claude-user'))

    const reg = loadPiAgentRegistry({
      cwd: root,
      userAgentsDir: piUser,
      claudeUserAgentsDir: claudeUser
    })
    expect(reg.resolve('n1')).toMatchObject({
      description: 'pi-user',
      scope: 'user',
      origin: 'pi'
    })
    expect(reg.resolve('n2')).toMatchObject({
      description: 'claude-project',
      scope: 'project',
      origin: 'claude'
    })
    expect(reg.resolve('n3')).toMatchObject({
      description: 'pi-project',
      scope: 'project',
      origin: 'pi',
      filePath: n3
    })
    expect(reg.resolve('plan')).toMatchObject({ description: 'claude-user plan', scope: 'user' })
    expect(reg.resolve('n5')).toMatchObject({ scope: 'user', origin: 'claude' })
  })

  it('in nested project dirs the nearer directory wins, and within one the pi dir beats the claude dir', () => {
    const root = mkdir(path.join(base, 'repo'))
    mkdir(path.join(root, '.git'))
    const cwd = mkdir(path.join(root, 'pkg'))
    const d = (name: string, text: string): string => agentMd(`name: ${name}\ndescription: ${text}`)
    write(path.join(root, '.pi', 'agents', 'a.md'), d('a', 'root pi'))
    write(path.join(cwd, '.claude', 'agents', 'a.md'), d('a', 'near claude'))
    write(path.join(root, '.claude', 'agents', 'b.md'), d('b', 'root claude'))
    write(path.join(root, '.pi', 'agents', 'b.md'), d('b', 'root pi'))
    const reg = loadPiAgentRegistry({
      cwd,
      userAgentsDir: emptyUserDir(),
      claudeUserAgentsDir: path.join(base, 'no-claude')
    })
    expect(reg.resolve('a')).toMatchObject({ description: 'near claude', origin: 'claude' })
    expect(reg.resolve('b')).toMatchObject({ description: 'root pi', origin: 'pi' })
  })

  it('every override of a built-in or user agent is a diagnostic; a project one is marked (project)', () => {
    const claudeUser = mkdir(path.join(base, 'claude-user'))
    const piUser = mkdir(path.join(base, 'pi-user'))
    const root = mkdir(path.join(base, 'repo'))
    mkdir(path.join(root, '.git'))
    const ex = write(path.join(claudeUser, 'explore.md'), claudeMd('Explore'))
    const a1 = write(path.join(claudeUser, 'a.md'), claudeMd('a'))
    const a2 = write(path.join(piUser, 'a.md'), claudeMd('a'))
    const a3 = write(path.join(root, '.claude', 'agents', 'a.md'), claudeMd('a'))
    write(path.join(claudeUser, 'solo.md'), claudeMd('solo'))
    const reg = loadPiAgentRegistry({
      cwd: root,
      userAgentsDir: piUser,
      claudeUserAgentsDir: claudeUser
    })
    expect(reg.diagnostics).toEqual([
      `user agent ${ex} overrides the built-in "Explore"`,
      `user agent ${a2} overrides the user claude agent "a" (${a1})`,
      `project agent ${a3} overrides the user pi agent "a" (${a2})`
    ])
    const listing = renderAgentListing(reg)
    expect(listing).toContain('- a (project): a from claude')
    // A user override of a built-in is not marked, nor is a plain definition.
    expect(listing).toContain('- Explore: ')
    expect(listing).toContain('- solo: ')
  })

  it('a project folder that is the user folder (cwd = home) stays user scope', () => {
    const home = mkdir(path.join(base, 'home'))
    write(path.join(home, '.claude', 'agents', 'mine.md'), claudeMd('mine', 'model: x/y'))
    const reg = loadPiAgentRegistry({
      cwd: home,
      userAgentsDir: emptyUserDir(),
      claudeUserAgentsDir: path.join(home, '.claude', 'agents')
    })
    expect(reg.resolve('mine')).toMatchObject({ scope: 'user', model: 'x/y' })
  })

  it('reads ~/.claude/agents through os.homedir() by default', () => {
    const home = mkdir(path.join(base, 'home'))
    write(path.join(home, '.claude', 'agents', 'mine.md'), claudeMd('mine'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const reg = loadPiAgentRegistry({
      cwd: mkdir(path.join(base, 'p')),
      userAgentsDir: emptyUserDir()
    })
    expect(reg.resolve('mine')).toMatchObject({ scope: 'user', origin: 'claude' })
  })

  it('hostile Claude-dir input is refused like pi-dir input', () => {
    const claudeUser = mkdir(path.join(base, 'claude-user'))
    const root = mkdir(path.join(base, 'repo'))
    mkdir(path.join(root, '.git'))
    const js = write(
      path.join(claudeUser, 'evil.md'),
      '---js\n(globalThis).__sharedPwned = true; module.exports = { name: "evil", description: "x" }\n---\nbody\n'
    )
    const bomb = write(
      path.join(root, '.claude', 'agents', 'bomb.md'),
      agentMd('name: bomb\ndescription: boom\na: &a ["x","x"]\nb: &b [*a,*a]\nc: [*b,*b]')
    )
    const reg = loadPiAgentRegistry({
      cwd: root,
      userAgentsDir: emptyUserDir(),
      claudeUserAgentsDir: claudeUser
    })
    expect((globalThis as Record<string, unknown>).__sharedPwned).toBeUndefined()
    expect(reg.resolve('evil')).toBeUndefined()
    expect(reg.resolve('bomb')).toBeUndefined()
    expect(reg.diagnostics.find((x) => x.startsWith(js))).toMatch(/no front matter/)
    expect(reg.diagnostics.find((x) => x.startsWith(bomb))).toMatch(/Alias resolution is disabled/)
  })
})

describe('model selection by scope', () => {
  const parseAs = (
    scope: 'user' | 'project',
    fields: string,
    diagnostics: string[] = [],
    origin: 'claude' | 'pi' = 'claude'
  ): PiAgentDefinition => {
    const r = parseAgentFile(agentMd(fields), scope, '/x/a.md', diagnostics, origin)
    if ('error' in r) throw new Error(r.error)
    return r
  }
  const head = 'name: a\ndescription: d'

  it('user scope: harness.pi.model wins over model, with no complaint about a Claude alias beside it', () => {
    const diagnostics: string[] = []
    const def = parseAs(
      'user',
      `${head}\nmodel: sonnet\nharness:\n  pi:\n    model: openai-codex/gpt-6-luna\n  opencode:\n    model: openai/gpt-6-luna`,
      diagnostics
    )
    expect(def.model).toBe('openai-codex/gpt-6-luna')
    expect(diagnostics).toEqual([])
    // Another harness's block is not ours.
    expect(parseAs('user', `${head}\nharness:\n  opencode:\n    model: openai/x`).model).toBe(
      'inherit'
    )
    // The top-level provider/id form still works without a harness block.
    expect(parseAs('user', `${head}\nmodel: anthropic/m`).model).toBe('anthropic/m')
  })

  it('user scope: a harness.pi.model that is not a pi model inherits (it does not fall back to model)', () => {
    const diagnostics: string[] = []
    expect(
      parseAs('user', `${head}\nmodel: anthropic/m\nharness:\n  pi:\n    model: luna`, diagnostics)
        .model
    ).toBe('inherit')
    expect(diagnostics).toEqual([
      '/x/a.md: model "luna" is not a pi model value (provider/id); inheriting'
    ])
  })

  it('a harness block that is not a map is ignored with a warning, at either level', () => {
    for (const harness of ['harness: pi', 'harness:\n  pi: openai/x', 'harness: [pi]']) {
      const diagnostics: string[] = []
      expect(parseAs('user', `${head}\nmodel: a/b\n${harness}`, diagnostics).model).toBe('a/b')
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatch(/harness(\.pi)? is not a key\/value map; ignored/)
    }
  })

  it('project scope, claude origin: resolves exactly like a user file (harness.pi.model beats model)', () => {
    const diagnostics: string[] = []
    expect(parseAs('project', `${head}\nmodel: openai/gpt-x`, diagnostics).model).toBe(
      'openai/gpt-x'
    )
    expect(
      parseAs('project', `${head}\nharness:\n  pi:\n    model: openai/gpt-y`, diagnostics).model
    ).toBe('openai/gpt-y')
    expect(
      parseAs(
        'project',
        `${head}\nmodel: sonnet\nharness:\n  pi:\n    model: openai/gpt-x`,
        diagnostics
      ).model
    ).toBe('openai/gpt-x')
    expect(parseAs('project', `${head}\nmodel: inherit`, diagnostics).model).toBe('inherit')
    expect(parseAs('project', head, diagnostics).model).toBe('inherit')
    expect(diagnostics).toEqual([])
    // A Claude alias inherits, with a warning, as in user scope.
    const alias: string[] = []
    expect(parseAs('project', `${head}\nmodel: sonnet`, alias).model).toBe('inherit')
    expect(alias).toEqual([
      '/x/a.md: model "sonnet" is not a pi model value (provider/id); inheriting'
    ])
  })

  it('project scope, pi origin: model and harness.pi.model are honoured', () => {
    const diagnostics: string[] = []
    expect(parseAs('project', `${head}\nmodel: openai/gpt-x`, diagnostics, 'pi').model).toBe(
      'openai/gpt-x'
    )
    expect(
      parseAs(
        'project',
        `${head}\nmodel: a/b\nharness:\n  pi:\n    model: openai/gpt-y`,
        diagnostics,
        'pi'
      ).model
    ).toBe('openai/gpt-y')
    expect(parseAs('project', `${head}\nmodel: inherit`, diagnostics, 'pi').model).toBe('inherit')
    expect(diagnostics).toEqual([])
    const bad: string[] = []
    expect(parseAs('project', `${head}\nmodel: sonnet`, bad, 'pi').model).toBe('inherit')
    expect(bad).toEqual([
      '/x/a.md: model "sonnet" is not a pi model value (provider/id); inheriting'
    ])
  })

  it('end to end: a project model is honoured from .pi/agents and from .claude/agents alike', () => {
    const text = agentMd('name: pinned\ndescription: d\nmodel: openai/gpt-x')
    const load = (cwd: string): PiAgentDefinition | undefined =>
      loadPiAgentRegistry({
        cwd,
        userAgentsDir: emptyUserDir(),
        claudeUserAgentsDir: path.join(base, 'no-claude')
      }).resolve('pinned')
    const piRepo = mkdir(path.join(base, 'pi-repo'))
    mkdir(path.join(piRepo, '.git'))
    write(path.join(piRepo, '.pi', 'agents', 'pinned.md'), text)
    expect(load(piRepo)).toMatchObject({ scope: 'project', origin: 'pi', model: 'openai/gpt-x' })
    const claudeRepo = mkdir(path.join(base, 'claude-repo'))
    mkdir(path.join(claudeRepo, '.git'))
    write(path.join(claudeRepo, '.claude', 'agents', 'pinned.md'), text)
    expect(load(claudeRepo)).toMatchObject({
      scope: 'project',
      origin: 'claude',
      model: 'openai/gpt-x'
    })
  })

  it('a Claude alias in model with no harness key inherits, with a diagnostic', () => {
    const diagnostics: string[] = []
    expect(parseAs('user', `${head}\nmodel: sonnet`, diagnostics).model).toBe('inherit')
    expect(diagnostics).toHaveLength(1)
    expect(parseAs('user', `${head}\nmodel: opus`).model).toBe('inherit')
  })
})

describe('agent listing for pi', () => {
  it('hides Claude-only tool names (WebFetch), shows extension and MCP tools, keeps the argv unchanged', () => {
    const claudeUser = mkdir(path.join(base, 'claude-user'))
    write(
      path.join(claudeUser, 'orch-reader.md'),
      agentMd(
        'name: orch-reader\ndescription: Collects evidence.\ntools: Read, Grep, Glob, Bash, WebFetch, websearch, mcp__gh__issues, my_ext\nmodel: sonnet'
      )
    )
    write(
      path.join(claudeUser, 'no-web.md'),
      agentMd(
        'name: no-web\ndescription: Anything but the web.\ndisallowedTools: webfetch, Write, my_ext'
      )
    )
    write(
      path.join(claudeUser, 'web-only.md'),
      agentMd('name: web-only\ndescription: Web only.\ntools: WebFetch')
    )
    const reg = loadPiAgentRegistry({
      cwd: mkdir(path.join(base, 'p')),
      userAgentsDir: emptyUserDir(),
      claudeUserAgentsDir: claudeUser
    })
    const lines = renderAgentListing(reg).split('\n')
    expect(lines).toContain(
      '- orch-reader: Collects evidence. (Tools: read, grep, find, bash, mcp__gh__issues, my_ext)'
    )
    expect(lines).toContain(
      '- no-web: Anything but the web. (Tools: All tools except write, my_ext)'
    )
    expect(lines).toContain('- web-only: Web only. (Tools: none)')
    expect(renderAgentListing(reg)).not.toMatch(/webfetch|websearch/i)
    // The child's argv still carries every name as written (pi ignores an unknown one).
    const args = buildPiSubagentChildArgs({
      dir: '/d',
      agentId: 'ag',
      promptFile: '/p.md',
      definition: reg.resolve('orch-reader')!,
      childCanSpawn: false
    })
    expect(args[args.indexOf('--tools') + 1].split(',')).toEqual(
      expect.arrayContaining(['WebFetch', 'websearch', 'my_ext'])
    )
  })
})

describe('parseAgentFile', () => {
  const parse = (fields: string, diagnostics: string[] = []): PiAgentDefinition => {
    const r = parseAgentFile(agentMd(fields), 'user', '/x/a.md', diagnostics)
    if ('error' in r) throw new Error(r.error)
    return r
  }

  it('maps Claude Code tool names case-insensitively and passes other names through', () => {
    expect(
      parse('name: a\ndescription: d\ntools: Read, Glob, BASH, Task, LS, grep, Edit, Write, my_ext')
        .tools
    ).toEqual(['read', 'find', 'bash', 'agent', 'ls', 'grep', 'edit', 'write', 'my_ext'])
    expect(parse('name: a\ndescription: d\ntools: [Agent, Read, read]').tools).toEqual([
      'agent',
      'read'
    ])
    expect(parse('name: a\ndescription: d\ndisallowedTools: Write, Edit').disallowedTools).toEqual([
      'write',
      'edit'
    ])
  })

  it('omitted and * mean inherit; an explicitly empty value means refuse', () => {
    expect(parse('name: a\ndescription: d').tools).toBe('inherit')
    expect(parse('name: a\ndescription: d\ntools: "*"').tools).toBe('inherit')
    expect(parse('name: a\ndescription: d\ntools: [read, "*"]').tools).toBe('inherit')
    expect(parse('name: a\ndescription: d\ntools: []').tools).toEqual([])
    expect(parse("name: a\ndescription: d\ntools: ''").tools).toEqual([])
    expect(parse('name: a\ndescription: d\ndisallowedTools: "*"').tools).toEqual([])
  })

  it('drops a tool entry that is not a tool name, with a diagnostic', () => {
    const diagnostics: string[] = []
    expect(
      parse('name: a\ndescription: d\ntools: [read, "Bash(git *)"]', diagnostics).tools
    ).toEqual(['read'])
    expect(diagnostics).toEqual(['/x/a.md: tools: ignored an entry that is not a tool name'])
  })

  it('ignores a +name/-name tool entry (pi 1.1.0 --tools modifiers), so the generated --tools list never mixes', () => {
    const diagnostics: string[] = []
    const def = parse(
      'name: a\ndescription: d\ntools: [read, -foo, +bar, "-", my-ext, mcp__gh__x]\ndisallowedTools: [-write, edit]',
      diagnostics
    )
    expect(def.tools).toEqual(['read', 'my-ext', 'mcp__gh__x'])
    expect(def.disallowedTools).toEqual(['edit'])
    expect(diagnostics).toEqual([
      '/x/a.md: tools: ignored an entry that is not a tool name',
      '/x/a.md: tools: ignored an entry that is not a tool name',
      '/x/a.md: tools: ignored an entry that is not a tool name',
      '/x/a.md: disallowedTools: ignored an entry that is not a tool name'
    ])
    for (const childCanSpawn of [false, true]) {
      const args = buildPiSubagentChildArgs({
        dir: '/d',
        agentId: 'ag',
        promptFile: '/p.md',
        definition: def,
        childCanSpawn
      })
      const tools = args[args.indexOf('--tools') + 1].split(',')
      expect(tools).toContain('send_message')
      expect(tools.filter((t) => t.startsWith('+') || t.startsWith('-'))).toEqual([])
      const exclude = args[args.indexOf('--exclude-tools') + 1].split(',')
      expect(exclude.filter((t) => t.startsWith('+') || t.startsWith('-'))).toEqual([])
    }
  })

  it('an unknown permissionMode fails safe to default, with a diagnostic', () => {
    const diagnostics: string[] = []
    expect(parse('name: a\ndescription: d\npermissionMode: yolo', diagnostics).permissionMode).toBe(
      'default'
    )
    expect(diagnostics).toHaveLength(1)
    expect(parse('name: a\ndescription: d\npermissionMode: acceptEdits').permissionMode).toBe(
      'acceptEdits'
    )
    expect(parse('name: a\ndescription: d').permissionMode).toBeUndefined()
  })

  it('reads thinking, or Claude Code effort as its alias; an invalid level is ignored', () => {
    expect(parse('name: a\ndescription: d\neffort: high').thinking).toBe('high')
    expect(parse('name: a\ndescription: d\nthinking: xhigh\neffort: low').thinking).toBe('xhigh')
    const diagnostics: string[] = []
    expect(
      parse('name: a\ndescription: d\nthinking: extreme', diagnostics).thinking
    ).toBeUndefined()
    expect(diagnostics).toHaveLength(1)
  })

  it('model: a provider/id value is kept; inherit, absent or a bare alias inherit', () => {
    expect(parse('name: a\ndescription: d\nmodel: openai-codex/gpt-5.6-luna').model).toBe(
      'openai-codex/gpt-5.6-luna'
    )
    expect(parse('name: a\ndescription: d\nmodel: inherit').model).toBe('inherit')
    expect(parse('name: a\ndescription: d').model).toBe('inherit')
    const diagnostics: string[] = []
    expect(parse('name: a\ndescription: d\nmodel: sonnet', diagnostics).model).toBe('inherit')
    expect(diagnostics).toHaveLength(1)
  })

  it('collapses the description, trims the body, keeps background, accepts a BOM and CRLF', () => {
    const r = parseAgentFile(
      '﻿---\r\nname: My Agent\r\ndescription: |\r\n  line one\r\n  line two\r\nbackground: true\r\ncolor: red\r\n---\r\n\r\n  Do the thing.  \r\n',
      'project',
      '/x/b.md'
    )
    expect(r).toMatchObject({
      name: 'My Agent',
      description: 'line one line two',
      prompt: 'Do the thing.',
      background: true,
      scope: 'project',
      filePath: '/x/b.md',
      canSpawn: true
    })
  })

  it('rejects a bad name and an unterminated block', () => {
    expect(parseAgentFile(agentMd('name: "-bad"\ndescription: d'), 'user', undefined)).toEqual({
      error: 'missing or invalid name'
    })
    expect(
      parseAgentFile(agentMd(`name: ${'a'.repeat(65)}\ndescription: d`), 'user', undefined)
    ).toEqual({ error: 'missing or invalid name' })
    expect(parseAgentFile('---\nname: a\ndescription: d\n', 'user', undefined)).toEqual({
      error: 'unterminated front matter'
    })
  })
})

describe('normalizeAgentName', () => {
  it('lowercases and strips dashes, underscores and spaces', () => {
    expect(normalizeAgentName('General_Purpose - X')).toBe('generalpurposex')
  })
})

describe('renderAgentListing', () => {
  it('one line per agent with its tools', () => {
    const userDir = emptyUserDir()
    write(
      path.join(userDir, 'r.md'),
      agentMd('name: reviewer\ndescription: Reviews diffs.\ndisallowedTools: write, edit')
    )
    write(
      path.join(userDir, 'refuse.md'),
      agentMd('name: refuser\ndescription: No tools.\ntools: []')
    )
    const reg = loadPiAgentRegistry({ cwd: mkdir(path.join(base, 'p')), userAgentsDir: userDir })
    // A refuse-to-spawn agent is not listed, but still resolves (for its explicit refusal).
    expect(reg.resolve('refuser')?.tools).toEqual([])
    expect(renderAgentListing(reg).split('\n')).toEqual([
      '- general-purpose: A general agent for researching complex questions, searching code and carrying out multi-step tasks. (Tools: All tools)',
      expect.stringMatching(/^- Explore: .+ \(Tools: read, bash, grep, find, ls\)$/),
      expect.stringMatching(/^- Plan: .+ \(Tools: read, bash, grep, find, ls\)$/),
      '- reviewer: Reviews diffs. (Tools: All tools except write, edit)'
    ])
  })

  it('caps each description at 300 chars and the listing at maxChars, ending with …and N more', () => {
    const userDir = emptyUserDir()
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, '0')
      write(
        path.join(userDir, `a${n}.md`),
        agentMd(`name: agent-${n}\ndescription: ${'d'.repeat(400)}`)
      )
    }
    const reg = loadPiAgentRegistry({ cwd: mkdir(path.join(base, 'p')), userAgentsDir: userDir })
    const full = renderAgentListing(reg, 1_000_000)
    const line = full.split('\n').find((l) => l.startsWith('- agent-00:'))!
    expect(line).toBe(`- agent-00: ${'d'.repeat(299)}… (Tools: All tools)`)

    const capped = renderAgentListing(reg, 2_000)
    expect(capped.length).toBeLessThanOrEqual(2_000)
    const lines = capped.split('\n')
    const shown = lines.length - 1
    expect(lines.at(-1)).toBe(`…and ${33 - shown} more`)
    expect(lines.slice(0, -1).every((l) => l.startsWith('- '))).toBe(true)
  })
})

describe('a project definition owns the agent it shadows', () => {
  let root: string
  let claudeUser: string
  let piUser: string
  const md = (fields: string, body = 'The prompt.'): string => agentMd(fields, body)
  const load = (cwd?: string): ReturnType<typeof loadPiAgentRegistry> =>
    loadPiAgentRegistry({
      cwd: cwd ?? root,
      userAgentsDir: piUser,
      claudeUserAgentsDir: claudeUser
    })

  beforeEach(() => {
    claudeUser = mkdir(path.join(base, 'claude-user'))
    piUser = mkdir(path.join(base, 'pi-user'))
    root = mkdir(path.join(base, 'repo'))
    mkdir(path.join(root, '.git'))
  })

  it('a project file with no tools key gets no restrictions from the user file; its model and mode are its own', () => {
    write(
      path.join(claudeUser, 'rev.md'),
      md(
        'name: rev\ndescription: user one\ntools: Read, Grep\ndisallowedTools: Bash\npermissionMode: plan\nharness:\n  pi:\n    model: openai/user-model',
        'User prompt.'
      )
    )
    const project = write(
      path.join(root, '.claude', 'agents', 'rev.md'),
      md(
        'name: rev\ndescription: project one\nharness:\n  pi:\n    model: anthropic/opus-x',
        'Project prompt.'
      )
    )
    const reg = load()
    expect(reg.resolve('rev')).toMatchObject({
      scope: 'project',
      overrides: 'user',
      description: 'project one',
      prompt: 'Project prompt.',
      tools: 'inherit',
      disallowedTools: [],
      model: 'anthropic/opus-x'
    })
    expect(reg.resolve('rev')?.permissionMode).toBeUndefined()
    expect(reg.diagnostics).toEqual([
      `project agent ${project} overrides the user claude agent "rev" (${path.join(claudeUser, 'rev.md')})`
    ])
    expect(renderAgentListing(reg)).toContain('- rev (project): project one (Tools: All tools)')
  })

  it('a project Explore replaces the built-in whole: its tools, mode and spawning are the file’s', () => {
    write(
      path.join(root, '.claude', 'agents', 'explore.md'),
      md('name: Explore\ndescription: the repo explorer\ntools: Read, Edit')
    )
    expect(load().resolve('Explore')).toMatchObject({
      scope: 'project',
      overrides: 'builtin',
      tools: ['read', 'edit'],
      canSpawn: true
    })
    expect(load().resolve('Explore')?.permissionMode).toBeUndefined()
  })

  it('a project definition with no earlier definition under it is plain precedence', () => {
    write(
      path.join(root, '.claude', 'agents', 'p.md'),
      md('name: p\ndescription: root\ntools: Read')
    )
    const nested = mkdir(path.join(root, 'pkg'))
    write(path.join(nested, '.claude', 'agents', 'p.md'), md('name: p\ndescription: near'))
    expect(load(nested).resolve('p')).toMatchObject({ description: 'near', tools: 'inherit' })
    expect(load(nested).diagnostics.join('\n')).not.toContain('overrides')
  })

  it('two user-scope sources keep plain precedence: pi user replaces claude user whole', () => {
    write(
      path.join(claudeUser, 'a.md'),
      md('name: a\ndescription: claude user\ntools: Read\npermissionMode: plan')
    )
    write(path.join(piUser, 'a.md'), md('name: a\ndescription: pi user'))
    const a = load().resolve('a')!
    expect(a).toMatchObject({
      scope: 'user',
      origin: 'pi',
      description: 'pi user',
      tools: 'inherit'
    })
    expect(a.permissionMode).toBeUndefined()
  })
})
