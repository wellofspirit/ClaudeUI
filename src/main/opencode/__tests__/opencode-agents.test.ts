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
  listAgents,
  readAgent,
  saveAgent,
  deleteAgent,
  setAgentDisabled,
} from '../opencode-agents'

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
    agents.filter((a) => a.kind === 'builtin').forEach((a) => {
      expect(a.scope).toBeNull()
    })
  })

  it('shows a custom *.md file as kind=custom, scope=global', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, 'my-custom-agent', `---\nmode: subagent\ndescription: A custom one\n---\nDo stuff.`)

    const agents = listAgents()
    const custom = agents.find((a) => a.name === 'my-custom-agent')
    expect(custom).toBeDefined()
    expect(custom!.kind).toBe('custom')
    expect(custom!.scope).toBe('global')
    expect(custom!.mode).toBe('subagent')
  })

  it('marks a built-in override file as overridden=true and keeps kind=builtin', () => {
    const agentsDir = path.join(configDir, 'agents')
    writeAgentFile(agentsDir, 'build', `---\nmode: primary\ndescription: overridden build\n---\nCustom build prompt.`)

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
    writeAgentFile(agentsDir, 'plan', `---\nmodel: anthropic/claude-opus-4\n---\nCustom plan prompt.`)

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

describe('readAgent → saveAgent round-trip', () => {
  it('round-trips topP ↔ top_p', () => {
    saveAgent({
      name: 'rp-agent',
      scope: 'global',
      mode: 'all',
      topP: 0.85,
    })

    const detail = readAgent('rp-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.topP).toBe(0.85)
  })

  it('round-trips reasoningEffort ↔ options.reasoningEffort', () => {
    saveAgent({
      name: 'reasoning-agent',
      scope: 'global',
      mode: 'primary',
      reasoningEffort: 'high',
    })

    const detail = readAgent('reasoning-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.reasoningEffort).toBe('high')
  })

  it('round-trips body ↔ prompt', () => {
    saveAgent({
      name: 'prompt-agent',
      scope: 'global',
      mode: 'subagent',
      prompt: 'You are a helpful assistant.',
    })

    const detail = readAgent('prompt-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.prompt).toBe('You are a helpful assistant.')
  })

  it('round-trips permission present ↔ restrict=true', () => {
    const perm: Record<string, 'allow' | 'ask' | 'deny'> = {
      'Bash(**/rm)': 'deny',
      'Read': 'allow',
    }
    saveAgent({
      name: 'restricted-agent',
      scope: 'global',
      mode: 'all',
      permission: perm,
    })

    const detail = readAgent('restricted-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.restrict).toBe(true)
    expect(detail!.permission).toEqual(perm)
  })

  it('no permission → restrict=false and no permission key', () => {
    saveAgent({
      name: 'free-agent',
      scope: 'global',
      mode: 'all',
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
      color: '#ff5733',
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
      saveAgent({
        name: 'proj-agent',
        scope: 'project',
        mode: 'all',
        prompt: 'Project prompt',
      }, cwd)

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
      mode: 'all',
    })

    const expectedPath = path.join(configDir, 'agents', 'plural-test.md')
    expect(fs.existsSync(expectedPath)).toBe(true)
  })

  it('omits hidden when false/undefined', () => {
    saveAgent({
      name: 'no-hidden',
      scope: 'global',
      mode: 'all',
      hidden: false,
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
      disable: false,
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'no-disable.md'), 'utf8')
    expect(text).not.toMatch(/disable: false/)
  })

  it('omits empty permission block', () => {
    saveAgent({
      name: 'no-perm',
      scope: 'global',
      mode: 'all',
      permission: {},
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'no-perm.md'), 'utf8')
    expect(text).not.toMatch(/permission/)
  })

  it('emits hidden: true when hidden=true', () => {
    saveAgent({
      name: 'hidden-agent',
      scope: 'global',
      mode: 'all',
      hidden: true,
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'hidden-agent.md'), 'utf8')
    expect(text).toMatch(/hidden: true/)
  })

  it('emits disable: true when disable=true', () => {
    saveAgent({
      name: 'disabled-agent',
      scope: 'global',
      mode: 'all',
      disable: true,
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'disabled-agent.md'), 'utf8')
    expect(text).toMatch(/disable: true/)
  })

  it('writes options.reasoningEffort nested correctly', () => {
    saveAgent({
      name: 'reasoning',
      scope: 'global',
      mode: 'all',
      reasoningEffort: 'low',
    })

    const text = fs.readFileSync(path.join(configDir, 'agents', 'reasoning.md'), 'utf8')
    expect(text).toMatch(/options/)
    expect(text).toMatch(/reasoningEffort/)
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
      prompt: 'new body',
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
    writeAgentFile(
      agentsDir,
      'undisable-agent',
      `---\nmode: all\ndisable: true\n---\nBody text.`
    )

    setAgentDisabled('undisable-agent', 'global', undefined, false)

    const detail = readAgent('undisable-agent', 'global')
    expect(detail).not.toBeNull()
    expect(detail!.disabled).toBeUndefined()
    expect(detail!.prompt).toBe('Body text.')
  })

  it('creates a minimal file when disabling a built-in with no file', () => {
    // 'build' is a built-in with no override file
    setAgentDisabled('build', 'global', undefined, true)

    const expectedPath = path.join(configDir, 'agents', 'build.md')
    expect(fs.existsSync(expectedPath)).toBe(true)

    const detail = readAgent('build', 'global')
    expect(detail!.disabled).toBe(true)
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
      mode: 'all',
    })

    const expectedPath = path.join(configDir, 'agents', 'env-test-agent.md')
    expect(fs.existsSync(expectedPath)).toBe(true)

    // And nowhere else (e.g. not in actual ~/.config/opencode)
    const defaultConfigDir = path.join(os.homedir(), '.config', 'opencode', 'agents', 'env-test-agent.md')
    if (fs.existsSync(defaultConfigDir)) {
      // If the file happens to exist on this dev machine, the env override is not working
      // We can't assert this but the path check above is the real guard
    }
  })
})
