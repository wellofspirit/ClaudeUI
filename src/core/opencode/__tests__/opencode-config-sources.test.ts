/**
 * @vitest-environment node
 *
 * opencode-config-sources.ts: the MCP servers and agents opencode's own config
 * declares for a cwd (ADR-103 shim inputs). Every path is an isolated temp dir;
 * the global config dir is redirected with OPENCODE_CONFIG_DIR and the cwd is a
 * nested directory of the temp root, so the ancestor walk is exercised too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import {
  MAX_AGENT_DEPTH,
  MAX_CONFIG_BYTES,
  MAX_NAMES,
  opencodeConfigDocuments,
  opencodeMcpServerNames,
  opencodeNativeAgentNames
} from '../opencode-config-sources'
import { OPENCODE_BUILTIN_AGENT_NAMES } from '../opencode-agents'
import { loadClaudeAgentsForOpencode } from '../claude-agent-shim'

const ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_PROJECT_DISABLE',
  'OPENCODE_DISABLE_PROJECT_CONFIG'
]

let root: string
let globalDir: string
/** root/ws/proj/sub: `ws` and `proj` are ancestors with their own config. */
let ws: string
let proj: string
let cwd: string
const saved: Record<string, string | undefined> = {}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

const json = (value: unknown): string => JSON.stringify(value)

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
  root = fs.mkdtempSync(path.join(os.tmpdir(), `oc-sources-${crypto.randomUUID().slice(0, 8)}-`))
  globalDir = path.join(root, 'global')
  ws = path.join(root, 'ws')
  proj = path.join(ws, 'proj')
  cwd = path.join(proj, 'sub')
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = globalDir
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('opencodeMcpServerNames', () => {
  it('unions mcp.servers of the global config, the project and an ancestor, and skips a malformed file', () => {
    write(path.join(globalDir, 'opencode.json'), json({ mcp: { servers: { github: {} } } }))
    write(
      path.join(proj, 'opencode.jsonc'),
      '// project\n{ "mcp": { "servers": { "linear": {}, }, }, }'
    )
    write(path.join(ws, 'opencode.json'), json({ mcp: { servers: { jira: {} } } }))
    // Rejected whole by opencode (a JSONC error), so its server does not count.
    write(path.join(cwd, 'opencode.json'), '{ "mcp": { "servers": { "broken": {} } ')
    expect(opencodeMcpServerNames(cwd).sort()).toEqual(['github', 'jira', 'linear'])
  })

  it('reads .opencode/opencode.json(c) of the cwd and of an ancestor', () => {
    write(path.join(cwd, '.opencode', 'opencode.json'), json({ mcp: { servers: { near: {} } } }))
    write(path.join(ws, '.opencode', 'opencode.jsonc'), json({ mcp: { servers: { far: {} } } }))
    expect(opencodeMcpServerNames(cwd).sort()).toEqual(['far', 'near'])
  })

  it('counts the 1.x mcp.<name> shape, but not servers/timeout/enabled-only entries', () => {
    write(
      path.join(globalDir, 'opencode.json'),
      json({
        mcp: {
          legacy: { type: 'remote', url: 'https://example.invalid/mcp' },
          toggled: { enabled: false },
          timeout: { catalog: 5000 },
          servers: { native: {} }
        }
      })
    )
    expect(opencodeMcpServerNames(cwd).sort()).toEqual(['legacy', 'native'])
  })

  it('a 1.x server literally named "servers" is a server, not the container', () => {
    write(
      path.join(globalDir, 'opencode.json'),
      json({ mcp: { servers: { type: 'local', command: ['x'] } } })
    )
    expect(opencodeMcpServerNames(cwd)).toEqual(['servers'])
  })

  it('honours OPENCODE_CONFIG and the project-config opt-out', () => {
    write(path.join(proj, 'opencode.json'), json({ mcp: { servers: { project: {} } } }))
    const explicit = write(path.join(root, 'extra.json'), json({ mcp: { servers: { extra: {} } } }))
    process.env.OPENCODE_CONFIG = explicit
    expect(opencodeMcpServerNames(cwd).sort()).toEqual(['extra', 'project'])
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
    expect(opencodeMcpServerNames(cwd)).toEqual(['extra'])
  })

  it('a cwd that is the global config dir has no project sources', () => {
    write(path.join(globalDir, 'opencode.json'), json({ mcp: { servers: { g: {} } } }))
    write(
      path.join(globalDir, '.opencode', 'opencode.json'),
      json({ mcp: { servers: { nope: {} } } })
    )
    expect(opencodeMcpServerNames(globalDir)).toEqual(['g'])
  })

  it('never throws on a missing cwd, a non-object root or a directory named like a config', () => {
    write(path.join(globalDir, 'opencode.json'), '[1, 2]')
    fs.mkdirSync(path.join(proj, 'opencode.json'))
    expect(opencodeMcpServerNames(path.join(root, 'gone', 'deeper'))).toEqual([])
    expect(opencodeConfigDocuments(cwd)).toEqual([])
  })

  it('does not read a document over the size cap', () => {
    const padded = json({ mcp: { servers: { big: {} } } }) + ' '.repeat(MAX_CONFIG_BYTES)
    write(path.join(proj, 'opencode.json'), padded)
    expect(opencodeMcpServerNames(cwd)).toEqual([])
  })

  it('stops at the name cap', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MAX_NAMES + 50 }, (_, i) => [`s${i}`, {}])
    )
    write(path.join(globalDir, 'opencode.json'), json({ mcp: { servers } }))
    expect(opencodeMcpServerNames(cwd)).toHaveLength(MAX_NAMES)
  })
})

