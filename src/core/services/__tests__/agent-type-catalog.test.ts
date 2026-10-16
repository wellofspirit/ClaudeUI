/**
 * @vitest-environment node
 *
 * The agent types an engine can spawn (ADR-094). Every filesystem read is an
 * isolated temp dir: HOME / USERPROFILE (Claude's and pi's user agents),
 * OPENCODE_CONFIG_DIR (opencode's) and the project `cwd` are all redirected, so
 * the user's real agent files are never read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { MAX_DIR_ENTRIES, listAgentTypes } from '../agent-type-catalog'

let root: string
let home: string
let project: string
const saved: Record<string, string | undefined> = {}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

beforeEach(() => {
  root = path.join(os.tmpdir(), `agent-types-${crypto.randomUUID()}`)
  home = path.join(root, 'home')
  project = path.join(root, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  for (const key of ['HOME', 'USERPROFILE', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG']) {
    saved[key] = process.env[key]
  }
  delete process.env.OPENCODE_CONFIG // opencode would read this file too: never the real one
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.OPENCODE_CONFIG_DIR = path.join(home, 'opencode')
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Claude Code', () => {
  it('lists the built-ins, with no definitions around', () => {
    const types = listAgentTypes('claude', project)
    expect(types.map((t) => t.type)).toEqual(
      expect.arrayContaining(['general-purpose', 'Explore', 'Plan'])
    )
    expect(types.every((t) => t.source === 'builtin')).toBe(true)
  })

  it('reads the agent definitions and their `color` frontmatter, user then project', () => {
    write(
      path.join(home, '.claude', 'agents', 'migration-reviewer.md'),
      '---\nname: migration-reviewer\ncolor: purple\ndescription: Reviews migrations\n---\nBody\n'
    )
    write(
      path.join(project, '.claude', 'agents', 'nested', 'scanner.md'),
      '---\nname: scanner\ncolor: "cyan"\n---\nBody\n'
    )
    const byType = Object.fromEntries(listAgentTypes('claude', project).map((t) => [t.type, t]))
    expect(byType['migration-reviewer']).toEqual({
      type: 'migration-reviewer',
      source: 'user',
      nativeColor: 'purple'
    })
    // Quotes are stripped from the colour, and nested dirs count.
    expect(byType['scanner']).toEqual({ type: 'scanner', source: 'project', nativeColor: 'cyan' })
  })

  it('skips a file with no frontmatter `name`, as Claude Code does', () => {
    write(
      path.join(project, '.claude', 'agents', 'noname.md'),
      '---\ndescription: no name key\ncolor: cyan\n---\nBody\n'
    )
    write(path.join(project, '.claude', 'agents', 'plain.md'), 'no frontmatter at all')
    write(path.join(project, '.claude', 'agents', 'blank.md'), '---\nname: ""\n---\nBody\n')
    const names = listAgentTypes('claude', project).map((t) => t.type)
    for (const stem of ['noname', 'plain', 'blank']) expect(names).not.toContain(stem)
    expect(names).not.toContain('')
  })

  it('strips a trailing YAML comment from the name and the colour', () => {
    write(
      path.join(project, '.claude', 'agents', 'c.md'),
      '---\nname: commented  # the reviewer\ncolor: purple  # note\n---\nBody\n'
    )
    expect(listAgentTypes('claude', project).find((t) => t.type === 'commented')).toEqual({
      type: 'commented',
      source: 'project',
      nativeColor: 'purple'
    })
  })

  it('stops reading a tree after MAX_DIR_ENTRIES entries of any kind', () => {
    const dir = path.join(project, '.claude', 'agents')
    write(path.join(dir, '0-first.md'), '---\nname: first\n---\n')
    // Far more junk than the cap, then an agent sorted after all of it.
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < MAX_DIR_ENTRIES + 500; i++) {
      fs.writeFileSync(path.join(dir, `a-${String(i).padStart(5, '0')}.txt`), '')
    }
    write(path.join(dir, 'z-last.md'), '---\nname: last\n---\n')
    const names = listAgentTypes('claude', project).map((t) => t.type)
    expect(names).toContain('first')
    expect(names).not.toContain('last')
  })

  it('counts entries across the whole tree, not per directory', () => {
    const dir = path.join(project, '.claude', 'agents')
    for (let d = 0; d < 5; d++) {
      fs.mkdirSync(path.join(dir, `d${d}`), { recursive: true })
      for (let i = 0; i < MAX_DIR_ENTRIES / 4; i++) {
        fs.writeFileSync(path.join(dir, `d${d}`, `n-${i}.txt`), '')
      }
    }
    write(path.join(dir, 'z-last.md'), '---\nname: last\n---\n')
    expect(listAgentTypes('claude', project).map((t) => t.type)).not.toContain('last')
  })

  it('still reads a linked agents root, under the same cap, and never follows a link inside', () => {
    const elsewhere = path.join(root, 'elsewhere')
    write(path.join(elsewhere, 'linked.md'), '---\nname: linked-agent\ncolor: pink\n---\n')
    const outside = path.join(root, 'outside')
    write(path.join(outside, 'secret.md'), '---\nname: outside-agent\n---\n')
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    // A junction needs no privilege on Windows (the type is ignored elsewhere).
    fs.symlinkSync(elsewhere, path.join(project, '.claude', 'agents'), 'junction')
    // ...and a link INSIDE the linked tree to somewhere else is not walked.
    try {
      fs.symlinkSync(outside, path.join(elsewhere, 'escape'), 'junction')
    } catch {
      // best effort: some filesystems refuse; the root-link assertion still holds
    }
    const names = listAgentTypes('claude', project).map((t) => t.type)
    expect(names).toContain('linked-agent')
    expect(names).not.toContain('outside-agent')
  })

  it('lets a project definition replace a user one of the same name', () => {
    write(path.join(home, '.claude', 'agents', 'a.md'), '---\nname: a\ncolor: red\n---\n')
    write(path.join(project, '.claude', 'agents', 'a.md'), '---\nname: a\ncolor: blue\n---\n')
    const a = listAgentTypes('claude', project).filter((t) => t.type === 'a')
    expect(a).toEqual([{ type: 'a', source: 'project', nativeColor: 'blue' }])
  })

  it('lists user definitions only when no cwd is given, and skips an oversized file', () => {
    write(
      path.join(home, '.claude', 'agents', 'big.md'),
      `---\nname: big\n---\n${'x'.repeat(70_000)}`
    )
    write(path.join(project, '.claude', 'agents', 'proj.md'), '---\nname: proj\n---\n')
    const types = listAgentTypes('claude').map((t) => t.type)
    expect(types).not.toContain('proj')
    expect(types).not.toContain('big')
  })
})

describe('opencode', () => {
  it('lists the subagent built-ins, not the primary or hidden ones, with colours', () => {
    write(
      path.join(home, 'opencode', 'agents', 'reviewer.md'),
      '---\nmode: subagent\ncolor: "#22d3ee"\n---\nBody\n'
    )
    write(path.join(home, 'opencode', 'agents', 'driver.md'), '---\nmode: primary\n---\nBody\n')
    const types = listAgentTypes('opencode', project)
    const names = types.map((t) => t.type)
    expect(names).toEqual(expect.arrayContaining(['general', 'explore', 'reviewer']))
    expect(names).not.toContain('build')
    expect(names).not.toContain('plan')
    expect(names).not.toContain('title')
    expect(names).not.toContain('driver')
    expect(types.find((t) => t.type === 'reviewer')).toEqual({
      type: 'reviewer',
      source: 'user',
      nativeColor: '#22d3ee'
    })
    expect(types.find((t) => t.type === 'general')?.source).toBe('builtin')
  })

  describe('Claude definitions injected by the agent shim (ADR-103)', () => {
    const claudeAgent = (name: string, extra = ''): string =>
      `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody\n`

    it('lists a user and a project definition, with the same native colour Claude gets', () => {
      write(
        path.join(home, '.claude', 'agents', 'orch-reader.md'),
        claudeAgent('orch-reader', 'color: green\n')
      )
      write(
        path.join(project, '.claude', 'agents', 'local-check.md'),
        claudeAgent('local-check', 'color: "cyan" # a comment\n')
      )
      const opencode = listAgentTypes('opencode', project)
      const claude = listAgentTypes('claude', project)
      for (const name of ['orch-reader', 'local-check']) {
        expect(opencode.find((t) => t.type === name)).toEqual(claude.find((t) => t.type === name))
      }
      expect(opencode.find((t) => t.type === 'orch-reader')).toEqual({
        type: 'orch-reader',
        source: 'user',
        nativeColor: 'green'
      })
      expect(opencode.find((t) => t.type === 'local-check')).toEqual({
        type: 'local-check',
        source: 'project',
        nativeColor: 'cyan'
      })
      // The native entries stay, ahead of the injected ones.
      const names = opencode.map((t) => t.type)
      expect(names.indexOf('general')).toBeLessThan(names.indexOf('orch-reader'))
    })

    it('lists the user definitions when there is no cwd', () => {
      write(path.join(home, '.claude', 'agents', 'solo.md'), claudeAgent('solo'))
      expect(listAgentTypes('opencode').find((t) => t.type === 'solo')).toEqual({
        type: 'solo',
        source: 'user'
      })
    })

    it('lists a name an opencode agent already has once, as the native entry', () => {
      write(
        path.join(home, 'opencode', 'agents', 'reviewer.md'),
        '---\nmode: subagent\ncolor: "#22d3ee"\n---\nBody\n'
      )
      write(
        path.join(home, '.claude', 'agents', 'reviewer.md'),
        claudeAgent('reviewer', 'color: green\n')
      )
      write(
        path.join(home, '.claude', 'agents', 'general.md'),
        claudeAgent('general', 'color: red\n')
      )
      const types = listAgentTypes('opencode', project)
      expect(types.filter((t) => t.type === 'reviewer')).toEqual([
        { type: 'reviewer', source: 'user', nativeColor: '#22d3ee' }
      ])
      expect(types.filter((t) => t.type === 'general')).toEqual([
        { type: 'general', source: 'builtin' }
      ])
    })

    it('omits a name a primary-only opencode agent holds: the shim skips it too', () => {
      write(path.join(home, 'opencode', 'agents', 'driver.md'), '---\nmode: primary\n---\nBody\n')
      write(path.join(home, '.claude', 'agents', 'driver.md'), claudeAgent('driver'))
      expect(listAgentTypes('opencode', project).some((t) => t.type === 'driver')).toBe(false)
    })

    it('omits a name opencode holds only as a mode/ file or a JSON agents entry: the shim skips it too', () => {
      write(path.join(home, 'opencode', 'mode', 'planner.md'), 'Plan things.')
      write(path.join(home, 'opencode', 'opencode.json'), '{ "agents": { "jsononly": {} } }')
      for (const name of ['planner', 'jsononly']) {
        write(path.join(home, '.claude', 'agents', `${name}.md`), claudeAgent(name))
      }
      const types = listAgentTypes('opencode', project)
      expect(types.some((t) => t.type === 'planner')).toBe(false)
      expect(types.some((t) => t.type === 'jsononly')).toBe(false)
    })
  })
})

describe('pi', () => {
  it('lists the registry: built-in, user and project definitions, with no colour', () => {
    write(
      path.join(home, '.pi', 'agent', 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Helps\ncolor: red\n---\nDo the thing.\n'
    )
    write(
      path.join(project, '.pi', 'agents', 'local.md'),
      '---\nname: local\ndescription: Local\n---\nDo it.\n'
    )
    const types = listAgentTypes('pi', project)
    expect(types.find((t) => t.type === 'general-purpose')?.source).toBe('builtin')
    expect(types.find((t) => t.type === 'helper')).toEqual({ type: 'helper', source: 'user' })
    expect(types.find((t) => t.type === 'local')).toEqual({ type: 'local', source: 'project' })
  })
})

describe('Codex', () => {
  it('lists the built-in roles', () => {
    expect(listAgentTypes('codex', project)).toEqual([
      { type: 'default', source: 'builtin' },
      { type: 'explorer', source: 'builtin' },
      { type: 'worker', source: 'builtin' }
    ])
  })
})
