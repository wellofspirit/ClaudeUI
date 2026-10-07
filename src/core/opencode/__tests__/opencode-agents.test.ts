/**
 * @vitest-environment node
 *
 * Tests for opencode-agents.ts: CRUD service for opencode agent markdown files.
 * All filesystem operations use isolated tmp directories and OPENCODE_CONFIG_DIR env var.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), 'oc-agents-test-' + crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}

function writeAgentFile(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf8')
}

// ─── Test state ───────────────────────────────────────────────────────────────

let configDir: string
let originalEnv: string | undefined

beforeEach(() => {
  originalEnv = process.env.OPENCODE_CONFIG_DIR
  configDir = makeTmpDir()
  process.env.OPENCODE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = originalEnv
  }
  rmTmpDir(configDir)
})

// ─── Import SUT after env is set ──────────────────────────────────────────────
// We import dynamically so OPENCODE_CONFIG_DIR is read per-call (opencodeConfigDir()
// reads the env at call time, not import time).

import {
  AGENT_GRID_ACTIONS,
  listAgents,
  readAgent,
  saveAgent,
  deleteAgent,
  setAgentDisabled
} from '../opencode-agents'
import { wildcardMatch } from '../../../shared/opencode-wildcard'
import matter from 'gray-matter'
import { isLegacyAgentFrontmatter } from '../../../shared/opencode-config-v1'

function frontmatter(file: string): Record<string, unknown> {
  return { ...matter(fs.readFileSync(file, 'utf8')).data }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('listAgents', () => {
  it('returns all built-ins even when no files exist', () => {
    const agents = listAgents()
    const names = agents.map((a) => a.name)
    expect(names).toContain('build')
    expect(names).toContain('plan')
    expect(names).toContain('general')
    expect(names).toContain('explore')
    expect(names).toContain('title')
    expect(names).toContain('summary')
    expect(names).toContain('compaction')
    agents
      .filter((a) => a.kind === 'builtin')
      .forEach((a) => {
        expect(a.scope).toBeNull()
      })
  })

  it('shows a custom *.md file as kind=custom, scope=global', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(
      agentsDir,
      'my-custom-agent',
      `---\nmode: subagent\ndescription: A custom one\n---\nDo stuff.`
    )

    const agents = listAgents()
    const custom = agents.find((a) => a.name === 'my-custom-agent')
    expect(custom).toBeDefined()
    expect(custom!.kind).toBe('custom')
    expect(custom!.scope).toBe('global')
    expect(custom!.mode).toBe('subagent')
  })

  it('marks a built-in override file as overridden=true and keeps kind=builtin', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(
      agentsDir,
      'build',
      `---\nmode: primary\ndescription: overridden build\n---\nCustom build prompt.`
    )

    const agents = listAgents()
    const buildAgent = agents.find((a) => a.name === 'build')
    expect(buildAgent).toBeDefined()
    // An overridden built-in stays in the Built-in group (C2 groups by kind).
    expect(buildAgent!.kind).toBe('builtin')
    expect(buildAgent!.overridden).toBe(true)
  })

  it('falls back to the built-in default mode when an override omits mode', () => {
    // 'plan' is a built-in primary. Override only the model, omit `mode`.
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(
      agentsDir,
      'plan',
      `---\nmodel: anthropic/claude-opus-4\n---\nCustom plan prompt.`
    )

    const agents = listAgents()
    const planAgent = agents.find((a) => a.name === 'plan')
    expect(planAgent).toBeDefined()
    expect(planAgent!.kind).toBe('builtin')
    expect(planAgent!.overridden).toBe(true)
    // Must report the built-in's real default mode, not 'all'.
    expect(planAgent!.mode).toBe('primary')
  })

  it('project overrides global on a same-name collision (scope badge = project)', () => {
    const cwd = makeTmpDir()
    try {
      // Same custom name in both global and project; project must win.
      writeAgentFile(path.join(configDir, 'agents'), 'shared-name', `---\nmode: all\n---\nglobal`)
      writeAgentFile(
        path.join(cwd, '.opencode', 'agents'),
        'shared-name',
        `---\nmode: subagent\n---\nproject`
      )

      const agents = listAgents(cwd)
      const matches = agents.filter((a) => a.name === 'shared-name')
      // No duplicate; the surviving entry is the project one.
      expect(matches).toHaveLength(1)
      expect(matches[0].scope).toBe('project')
      expect(matches[0].mode).toBe('subagent')
    } finally {
      rmTmpDir(cwd)
    }
  })

  it('reflects disable:true as disabled=true', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, 'my-agent', `---\nmode: primary\ndisable: true\n---\n`)

    const agents = listAgents()
    const a = agents.find((a) => a.name === 'my-agent')
    expect(a).toBeDefined()
    expect(a!.disabled).toBe(true)
  })

  it('scans both agent/ and agents/ subdirs (singular and plural)', () => {
    // Write to the singular 'agent/' subdir
    const agentDir = path.join(configDir, 'agent')
    writeAgentFile(agentDir, 'singular-dir-agent', `---\nmode: all\n---\n`)

    const agents = listAgents()
    const found = agents.find((a) => a.name === 'singular-dir-agent')
    expect(found).toBeDefined()
    expect(found!.scope).toBe('global')
  })

  it('scans project .opencode/agents when cwd is provided', () => {
    const cwd = makeTmpDir()
    try {
      const projectAgentsDir = path.join(cwd, '.opencode', 'agents')
      writeAgentFile(projectAgentsDir, 'project-agent', `---\nmode: subagent\n---\n`)

      const agents = listAgents(cwd)
      const found = agents.find((a) => a.name === 'project-agent')
      expect(found).toBeDefined()
      expect(found!.scope).toBe('project')
    } finally {
      rmTmpDir(cwd)
    }
  })

  it('sorts custom agents before built-ins, alpha within each group', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, 'zebra-agent', `---\nmode: all\n---\n`)
    writeAgentFile(agentsDir, 'alpha-agent', `---\nmode: all\n---\n`)

    const agents = listAgents()
    const customAgents = agents.filter((a) => a.kind === 'custom')
    const builtins = agents.filter((a) => a.kind === 'builtin')

    // All custom agents appear before built-ins
    const lastCustomIdx = agents.findLastIndex((a) => a.kind === 'custom')
    const firstBuiltinIdx = agents.findIndex((a) => a.kind === 'builtin')
    expect(lastCustomIdx).toBeLessThan(firstBuiltinIdx)

    // Alpha ordering within custom group
    const customNames = customAgents.map((a) => a.name)
    expect(customNames).toEqual([...customNames].sort())

    // Alpha ordering within builtin group
    const builtinNames = builtins.map((a) => a.name)
    expect(builtinNames).toEqual([...builtinNames].sort())
  })

  it('hidden:true is reflected in summary', () => {
    // Built-in 'title' is marked hidden
    const agents = listAgents()
    const title = agents.find((a) => a.name === 'title')
    expect(title!.hidden).toBe(true)
  })
})

describe('JavaScript front matter is never evaluated', () => {
  const marker = '__claudeuiFrontmatterEval'

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[marker]
  })

  it.each(['js', 'javascript'])(
    '---%s front matter is not run when agents are listed or read',
    (lang) => {
      const agentsDir = path.join(configDir, 'agents')
      writeAgentFile(
        agentsDir,
        'planted',
        `---${lang}
({ description: (globalThis.${marker} = true, 'x'), mode: 'subagent' })
---
Body.`
      )

      listAgents()
      readAgent('planted', 'global')

      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
    }
  )
})

describe('readAgent → saveAgent round-trip', () => {
  it('round-trips topP ↔ top_p', () => {
    saveAgent({
      name: 'rp-agent',
      scope: 'global',
      mode: 'all',
      topP: 0.85
    })

    const detail = readAgent('rp-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.topP).toBe(0.85)
  })

  it('round-trips reasoningEffort ↔ the model variant (model: p/m#effort)', () => {
    saveAgent({
      name: 'reasoning-agent',
      scope: 'global',
      mode: 'primary',
      model: 'openai/gpt-6',
      reasoningEffort: 'high'
    })

    const detail = readAgent('reasoning-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.model).toBe('openai/gpt-6')
    expect(detail!.reasoningEffort).toBe('high')
  })

  it('round-trips body ↔ prompt', () => {
    saveAgent({
      name: 'prompt-agent',
      scope: 'global',
      mode: 'subagent',
      prompt: 'You are a helpful assistant.'
    })

    const detail = readAgent('prompt-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.prompt).toBe('You are a helpful assistant.')
  })

  it('round-trips the grid as 2.x rules; allow writes no rule', () => {
    saveAgent({
      name: 'restricted-agent',
      scope: 'global',
      mode: 'all',
      permission: { shell: 'deny', edit: 'ask', read: 'allow' }
    })

    const detail = readAgent('restricted-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.restrict).toBe(true)
    expect(detail!.permission).toEqual({ shell: 'deny', edit: 'ask' })
    const data = frontmatter(path.join(configDir, 'agents', 'restricted-agent.md'))
    expect(data.permissions).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'ask' }
    ])
  })

  it('no permission → restrict=false and no permission key', () => {
    saveAgent({
      name: 'free-agent',
      scope: 'global',
      mode: 'all'
    })

    const detail = readAgent('free-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.restrict).toBe(false)
    expect(detail!.permission).toBeUndefined()
  })

  it('round-trips description, temperature, steps, model, color', () => {
    saveAgent({
      name: 'full-agent',
      scope: 'global',
      mode: 'primary',
      description: 'A fully featured agent',
      temperature: 0.7,
      steps: 20,
      model: 'anthropic/claude-sonnet-4-6',
      color: '#ff5733'
    })

    const detail = readAgent('full-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.description).toBe('A fully featured agent')
    expect(detail!.temperature).toBe(0.7)
    expect(detail!.steps).toBe(20)
    expect(detail!.model).toBe('anthropic/claude-sonnet-4-6')
    expect(detail!.color).toBe('#ff5733')
  })

  it('project-scoped save/read', () => {
    const cwd = makeTmpDir()
    try {
      saveAgent(
        {
          name: 'proj-agent',
          scope: 'project',
          mode: 'all',
          prompt: 'Project prompt'
        },
        cwd
      )

      const detail = readAgent('proj-agent', 'project', cwd)
      expect(detail).not.toBeNull()
      expect(detail!.scope).toBe('project')
      expect(detail!.prompt).toBe('Project prompt')
    } finally {
      rmTmpDir(cwd)
    }
  })
})

describe('saveAgent', () => {
  it('writes to agents/ (plural) directory', () => {
    saveAgent({
      name: 'plural-test',
      scope: 'global',
      mode: 'all'
    })

    const expectedPath = path.join(configDir, 'agents', 'plural-test.md')
    expect(fs.existsSync(expectedPath)).toBe(true)
  })

  it('omits hidden when false/undefined', () => {
    saveAgent({
      name: 'no-hidden',
      scope: 'global',
      mode: 'all',
      hidden: false
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'no-hidden.md'), 'utf8')
    // false should not be emitted (only true is emitted)
    expect(text).not.toMatch(/hidden: false/)
  })

  it('omits disable when false/undefined', () => {
    saveAgent({
      name: 'no-disable',
      scope: 'global',
      mode: 'all',
      disable: false
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'no-disable.md'), 'utf8')
    expect(text).not.toMatch(/disable: false/)
  })

  it('omits empty permission block', () => {
    saveAgent({
      name: 'no-perm',
      scope: 'global',
      mode: 'all',
      permission: {}
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'no-perm.md'), 'utf8')
    expect(text).not.toMatch(/permission/)
  })

  it('emits hidden: true when hidden=true', () => {
    saveAgent({
      name: 'hidden-agent',
      scope: 'global',
      mode: 'all',
      hidden: true
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'hidden-agent.md'), 'utf8')
    expect(text).toMatch(/hidden: true/)
  })

  it('emits disabled: true (the 2.x key) when disable=true', () => {
    saveAgent({
      name: 'disabled-agent',
      scope: 'global',
      mode: 'all',
      disable: true
    })

    const data = frontmatter(path.join(configDir, 'agents', 'disabled-agent.md'))
    expect(data.disabled).toBe(true)
    expect(data).not.toHaveProperty('disable')
  })

  it('writes 2.x keys only: temperature/top_p under request.body, effort in the model', () => {
    saveAgent({
      name: 'reasoning',
      scope: 'global',
      mode: 'all',
      model: 'openai/gpt-6',
      reasoningEffort: 'low',
      temperature: 0.3,
      topP: 0.9,
      prompt: 'Be brief.'
    })

    const data = frontmatter(path.join(configDir, 'agents', 'reasoning.md'))
    expect(data).toEqual({
      description: undefined,
      mode: 'all',
      model: 'openai/gpt-6#low',
      request: { body: { temperature: 0.3, top_p: 0.9 } }
    } as never)
    expect(isLegacyAgentFrontmatter(data)).toBe(false)
  })

  // M-OC8: editing an agent that lives in the SINGULAR `agent/` dir must
  // overwrite it in place — not create a shadow copy in `agents/` that the
  // reader (which searches `agent/` first) never surfaces.
  it('overwrites an existing agent in-place in agent/ (singular), no shadow copy', () => {
    // The agent already lives in the singular dir with an old model.
    writeAgentFile(
      path.join(configDir, 'agent'),
      'inplace',
      '---\ndescription: old\nmode: all\nmodel: old/model\n---\nold body'
    )

    saveAgent({
      name: 'inplace',
      scope: 'global',
      mode: 'all',
      model: 'new/model',
      prompt: 'new body'
    })

    // The singular file was updated…
    const singular = fs.readFileSync(path.join(configDir, 'agent', 'inplace.md'), 'utf8')
    expect(singular).toMatch(/new\/model/)
    expect(singular).toMatch(/new body/)
    // …and NO shadow file was created in agents/ (pre-fix this existed and won).
    expect(fs.existsSync(path.join(configDir, 'agents', 'inplace.md'))).toBe(false)

    // The reader reflects the edit (proves the edit "sticks").
    const detail = readAgent('inplace', 'global')
    expect(detail?.model).toBe('new/model')
  })
})

describe('deleteAgent', () => {
  it('removes the file', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, 'to-delete', `---\nmode: all\n---\n`)

    deleteAgent('to-delete', 'global')

    expect(fs.existsSync(path.join(agentsDir, 'to-delete.md'))).toBe(false)
  })

  it('removes from agent/ (singular) dir too', () => {
    const agentDir = path.join(configDir, 'agent')
    writeAgentFile(agentDir, 'singular-delete', `---\nmode: all\n---\n`)

    deleteAgent('singular-delete', 'global')

    expect(fs.existsSync(path.join(agentDir, 'singular-delete.md'))).toBe(false)
  })

  it('does not throw when file does not exist', () => {
    expect(() => deleteAgent('nonexistent', 'global')).not.toThrow()
  })

  it('project-scoped delete', () => {
    const cwd = makeTmpDir()
    try {
      const projectAgentsDir = path.join(cwd, '.opencode', 'agents')
      writeAgentFile(projectAgentsDir, 'proj-del', `---\nmode: all\n---\n`)

      deleteAgent('proj-del', 'project', cwd)

      expect(fs.existsSync(path.join(projectAgentsDir, 'proj-del.md'))).toBe(false)
    } finally {
      rmTmpDir(cwd)
    }
  })
})

describe('setAgentDisabled', () => {
  it('sets disable:true while preserving body and other frontmatter', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(
      agentsDir,
      'toggle-agent',
      `---\nmode: primary\nmodel: anthropic/claude-sonnet-4-6\n---\nOriginal body content.`
    )

    setAgentDisabled('toggle-agent', 'global', undefined, true)

    const detail = readAgent('toggle-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.disabled).toBe(true)
    expect(detail!.model).toBe('anthropic/claude-sonnet-4-6')
    expect(detail!.prompt).toBe('Original body content.')
  })

  it('clears disable when called with false', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, 'undisable-agent', `---\nmode: all\ndisable: true\n---\nBody text.`)

    setAgentDisabled('undisable-agent', 'global', undefined, false)

    const detail = readAgent('undisable-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.disabled).toBeUndefined()
    expect(detail!.prompt).toBe('Body text.')
  })

  it('disabling a built-in with no file writes a JSON override, never an empty-prompt md (F10)', () => {
    // An md override always sets `system` to its body: an empty one would wipe
    // the built-in's own prompt. So the override goes to agents.<name> in the config.
    setAgentDisabled('build', 'global', undefined, true)

    expect(fs.existsSync(path.join(configDir, 'agents', 'build.md'))).toBe(false)
    const json = JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8'))
    expect(json.agents.build).toEqual({ disabled: true })
    expect(readAgent('build', 'global')!.disabled).toBe(true)
    expect(listAgents().find((a) => a.name === 'build')).toMatchObject({
      overridden: true,
      disabled: true
    })

    setAgentDisabled('build', 'global', undefined, false)
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8'))).toEqual({})
  })

  it('does nothing when disabling=false and no file exists', () => {
    const agentsDir = path.join(configDir, 'agents')
    expect(fs.existsSync(path.join(agentsDir, 'build.md'))).toBe(false)

    // Should not throw or create a file
    expect(() => setAgentDisabled('build', 'global', undefined, false)).not.toThrow()
    expect(fs.existsSync(path.join(agentsDir, 'build.md'))).toBe(false)
  })
})

describe('readAgent for built-ins with no file', () => {
  it('returns a default detail for a built-in', () => {
    const detail = readAgent('plan', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.name).toBe('plan')
    expect(detail!.kind).toBe('builtin')
    expect(detail!.mode).toBe('primary')
    expect(detail!.restrict).toBe(false)
    expect(detail!.prompt).toBeUndefined()
  })

  it('returns null for an unknown non-builtin name', () => {
    const detail = readAgent('does-not-exist', 'global')
    expect(detail).toBeNull()
  })
})

describe('OPENCODE_CONFIG_DIR env var', () => {
  it('honours OPENCODE_CONFIG_DIR for path resolution', () => {
    // The configDir is set to a tmp dir in beforeEach, verify agents go there
    saveAgent({
      name: 'env-test-agent',
      scope: 'global',
      mode: 'all'
    })

    const expectedPath = path.join(configDir, 'agents', 'env-test-agent.md')
    expect(fs.existsSync(expectedPath)).toBe(true)

    // And nowhere else (e.g. not in actual ~/.config/opencode)
    const defaultConfigDir = path.join(
      os.homedir(),
      '.config',
      'opencode',
      'agents',
      'env-test-agent.md'
    )
    if (fs.existsSync(defaultConfigDir)) {
      // If the file happens to exist on this dev machine, the env override is not working
      // We can't assert this but the path check above is the real guard
    }
  })
})

// ─── Path guard (S1b review F1) ───────────────────────────────────────────────
//
// The agent name is caller-supplied and, since the S1b sweep put
// `opencode-agents:*` on the remote transport, remotely so. Unvalidated it is an
// arbitrary `.md` read / write / unlink — `~/.claude/CLAUDE.md` is within reach,
// which plants standing model instructions on every future session.
//
// `ipc/config-commands.ts` refuses these at the registration perimeter (driven
// over the real remote transport in `ipc/__tests__/remote-handlers.ipc.test.ts`);
// this block bypasses that entirely and calls the service, because the backstop
// has to hold for callers that never went through the perimeter.

describe('agent name path guard (F1 backstop)', () => {
  const ESCAPES = [
    '../../../.claude/CLAUDE',
    '../evil',
    '..',
    '.',
    'a/b',
    'a\\b',
    'C:evil',
    '.hidden',
    ''
  ]

  it('refuses a traversal name on read/delete/set-disabled', () => {
    for (const bad of ESCAPES) {
      expect(() => readAgent(bad, 'global'), bad).toThrow(/Invalid agent name/)
      expect(() => deleteAgent(bad, 'global'), bad).toThrow(/Invalid agent name/)
      expect(() => setAgentDisabled(bad, 'global', undefined, true), bad).toThrow(
        /Invalid agent name/
      )
    }
  })

  it('refuses a traversal name on save, and writes nothing outside the agents dir', () => {
    const outside = path.join(configDir, '..', 'CLAUDE.md')
    for (const bad of ESCAPES) {
      expect(() => saveAgent({ name: bad, scope: 'global', mode: 'all' }), bad).toThrow(
        /Invalid agent name/
      )
    }
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('does not list an on-disk file whose basename is not a plain agent name', () => {
    // Such a file cannot be read, saved or deleted, so offering it as a row would
    // hand the UI a name it will be refused for.
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, '.hidden-agent', `---\nmode: all\n---\nx`)
    writeAgentFile(agentsDir, 'ok-agent', `---\nmode: all\n---\nx`)

    const names = listAgents().map((a) => a.name)
    expect(names).toContain('ok-agent')
    expect(names).not.toContain('.hidden-agent')
  })

  it('still accepts the real name vocabulary (UI slugs, plus `_`/`.` in hand-written files)', () => {
    // The settings UI restricts new names to /^[a-z0-9-]+$/; the guard is a
    // little wider so a hand-written agents/*.md stays readable.
    for (const good of ['build', 'my-custom-agent', 'code_review', 'v1.2-agent', 'Agent9']) {
      saveAgent({ name: good, scope: 'global', mode: 'all', prompt: 'P' })
      expect(fs.existsSync(path.join(configDir, 'agents', `${good}.md`))).toBe(true)
      expect(readAgent(good, 'global')).not.toBeNull()
      expect(listAgents().map((a) => a.name)).toContain(good)
      deleteAgent(good, 'global')
      expect(fs.existsSync(path.join(configDir, 'agents', `${good}.md`))).toBe(false)
    }
  })
})

// ─── opencode 2.x (ADR-097 S8) ────────────────────────────────────────────────

describe('opencode 2.x agent files', () => {
  const agentsDir = (): string => path.join(configDir, 'agents')

  it('reads a 1.x file as 2.x reads it, flagged legacy', () => {
    writeAgentFile(
      agentsDir(),
      'old',
      [
        '---',
        'description: Old one',
        'mode: subagent',
        'model: anthropic/claude-haiku-3',
        'temperature: 0.2',
        'tools:',
        '  bash: false',
        'permission:',
        '  edit: ask',
        'color: primary',
        'disable: true',
        '---',
        'You are old.'
      ].join('\n')
    )
    const detail = readAgent('old', 'global')
    expect(detail).toMatchObject({
      legacy: true,
      description: 'Old one',
      mode: 'subagent',
      model: 'anthropic/claude-haiku-3',
      temperature: 0.2,
      color: '#aaaaaa',
      disabled: true,
      restrict: true,
      permission: { shell: 'deny', edit: 'ask' },
      prompt: 'You are old.'
    })
  })

  it('saving a 1.x file migrates it whole: hand-added keys survive in their 2.x place', () => {
    writeAgentFile(
      agentsDir(),
      'old',
      [
        '---',
        'description: Old',
        'mode: subagent',
        'top_p: 0.5',
        'maxSteps: 9',
        'myCustomOption: 7',
        'permission:',
        '  bash:',
        '    "git push*": deny',
        '---',
        'Body.'
      ].join('\n')
    )
    const detail = readAgent('old', 'global')!
    saveAgent({
      name: 'old',
      scope: 'global',
      mode: detail.mode,
      description: 'Edited',
      topP: detail.topP,
      steps: detail.steps,
      prompt: detail.prompt
    })
    const data = frontmatter(path.join(agentsDir(), 'old.md'))
    expect(isLegacyAgentFrontmatter(data)).toBe(false)
    expect(data).toEqual({
      description: 'Edited',
      mode: 'subagent',
      steps: 9,
      request: { body: { myCustomOption: 7, top_p: 0.5 } },
      permissions: [{ action: 'shell', resource: 'git push*', effect: 'deny' }]
    })
    expect(readAgent('old', 'global')).toMatchObject({ extraRules: 1, restrict: true })
    expect(readAgent('old', 'global')!.legacy).toBeUndefined()
  })

  it('a 2.x save keeps request.headers, other body keys and narrow rules (grid first, narrow after)', () => {
    writeAgentFile(
      agentsDir(),
      'neu',
      [
        '---',
        'mode: primary',
        'request:',
        '  headers:',
        '    x-team: core',
        '  body:',
        '    seed: 1',
        '    temperature: 0.1',
        'permissions:',
        '  - action: shell',
        '    resource: "*"',
        '    effect: ask',
        '  - action: shell',
        '    resource: "git status*"',
        '    effect: allow',
        '---',
        'P.'
      ].join('\n')
    )
    saveAgent({ name: 'neu', scope: 'global', mode: 'primary', permission: { shell: 'deny' } })
    const data = frontmatter(path.join(agentsDir(), 'neu.md'))
    expect(data.request).toEqual({ headers: { 'x-team': 'core' }, body: { seed: 1 } })
    expect(data.permissions).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'git status*', effect: 'allow' }
    ])
  })

  it('a rename keeps hand-added fields and removes the old file', () => {
    writeAgentFile(
      agentsDir(),
      'before',
      '---\nmode: subagent\nrequest:\n  headers:\n    x-a: "1"\n---\nBody.'
    )
    saveAgent({
      name: 'after',
      scope: 'global',
      mode: 'subagent',
      prompt: 'Body.',
      previous: { name: 'before', scope: 'global' }
    })
    expect(fs.existsSync(path.join(agentsDir(), 'before.md'))).toBe(false)
    expect(frontmatter(path.join(agentsDir(), 'after.md')).request).toEqual({
      headers: { 'x-a': '1' }
    })
  })

  it('a rename onto an existing agent is refused and nothing moves', () => {
    writeAgentFile(agentsDir(), 'a', '---\nmode: all\n---\nA')
    writeAgentFile(agentsDir(), 'b', '---\nmode: all\n---\nB')
    expect(() =>
      saveAgent({
        name: 'b',
        scope: 'global',
        mode: 'all',
        previous: { name: 'a', scope: 'global' }
      })
    ).toThrow(/already exists/)
    expect(fs.existsSync(path.join(agentsDir(), 'a.md'))).toBe(true)
  })

  it('a scope move carries the file to the project and deletes the global one', () => {
    const cwd = makeTmpDir()
    try {
      writeAgentFile(agentsDir(), 'mover', '---\nmode: all\nsteps: 3\n---\nM')
      saveAgent(
        {
          name: 'mover',
          scope: 'project',
          mode: 'all',
          steps: 3,
          prompt: 'M',
          previous: { name: 'mover', scope: 'global' }
        },
        cwd
      )
      expect(fs.existsSync(path.join(agentsDir(), 'mover.md'))).toBe(false)
      expect(readAgent('mover', 'project', cwd)).toMatchObject({ scope: 'project', steps: 3 })
    } finally {
      rmTmpDir(cwd)
    }
  })

  it('refuses values 2.x would drop the whole agent for', () => {
    const base = { name: 'bad', scope: 'global' as const, mode: 'all' as const }
    expect(() => saveAgent({ ...base, model: 'no-slash' })).toThrow(/provider\/model/)
    expect(() => saveAgent({ ...base, color: 'primary' })).toThrow(/#rrggbb/)
    expect(() => saveAgent({ ...base, steps: 0 })).toThrow(/positive integer/)
    expect(() => saveAgent({ ...base, reasoningEffort: 'high' })).toThrow(/choose a model/)
    expect(() => saveAgent({ ...base, permission: { bash: 'deny' } })).toThrow(
      /Invalid agent permission/
    )
    expect(fs.existsSync(path.join(agentsDir(), 'bad.md'))).toBe(false)
  })

  it('setAgentDisabled on a 1.x file migrates it (a 1.x `disabled` would be a body option)', () => {
    writeAgentFile(agentsDir(), 'x', '---\nmode: all\ntemperature: 0.4\n---\nX')
    setAgentDisabled('x', 'global', undefined, true)
    const data = frontmatter(path.join(agentsDir(), 'x.md'))
    expect(data).toEqual({ mode: 'all', request: { body: { temperature: 0.4 } }, disabled: true })
  })

  it('a save keeps an existing disabled flag the editor did not send', () => {
    writeAgentFile(agentsDir(), 'off', '---\nmode: all\ndisabled: true\n---\nO')
    saveAgent({ name: 'off', scope: 'global', mode: 'all', prompt: 'O2' })
    expect(readAgent('off', 'global')!.disabled).toBe(true)
  })
})

// ─── Review fixes (S8 review F1, F6, F10) ─────────────────────────────────────

describe('F1: a grid save never reorders permission rules', () => {
  const agentsDir = (): string => path.join(configDir, 'agents')
  type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }

  /** opencode 2.x's decision: the LAST rule matching both (permission.ts findLast). */
  function decide(rules: Rule[], action: string, resource: string): string | undefined {
    for (let i = rules.length - 1; i >= 0; i--)
      if (
        wildcardMatch(action, rules[i].action, 'linux') &&
        wildcardMatch(resource, rules[i].resource, 'linux')
      )
        return rules[i].effect
    return undefined
  }

  /** readAgent → saveAgent with nothing changed, as the editor does it. */
  function noOpSave(name: string): void {
    const d = readAgent(name, 'global')!
    saveAgent({
      name,
      scope: 'global',
      mode: d.mode,
      description: d.description,
      prompt: d.prompt,
      permission: d.restrict
        ? Object.fromEntries(AGENT_GRID_ACTIONS.map((a) => [a, d.permission?.[a] ?? 'allow']))
        : undefined
    })
  }

  it('the common 1.x "allow all but bash" keeps shell denied (probe1 rev)', () => {
    writeAgentFile(
      agentsDir(),
      'rev',
      '---\ndescription: reviewer\npermission:\n  "*": allow\n  bash: deny\n---\nReview code.\n'
    )
    noOpSave('rev')
    expect(frontmatter(path.join(agentsDir(), 'rev.md')).permissions).toEqual([
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'deny' }
    ])
  })

  it('a 2.x deny-all after an allow stays deny-all (probe1 b)', () => {
    const rules = [
      { action: 'shell', resource: 'git *', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'deny' }
    ]
    writeAgentFile(
      agentsDir(),
      'b',
      `---\ndescription: b\npermissions: ${JSON.stringify(rules)}\n---\nB.\n`
    )
    noOpSave('b')
    expect(frontmatter(path.join(agentsDir(), 'b.md')).permissions).toEqual(rules)
  })

  it('changing one action edits its catch-all in place; a new one never outranks a narrower rule', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'read', resource: '*.env', effect: 'deny' },
      { action: 'shell', resource: 'git *', effect: 'allow' }
    ]
    writeAgentFile(agentsDir(), 'c', `---\npermissions: ${JSON.stringify(rules)}\n---\nC.\n`)
    saveAgent({
      name: 'c',
      scope: 'global',
      mode: 'all',
      prompt: 'C.',
      permission: { shell: 'deny', read: 'ask' }
    })
    const out = frontmatter(path.join(agentsDir(), 'c.md')).permissions as Rule[]
    expect(decide(out, 'shell', 'git status')).toBe('allow')
    expect(decide(out, 'shell', 'rm -rf /')).toBe('deny')
    expect(decide(out, 'read', 'a.env')).toBe('deny')
    expect(decide(out, 'read', 'a.ts')).toBe('ask')
    expect(decide(out, 'webfetch', 'x')).toBe('allow')
  })

  it('property: a no-op save keeps the rule list byte-identical and every decision', () => {
    // A small deterministic PRNG: failures reproduce.
    let seed = 0x5eed
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const actions = ['*', 'shell', 'read', 'edit', 'sh*', 'webfetch', 'mcp_x']
    const resources = ['*', 'git *', '*.env', 'x', 'docs/*']
    const effects = ['allow', 'ask', 'deny'] as const
    const probes: [string, string][] = []
    for (const a of ['shell', 'read', 'edit', 'webfetch', 'grep', 'mcp_x'])
      for (const r of ['git status', 'a.env', 'x', 'docs/a', 'anything']) probes.push([a, r])
    for (let iteration = 0; iteration < 200; iteration++) {
      const rules: Rule[] = Array.from({ length: 1 + rnd(6) }, () => ({
        action: actions[rnd(actions.length)],
        resource: resources[rnd(resources.length)],
        effect: effects[rnd(3)]
      }))
      writeAgentFile(agentsDir(), 'p', `---\npermissions: ${JSON.stringify(rules)}\n---\nP.\n`)
      noOpSave('p')
      const out = frontmatter(path.join(agentsDir(), 'p.md')).permissions as Rule[]
      expect(out, JSON.stringify(rules)).toEqual(rules)
      for (const [a, r] of probes) expect(decide(out, a, r)).toBe(decide(rules, a, r))
    }
  })
})