describe('opencodeNativeAgentNames', () => {
  it('always has the built-ins', () => {
    expect(opencodeNativeAgentNames(cwd)).toEqual(expect.arrayContaining(['build', 'plan']))
    expect(new Set(opencodeNativeAgentNames(cwd))).toEqual(new Set(OPENCODE_BUILTIN_AGENT_NAMES))
  })

  it('reads agents.<name> from the global JSON and from a project JSON, and the 1.x agent/mode keys', () => {
    write(
      path.join(globalDir, 'opencode.jsonc'),
      json({ agents: { reviewer: { description: 'x' } } })
    )
    write(
      path.join(proj, 'opencode.json'),
      json({ agents: { deployer: {} }, agent: { oldstyle: {} }, mode: { driver: {} } })
    )
    expect(opencodeNativeAgentNames(cwd)).toEqual(
      expect.arrayContaining(['reviewer', 'deployer', 'oldstyle', 'driver'])
    )
  })

  it('derives the id opencode derives: nested agents are path-relative, mode is flat', () => {
    write(path.join(globalDir, 'agents', 'flat.md'), 'x')
    write(path.join(globalDir, 'agent', 'team', 'deep', 'x.md'), 'x')
    write(path.join(globalDir, 'agents', 'sub', 'x.md'), 'x')
    write(path.join(globalDir, 'mode', 'planner.md'), 'x')
    write(path.join(globalDir, 'modes', 'ignored', 'nested.md'), 'x') // {mode,modes}/*.md is not recursive
    write(path.join(globalDir, 'agents', 'notes.txt'), 'x')
    const names = opencodeNativeAgentNames(cwd)
    expect(names).toEqual(expect.arrayContaining(['flat', 'team/deep/x', 'sub/x', 'planner']))
    expect(names).not.toContain('x')
    expect(names).not.toContain('nested')
    expect(names).not.toContain('ignored/nested')
    expect(names).not.toContain('notes')
  })

  it('reads the project .opencode dir and every ancestor .opencode dir', () => {
    write(path.join(cwd, '.opencode', 'agents', 'near.md'), 'x')
    write(path.join(proj, '.opencode', 'agent', 'mid.md'), 'x')
    write(path.join(ws, '.opencode', 'mode', 'far.md'), 'x')
    expect(opencodeNativeAgentNames(cwd)).toEqual(expect.arrayContaining(['near', 'mid', 'far']))
    // …and an ancestor's agents are not there for an unrelated sibling tree.
    expect(opencodeNativeAgentNames(path.join(root, 'other'))).not.toContain('mid')
  })

  it('does not look below the depth cap', () => {
    const deep = Array.from({ length: MAX_AGENT_DEPTH + 2 }, (_, i) => `d${i}`)
    write(path.join(globalDir, 'agents', ...deep, 'toodeep.md'), 'x')
    write(path.join(globalDir, 'agents', ...deep.slice(0, 2), 'shallow.md'), 'x')
    const names = opencodeNativeAgentNames(cwd)
    expect(names).toContain('d0/d1/shallow')
    expect(names.some((n) => n.endsWith('toodeep'))).toBe(false)
  })
})

describe('the shim over the discovered names', () => {
  const claudeAgent = (name: string): string =>
    `---\nname: ${name}\ndescription: A role\ntools: Read\n---\nDo it.\n`

  it('skips a Claude agent whose name only a JSON agents entry holds, so the native agent is never rewritten', () => {
    write(path.join(globalDir, 'opencode.json'), json({ agents: { reviewer: { system: 'mine' } } }))
    const claudeDir = path.join(root, 'claude-agents')
    write(path.join(claudeDir, 'reviewer.md'), claudeAgent('reviewer'))
    write(path.join(claudeDir, 'fresh.md'), claudeAgent('fresh'))
    const shim = loadClaudeAgentsForOpencode({
      cwd,
      mcpServers: [],
      nativeAgentNames: opencodeNativeAgentNames(cwd),
      modelAllowlist: {},
      claudeUserAgentsDir: claudeDir
    })
    expect(Object.keys(shim.agents)).toEqual(['fresh'])
    expect(shim.diagnostics.some((d) => d.includes('reviewer.md') && d.includes('skipped'))).toBe(
      true
    )
  })

  it('denies a natively configured server for a tools-list agent', () => {
    write(path.join(globalDir, 'opencode.json'), json({ mcp: { servers: { github: {} } } }))
    const claudeDir = path.join(root, 'claude-agents')
    write(path.join(claudeDir, 'orch-reader.md'), claudeAgent('orch-reader'))
    const shim = loadClaudeAgentsForOpencode({
      cwd,
      mcpServers: opencodeMcpServerNames(cwd),
      nativeAgentNames: opencodeNativeAgentNames(cwd),
      modelAllowlist: {},
      claudeUserAgentsDir: claudeDir
    })
    expect(shim.agents['orch-reader'].permissions).toContainEqual({
      action: 'github_*',
      resource: '*',
      effect: 'deny'
    })
  })
})
