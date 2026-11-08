/**
 * @vitest-environment node
 *
 * The MCP catalog against real directories: a throwaway CLAUDE_CONFIG_DIR, a
 * test managed dir and (for the project-key cases) a real `git init` repo with a
 * linked worktree. Only the plugin enumerator is faked (its own suite covers it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { McpServerConfig } from '../../../shared/types'

const { plugins } = vi.hoisted(() => ({
  plugins: {
    servers: [] as { key: string; pluginId: string; root: string; config: McpServerConfig }[],
    skipped: [] as { name: string; reason: string }[]
  }
}))
vi.mock('../claude-plugin-mcp', () => ({
  listPluginMcpServers: () => ({ servers: plugins.servers, skipped: plugins.skipped })
}))

import { resolveClaudeMcpCatalog, validateMcpEntry } from '../claude-mcp-catalog'
import { readEnabledClaudeMcpServers } from '../claude-mcp'

let root: string
let cfg: string
let home: string
let managed: string
let repo: string
const env = (): Record<string, string> => ({ CLAUDE_CONFIG_DIR: cfg, HOME: home })
const catalog = (cwd = repo): ReturnType<typeof resolveClaudeMcpCatalog> =>
  resolveClaudeMcpCatalog(cwd, env(), { managedDir: managed })
const names = (c = catalog()): string[] => Object.keys(c.servers).sort()
const stdio = (command: string, args: string[] = []): McpServerConfig => ({
  type: 'stdio',
  command,
  args
})

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
}
const globalFile = (): string => path.join(cfg, '.claude.json')
const writeGlobal = (data: Record<string, unknown>): void => writeJson(globalFile(), data)
const keyOf = (dir: string): string => dir.replace(/\\/g, '/')
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-catalog-')))
  cfg = path.join(root, 'cfg')
  home = path.join(root, 'home')
  managed = path.join(root, 'managed')
  repo = path.join(root, 'work', 'repo')
  fs.mkdirSync(cfg, { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  plugins.servers = []
  plugins.skipped = []
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('layers and precedence', () => {
  it('reads the user scope from the global config under CLAUDE_CONFIG_DIR (A1)', () => {
    writeGlobal({ mcpServers: { u1: stdio('node', ['u.js']) } })
    const c = catalog()
    expect(c.servers.u1).toMatchObject({ source: 'user', config: { command: 'node' } })
  })

  it('ignores the files cli.js ignores except through the ClaudeUI layer', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), { mcpServers: { s_user: stdio('a') } })
    writeJson(path.join(home, '.claude', '.mcp.json'), { mcpServers: { cfg_mcp: stdio('b') } })
    writeJson(path.join(repo, '.claude', 'settings.json'), { mcpServers: { s_proj: stdio('c') } })
    const c = catalog()
    expect(names(c)).toEqual(['cfg_mcp', 's_proj', 's_user'])
    expect(Object.values(c.servers).every((e) => e.source === 'claudeui')).toBe(true)
  })

  it('stacks plugin < user < project < local < managed < claudeui, whole entries', () => {
    const git0 = path.join(repo, '.git')
    fs.mkdirSync(git0)
    writeGlobal({
      mcpServers: {
        a: stdio('user-a'),
        b: stdio('user-b'),
        c: stdio('user-c'),
        d: stdio('user-d')
      },
      projects: {
        [keyOf(repo)]: { mcpServers: { c: stdio('local-c'), d: stdio('local-d') } }
      }
    })
    writeJson(path.join(repo, '.mcp.json'), {
      mcpServers: { b: stdio('proj-b'), c: stdio('proj-c'), d: stdio('proj-d') }
    })
    writeJson(path.join(managed, 'managed-settings.json'), {
      managedMcpServers: { d: { type: 'http', url: 'https://managed.example/mcp' } }
    })
    const got = catalog().servers
    expect(got.a.source).toBe('user')
    expect(got.b).toMatchObject({ source: 'project', config: { command: 'proj-b' } })
    expect(got.c).toMatchObject({ source: 'local', config: { command: 'local-c' } })
    expect(got.d).toMatchObject({
      source: 'managed',
      config: { url: 'https://managed.example/mcp' }
    })

    writeJson(path.join(home, '.claude', '.mcp.json'), { mcpServers: { d: stdio('legacy-d') } })
    expect(catalog().servers.d).toMatchObject({
      source: 'claudeui',
      config: { command: 'legacy-d' }
    })
  })

  it('does not expand ${VAR}', () => {
    writeGlobal({
      mcpServers: { u: { type: 'stdio', command: 'x', args: ['${HOME}'], env: { K: '${KEY:-d}' } } }
    })
    expect(catalog().servers.u.config).toMatchObject({ args: ['${HOME}'], env: { K: '${KEY:-d}' } })
  })
})

describe('project .mcp.json (A3)', () => {
  it('walks up past the git root; the closest file wins per name', () => {
    fs.mkdirSync(path.join(repo, '.git'))
    const sub = path.join(repo, 'pkg', 'deep')
    fs.mkdirSync(sub, { recursive: true })
    writeJson(path.join(root, 'work', '.mcp.json'), {
      mcpServers: { anc: stdio('anc'), dup: stdio('ancestor-dup') }
    })
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { top: stdio('top') } })
    writeJson(path.join(repo, 'pkg', '.mcp.json'), { mcpServers: { dup: stdio('closer-dup') } })
    const got = catalog(sub).servers
    expect(Object.keys(got).sort()).toEqual(['anc', 'dup', 'top'])
    expect(got.dup.config.command).toBe('closer-dup')
  })

  it('drops servers vetoed by disabledMcpjsonServers in repo settings, cwd-relative', () => {
    fs.mkdirSync(path.join(repo, '.git'))
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { keep: stdio('k'), veto: stdio('v') } })
    writeJson(path.join(repo, '.claude', 'settings.json'), { disabledMcpjsonServers: ['veto'] })
    expect(names()).toEqual(['keep'])
    // settings resolve against the cwd, not the git root
    const sub = path.join(repo, 'sub')
    fs.mkdirSync(sub)
    expect(names(catalog(sub))).toEqual(['keep', 'veto'])
  })

  it('honours the legacy disabledMcpjsonServers in the global project entry, and leaves other scopes alone', () => {
    writeGlobal({
      mcpServers: { veto: stdio('user-veto') },
      projects: { [keyOf(repo)]: { disabledMcpjsonServers: ['veto', 'p2'] } }
    })
    writeJson(path.join(repo, '.mcp.json'), {
      mcpServers: { veto: stdio('proj'), p2: stdio('p2') }
    })
    const got = catalog().servers
    expect(Object.keys(got)).toEqual(['veto'])
    expect(got.veto.source).toBe('user')
  })

  it('ignores an oversized or unparsable .mcp.json without failing', () => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{ not json')
    writeGlobal({ mcpServers: { u: stdio('u') } })
    expect(names()).toEqual(['u'])
  })
})

describe('project key (A2)', () => {
  it('finds a local-scope server keyed by the git root from a subdir and from a linked worktree', () => {
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'i')
    const wt = path.join(root, 'work', 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch')
    const sub = path.join(repo, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    writeGlobal({
      projects: {
        [keyOf(repo)]: { mcpServers: { l1: stdio('l1') }, disabledMcpServers: ['gone'] }
      }
    })
    expect(names(catalog(repo))).toEqual(['l1'])
    expect(names(catalog(sub))).toEqual(['l1'])
    expect(names(catalog(wt))).toEqual(['l1'])
  }, 30_000) // three real git spawns: well under a second idle, past 5 s on a loaded box

  it('keys by the cwd itself outside git', () => {
    writeGlobal({ projects: { [keyOf(repo)]: { mcpServers: { l1: stdio('l1') } } } })
    expect(names()).toEqual(['l1'])
    expect(names(catalog(path.join(root, 'work')))).toEqual([])
  })
})

describe('disabledMcpServers (A4)', () => {
  it('flags the named servers of every scope under the repo-root key, keeping them listed', () => {
    fs.mkdirSync(path.join(repo, '.git'))
    const sub = path.join(repo, 'sub')
    fs.mkdirSync(sub)
    writeGlobal({
      mcpServers: { u1: stdio('u1'), u2: stdio('u2') },
      projects: { [keyOf(repo)]: { disabledMcpServers: ['u1', 'p1'] } }
    })
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { p1: stdio('p1') } })
    const c = catalog(sub)
    expect(names(c)).toEqual(['p1', 'u1', 'u2'])
    expect(
      Object.values(c.servers)
        .filter((e) => e.disabled)
        .map((e) => e.name)
        .sort()
    ).toEqual(['p1', 'u1'])
    // the bridges' shared read launches only the enabled ones
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      const enabled = Object.keys(readEnabledClaudeMcpServers(sub))
      expect(enabled).toContain('u2')
      expect(enabled).not.toContain('u1')
      expect(enabled).not.toContain('p1')
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
    }
  })

  it('matches a plugin server by its full key and exposes it under the bridged name', () => {
    plugins.servers = [
      { key: 'plugin:fake:inline-srv', pluginId: 'fake@m', root: '/r', config: stdio('p1') },
      { key: 'plugin:fake:off', pluginId: 'fake@m', root: '/r', config: stdio('p2') }
    ]
    writeGlobal({ projects: { [keyOf(repo)]: { disabledMcpServers: ['plugin:fake:off'] } } })
    const c = catalog()
    expect(Object.keys(c.servers).sort()).toEqual(['plugin_fake_inline-srv', 'plugin_fake_off'])
    expect(c.servers['plugin_fake_off'].disabled).toBe(true)
    expect(c.servers['plugin_fake_inline-srv'].disabled).toBeUndefined()
    expect(c.servers['plugin_fake_inline-srv']).toMatchObject({
      name: 'plugin_fake_inline-srv',
      claudeName: 'plugin:fake:inline-srv',
      source: 'plugin',
      plugin: { id: 'fake@m', root: '/r' }
    })
  })
})

describe('policy (A5)', () => {
  beforeEach(() => {
    writeGlobal({
      mcpServers: {
        a: stdio('cmd-a', ['--x']),
        b: stdio('cmd-b'),
        h: { type: 'http', url: 'https://api.example.com/mcp' }
      }
    })
  })

  it('denies by name, command and url; the denylist wins over the allowlist', () => {
    writeJson(path.join(cfg, 'settings.json'), {
      deniedMcpServers: [{ serverName: 'b' }, { serverUrl: 'https://*.example.com/*' }],
      allowedMcpServers: [{ serverName: 'a' }, { serverName: 'b' }, { serverName: 'h' }]
    })
    const c = catalog()
    expect(names(c)).toEqual(['a'])
    expect(c.skipped.map((s) => s.name).sort()).toEqual(['b', 'h'])

    writeJson(path.join(cfg, 'settings.json'), {
      deniedMcpServers: [{ serverCommand: ['cmd-a', '--x'] }]
    })
    expect(names()).toEqual(['b', 'h'])
  })

  it('allowlist: [] allows nothing; undefined allows everything', () => {
    expect(names()).toEqual(['a', 'b', 'h'])
    writeJson(path.join(cfg, 'settings.json'), { allowedMcpServers: [] })
    expect(names()).toEqual([])
  })

  it('a serverCommand entry makes stdio servers need a command match, names no longer suffice', () => {
    writeJson(path.join(repo, '.claude', 'settings.json'), {
      allowedMcpServers: [
        { serverCommand: ['cmd-a', '--x'] },
        { serverName: 'b' },
        { serverName: 'h' }
      ]
    })
    expect(names()).toEqual(['a', 'h'])
  })

  it('allowManagedMcpServersOnly takes the allowlist from managed settings only', () => {
    writeJson(path.join(cfg, 'settings.json'), { allowedMcpServers: [{ serverName: 'b' }] })
    writeJson(path.join(managed, 'managed-settings.json'), {
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverName: 'a' }]
    })
    expect(names()).toEqual(['a'])
  })

  it('managed servers skip the allowlist but not the denylist', () => {
    writeJson(path.join(managed, 'managed-settings.json'), {
      allowedMcpServers: [{ serverName: 'a' }],
      deniedMcpServers: [{ serverName: 'm2' }],
      managedMcpServers: {
        m1: { type: 'http', url: 'https://m1.example/mcp' },
        m2: { type: 'http', url: 'https://m2.example/mcp' }
      }
    })
    expect(names()).toEqual(['a', 'm1'])
  })

  it('applies policy to plugin servers by their full key', () => {
    plugins.servers = [{ key: 'plugin:p:s', pluginId: 'p@m', root: '/r', config: stdio('px') }]
    writeJson(path.join(cfg, 'settings.json'), { deniedMcpServers: [{ serverName: 'plugin:p:s' }] })
    expect(names()).toEqual(['a', 'b', 'h'])
  })

  it('managed-mcp.json is exclusive: nothing else loads, not plugins or the ClaudeUI layer', () => {
    plugins.servers = [{ key: 'plugin:p:s', pluginId: 'p@m', root: '/r', config: stdio('px') }]
    writeJson(path.join(home, '.claude', '.mcp.json'), { mcpServers: { legacy: stdio('l') } })
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { proj: stdio('p') } })
    writeJson(path.join(managed, 'managed-settings.json'), {
      managedMcpServers: { ms: { type: 'sse', url: 'https://ms.example/sse' } }
    })
    writeJson(path.join(managed, 'managed-mcp.json'), {
      mcpServers: { corp: stdio('corp-cmd'), ms: stdio('override') }
    })
    const c = catalog()
    expect(names(c)).toEqual(['corp', 'ms'])
    expect(c.servers.ms.config.command).toBe('override')
    expect(Object.values(c.servers).every((e) => e.source === 'managed')).toBe(true)
  })

  it('an unparsable managed-mcp.json still means exclusive (fail closed)', () => {
    fs.mkdirSync(managed, { recursive: true })
    fs.writeFileSync(path.join(managed, 'managed-mcp.json'), '{ broken')
    expect(names()).toEqual([])
  })
})

describe('entry validation (R7)', () => {
  it('skips with a reason: url without type, ws, sdk, claudeai-proxy, unknown, no command', () => {
    writeGlobal({
      mcpServers: {
        nourl: { url: 'https://x.example' },
        ws: { type: 'ws', url: 'wss://x.example' },
        sdk: { type: 'sdk', name: 'x' },
        proxy: { type: 'claudeai-proxy', url: 'https://x.example' },
        ide: { type: 'sse-ide', url: 'http://localhost' },
        nocmd: { type: 'stdio' },
        ok: { command: 'x' },
        sh: { type: 'streamable-http', url: 'https://x.example/mcp' },
        constructor: { command: 'x' }
      }
    })
    const c = catalog()
    expect(names(c)).toEqual(['ok', 'sh'])
    expect(c.servers.sh.config.type).toBe('http')
    expect(c.skipped.map((s) => s.name).sort()).toEqual([
      'constructor',
      'ide',
      'nocmd',
      'nourl',
      'proxy',
      'sdk',
      'ws'
    ])
    expect(c.skipped.find((s) => s.name === 'nourl')?.reason).toMatch(/no "type"/)
    expect(c.skipped.every((s) => s.reason.length > 0)).toBe(true)
  })

  it('drops unknown keys (cwd) but keeps the ones cli.js knows', () => {
    const v = validateMcpEntry({
      command: 'x',
      cwd: '/elsewhere',
      args: ['a'],
      env: { A: '1' },
      bogus: true,
      timeout: 5
    })
    expect(v).toEqual({ config: { command: 'x', args: ['a'], env: { A: '1' }, timeout: 5 } })
    expect(
      validateMcpEntry({
        type: 'http',
        url: 'https://x',
        headersHelper: 'h',
        oauth: { clientId: 'c' },
        cwd: '/'
      })
    ).toEqual({
      config: { type: 'http', url: 'https://x', headersHelper: 'h', oauth: { clientId: 'c' } }
    })
  })

  it('rejects a stdio managedMcpServers entry', () => {
    writeJson(path.join(managed, 'managed-settings.json'), {
      managedMcpServers: { m: stdio('prog') }
    })
    const c = catalog()
    expect(names(c)).toEqual([])
    expect(c.skipped).toEqual([{ name: 'm', reason: expect.stringMatching(/http or sse/) }])
  })
})

describe('plugin servers', () => {
  const p = (key: string, config: McpServerConfig) => ({ key, pluginId: 'x@m', root: '/r', config })

  it('are lowest precedence and suppressed when they duplicate a manual server or an earlier plugin', () => {
    writeGlobal({
      mcpServers: {
        mine: stdio('shared-cmd', ['--a']),
        site: { type: 'http', url: 'https://s.example/mcp/' }
      }
    })
    plugins.servers = [
      p('plugin:x:dup-cmd', stdio('shared-cmd', ['--a'])),
      p('plugin:x:dup-url', { type: 'http', url: 'https://s.example/mcp' }),
      p('plugin:x:first', stdio('plug')),
      p('plugin:y:second', stdio('plug')),
      p('plugin:x:fine', stdio('other'))
    ]
    const c = catalog()
    expect(names(c)).toEqual(['mine', 'plugin_x_fine', 'plugin_x_first', 'site'])
    expect(c.skipped.map((s) => s.name).sort()).toEqual([
      'plugin:x:dup-cmd',
      'plugin:x:dup-url',
      'plugin:y:second'
    ])
  })

  it('dedups only against manual servers that are live: not disabled, not policy-blocked, not the ClaudeUI layer', () => {
    writeGlobal({
      mcpServers: {
        off: stdio('c-off'),
        denied: stdio('c-denied'),
        live: stdio('c-live')
      },
      projects: { [keyOf(repo)]: { disabledMcpServers: ['off'] } }
    })
    writeJson(path.join(cfg, 'settings.json'), { deniedMcpServers: [{ serverName: 'denied' }] })
    writeJson(path.join(home, '.claude', '.mcp.json'), {
      mcpServers: { legacy: stdio('c-legacy') }
    })
    plugins.servers = [
      p('plugin:x:off', stdio('c-off')),
      p('plugin:x:denied', stdio('c-denied')),
      p('plugin:x:live', stdio('c-live')),
      p('plugin:x:legacy', stdio('c-legacy'))
    ]
    const c = catalog()
    expect(c.skipped.filter((x) => x.reason.startsWith('duplicates')).map((x) => x.name)).toEqual([
      'plugin:x:live'
    ])
    expect(Object.keys(c.servers)).toEqual(
      expect.arrayContaining(['plugin_x_off', 'plugin_x_denied', 'plugin_x_legacy'])
    )
  })

  it('tells plugins apart by env (bar the injected plugin vars) but not manual servers', () => {
    writeGlobal({ mcpServers: { m: { type: 'stdio', command: 'same', env: { K: 'manual' } } } })
    plugins.servers = [
      p('plugin:a:one', {
        type: 'stdio',
        command: 'one',
        env: { K: '1', CLAUDE_PLUGIN_ROOT: '/a' }
      }),
      p('plugin:b:one', {
        type: 'stdio',
        command: 'one',
        env: { K: '1', CLAUDE_PLUGIN_ROOT: '/b' }
      }),
      p('plugin:c:one', { type: 'stdio', command: 'one', env: { K: '2' } }),
      p('plugin:d:same', { type: 'stdio', command: 'same', env: { K: 'other' } })
    ]
    const c = catalog()
    expect(names(c)).toEqual(['m', 'plugin_a_one', 'plugin_c_one'])
    expect(c.skipped.map((x) => x.name).sort()).toEqual(['plugin:b:one', 'plugin:d:same'])
  })

  it('does not displace a manual server whose name equals the bridged name', () => {
    writeGlobal({ mcpServers: { plugin_x_s: stdio('manual') } })
    plugins.servers = [p('plugin:x:s', stdio('plug'))]
    const c = catalog()
    expect(c.servers.plugin_x_s.source).toBe('user')
    expect(c.skipped).toHaveLength(1)
  })

  it('surfaces the enumerator skips', () => {
    plugins.skipped = [{ name: 'plugin:p:secret', reason: 'needs a secret stored by Claude Code' }]
    expect(catalog().skipped).toEqual(plugins.skipped)
  })
})

describe('readEnabledClaudeMcpServers', () => {
  it('maps the catalog to plain configs keyed by the bridged name', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      writeGlobal({ mcpServers: { u: stdio('u') } })
      plugins.servers = [{ key: 'plugin:p:s', pluginId: 'p@m', root: '/r', config: stdio('ps') }]
      expect(readEnabledClaudeMcpServers(repo)).toMatchObject({
        u: stdio('u'),
        plugin_p_s: stdio('ps')
      })
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })
})

describe('realpath rooting', () => {
  it('walks .mcp.json and keys local scope from the target of a linked project dir', () => {
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(target, '.git'))
    writeJson(path.join(target, '.mcp.json'), { mcpServers: { p: stdio('p') } })
    writeGlobal({ projects: { [keyOf(target)]: { mcpServers: { l: stdio('l') } } } })
    const link = path.join(root, 'link')
    fs.symlinkSync(target, link, 'junction')
    expect(names(catalog(path.join(link, 'sub')))).toEqual(['l', 'p'])
  })
})