describe('F6: a rename carries and deletes ONE file', () => {
  it('a copy in the other of agent/ and agents/ is neither carried nor deleted', () => {
    writeAgentFile(path.join(configDir, 'agent'), 'dup', '---\nmode: all\nsteps: 1\n---\nFirst.')
    writeAgentFile(path.join(configDir, 'agents'), 'dup', '---\nmode: all\nsteps: 2\n---\nSecond.')
    saveAgent({
      name: 'renamed',
      scope: 'global',
      mode: 'all',
      steps: 1,
      prompt: 'First.',
      previous: { name: 'dup', scope: 'global' }
    })
    expect(fs.existsSync(path.join(configDir, 'agent', 'dup.md'))).toBe(false)
    expect(fs.readFileSync(path.join(configDir, 'agents', 'dup.md'), 'utf8')).toContain('Second.')
    expect(readAgent('renamed', 'global')).toMatchObject({ steps: 1, prompt: 'First.' })
  })
})

describe('F10: a built-in override with no prompt keeps the built-in prompt', () => {
  it('is written as agents.<name> in the config (no system key), not an empty-body md', () => {
    saveAgent({ name: 'title', scope: 'global', mode: 'primary', model: 'openai/gpt-6' })
    expect(fs.existsSync(path.join(configDir, 'agents', 'title.md'))).toBe(false)
    const json = JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8'))
    expect(json.agents.title).toEqual({ mode: 'primary', model: 'openai/gpt-6' })
    expect(readAgent('title', 'global')).toMatchObject({ model: 'openai/gpt-6', overridden: true })
  })

  it('an existing empty-body md override moves to the JSON form on its next save', () => {
    writeAgentFile(
      path.join(configDir, 'agents'),
      'explore',
      '---\nmode: subagent\nsteps: 4\n---\n'
    )
    saveAgent({ name: 'explore', scope: 'global', mode: 'subagent', steps: 5 })
    expect(fs.existsSync(path.join(configDir, 'agents', 'explore.md'))).toBe(false)
    expect(
      JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8')).agents.explore
    ).toEqual({ mode: 'subagent', steps: 5 })
  })

  it('a built-in WITH a prompt stays a markdown file, and its JSON override goes', () => {
    saveAgent({ name: 'plan', scope: 'global', mode: 'primary', model: 'a/b' })
    saveAgent({ name: 'plan', scope: 'global', mode: 'primary', model: 'a/b', prompt: 'Plan it.' })
    expect(fs.readFileSync(path.join(configDir, 'agents', 'plan.md'), 'utf8')).toContain('Plan it.')
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8'))).toEqual({})
  })
})
