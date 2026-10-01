import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadPiAgentRegistry,
  MAX_AGENT_FILE_BYTES,
  normalizeAgentName,
  parseAgentFile,
  renderAgentListing,
  type PiAgentDefinition
} from '../pi-agent-registry'

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
      source: 'builtin',
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
    expect(reg.resolve('explore')).toMatchObject({ source: 'user', description: 'user explore' })
    expect(reg.resolve('reviewer')).toMatchObject({
      source: 'project',
      description: 'nearer reviewer',
      filePath: nearer
    })
    expect(reg.resolve('root-only')?.source).toBe('project')
    expect(reg.resolve('only-user')?.source).toBe('user')
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
      source: 'project',
      overridesBuiltin: true
    })
    expect(reg.resolve('mine')?.overridesBuiltin).toBeUndefined()
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
    expect(reg.resolve('inside')?.source).toBe('project')
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
    expect(reg.resolve('ok')?.source).toBe('user')
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
      source: 'project',
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
