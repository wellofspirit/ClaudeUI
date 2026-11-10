import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listPluginMcpServers } from '../claude-plugin-mcp'

let tmp: string
let cfg: string
let proj: string
let mkt: string

function write(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}

/** Directory marketplace `fakemkt` with one in-place plugin `fake`, registered in the config dir. */
function setup(opts: {
  manifest?: Record<string, unknown>
  mcpJson?: unknown
  enabled?: Record<string, unknown>
}): string {
  const root = path.join(mkt, 'plugins', 'fake')
  write(path.join(mkt, '.claude-plugin', 'marketplace.json'), {
    name: 'fakemkt',
    owner: { name: 'probe' },
    plugins: [{ name: 'fake', source: './plugins/fake', version: '1.0.0' }]
  })
  write(path.join(cfg, 'plugins', 'known_marketplaces.json'), {
    fakemkt: { source: { source: 'directory', path: mkt }, installLocation: mkt }
  })
  write(path.join(root, '.claude-plugin', 'plugin.json'), { name: 'fake', ...opts.manifest })
  if (opts.mcpJson !== undefined) write(path.join(root, '.mcp.json'), opts.mcpJson)
  write(path.join(cfg, 'settings.json'), {
    enabledPlugins: opts.enabled ?? { 'fake@fakemkt': true }
  })
  return root
}

const list = (): ReturnType<typeof listPluginMcpServers> =>
  listPluginMcpServers(proj, { CLAUDE_CONFIG_DIR: cfg })

const slash = (p: string): string => p.replace(/\\/g, '/')

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-')))
  cfg = path.join(tmp, 'cfg')
  proj = path.join(tmp, 'proj')
  mkt = path.join(tmp, 'mkt')
  fs.mkdirSync(proj, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('listPluginMcpServers', () => {
  it('substitutes plugin vars, injects env and leaves ${VAR} references literal', () => {
    const root = setup({
      mcpJson: {
        mcpServers: {
          a: {
            command: 'node',
            args: ['${CLAUDE_PLUGIN_ROOT}/s.js', '${CLAUDE_PROJECT_DIR}', '${HOME}', '${X:-d}'],
            env: { DATA: '${CLAUDE_PLUGIN_DATA}', TOKEN: '${TOKEN}' }
          }
        }
      }
    })
    const { servers, skipped } = list()
    expect(skipped).toEqual([])
    expect(servers).toHaveLength(1)
    const s = servers[0]
    expect(s.key).toBe('plugin:fake:a')
    expect(s.pluginId).toBe('fake@fakemkt')
    expect(s.root).toBe(root)
    const dataDir = path.join(cfg, 'plugins', 'data', 'fake-fakemkt')
    expect(s.config).toEqual({
      type: 'stdio',
      command: 'node',
      args: [`${slash(root)}/s.js`, slash(proj), '${HOME}', '${X:-d}'],
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: dataDir,
        CLAUDE_PROJECT_DIR: proj,
        DATA: slash(dataDir),
        TOKEN: '${TOKEN}'
      }
    })
    expect(fs.existsSync(dataDir)).toBe(true)
  })

  it('lets plugin.json mcpServers override same-named .mcp.json entries, in load order', () => {
    setup({
      mcpJson: { mcpServers: { first: { command: 'a' }, dup: { command: 'from-mcpjson' } } },
      manifest: { mcpServers: { dup: { command: 'from-manifest' }, last: { command: 'z' } } }
    })
    const { servers } = list()
    expect(servers.map((s) => [s.key, (s.config as { command: string }).command])).toEqual([
      ['plugin:fake:first', 'a'],
      ['plugin:fake:dup', 'from-manifest'],
      ['plugin:fake:last', 'z']
    ])
  })

  it('reads a bare .mcp.json map and a relative JSON path, and refuses a path escaping the root', () => {
    const root = setup({
      mcpJson: { bare: { command: 'b' } },
      manifest: { mcpServers: ['./extra.json', '../outside.json'] }
    })
    write(path.join(root, 'extra.json'), { mcpServers: { extra: { command: 'e' } } })
    write(path.join(root, '..', 'outside.json'), { mcpServers: { evil: { command: 'x' } } })
    const { servers, skipped } = list()
    expect(servers.map((s) => s.key)).toEqual(['plugin:fake:bare', 'plugin:fake:extra'])
    expect(skipped).toEqual([
      { name: 'plugin:fake:../outside.json', reason: expect.stringContaining('escapes') }
    ])
  })

  it('applies enabledPlugins per key with later layers winning (local false beats user true)', () => {
    setup({ mcpJson: { s: { command: 'x' } } })
    expect(list().servers).toHaveLength(1)
    write(path.join(proj, '.claude', 'settings.local.json'), {
      enabledPlugins: { 'fake@fakemkt': false }
    })
    expect(list().servers).toHaveLength(0)
    // project true over user false
    write(path.join(proj, '.claude', 'settings.local.json'), {})
    write(path.join(cfg, 'settings.json'), { enabledPlugins: { 'fake@fakemkt': false } })
    write(path.join(proj, '.claude', 'settings.json'), { enabledPlugins: { 'fake@fakemkt': true } })
    expect(list().servers).toHaveLength(1)
  })

  it('ignores non-true values, keys without @ and pseudo marketplaces', () => {
    setup({
      mcpJson: { s: { command: 'x' } },
      enabled: { 'fake@fakemkt': ['1.0.0'], fake: true, 'x@builtin': true, 'y@inline': true }
    })
    expect(list()).toEqual({ servers: [], skipped: [] })
  })

  it('substitutes user_config from defaults and pluginConfigs options (user settings only)', () => {
    setup({
      manifest: {
        userConfig: { opt: { type: 'string', default: 'defval' }, other: { default: 'o' } }
      },
      mcpJson: { s: { command: 'x', args: ['${user_config.opt}', '${user_config.other}'] } }
    })
    const args = (): string[] => (list().servers[0].config as { args: string[] }).args
    expect(args()).toEqual(['defval', 'o'])
    write(path.join(cfg, 'settings.json'), {
      enabledPlugins: { 'fake@fakemkt': true },
      pluginConfigs: { 'fake@fakemkt': { options: { opt: 'fromUser' } } }
    })
    expect(args()).toEqual(['fromUser', 'o'])
    // project settings' pluginConfigs are ignored
    write(path.join(proj, '.claude', 'settings.json'), {
      pluginConfigs: { 'fake@fakemkt': { options: { opt: 'fromProject' } } }
    })
    expect(args()).toEqual(['fromUser', 'o'])
  })

  it('skips a server that references a sensitive or unset required option, keeping the others', () => {
    setup({
      manifest: { userConfig: { key: { sensitive: true }, need: { required: true } } },
      mcpJson: {
        secret: { command: 'x', env: { K: '${user_config.key}' } },
        unset: { command: 'x', args: ['${user_config.need}'] },
        fine: { command: 'x' }
      }
    })
    const { servers, skipped } = list()
    expect(servers.map((s) => s.key)).toEqual(['plugin:fake:fine'])
    expect(skipped).toEqual([
      { name: 'plugin:fake:secret', reason: 'needs a secret stored by Claude Code' },
      { name: 'plugin:fake:unset', reason: expect.stringContaining('"need" is not set') }
    ])
  })

  it('leaves ${user_config.X} literal when the plugin declares no userConfig', () => {
    setup({ mcpJson: { s: { command: 'x', args: ['${user_config.opt}'] } } })
    expect((list().servers[0].config as { args: string[] }).args).toEqual(['${user_config.opt}'])
  })

  it('skips MCPB entries and unsupported or untyped entries individually', () => {
    setup({
      manifest: { mcpServers: ['./bundle.mcpb', 'https://example.com/x.mcpb'] },
      mcpJson: {
        ok: {
          type: 'streamable-http',
          url: 'https://e.test/mcp',
          headers: { A: '${CLAUDE_PLUGIN_ROOT}' }
        },
        noType: { url: 'https://e.test' },
        sock: { type: 'ws', url: 'wss://e.test' },
        ide: { type: 'sse-ide', url: 'http://e.test' },
        proxy: { type: 'claudeai-proxy', url: 'https://e.test' }
      }
    })
    const { servers, skipped } = list()
    expect(servers).toHaveLength(1)
    expect(servers[0].config).toMatchObject({ type: 'http', url: 'https://e.test/mcp' })
    expect(skipped.filter((s) => s.reason === 'MCPB bundle not supported')).toHaveLength(2)
    expect(skipped.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'plugin:fake:noType',
        'plugin:fake:sock',
        'plugin:fake:ide',
        'plugin:fake:proxy'
      ])
    )
  })

  it('skips a plugin that is not on disk, one missing from its catalog and an unknown marketplace', () => {
    setup({ enabled: { 'ext@extmkt': true, 'gone@fakemkt': true, 'x@nomkt': true } })
    write(path.join(cfg, 'plugins', 'known_marketplaces.json'), {
      fakemkt: { source: { source: 'directory', path: mkt }, installLocation: mkt },
      extmkt: { source: { source: 'github', repo: 'o/r' }, installLocation: path.join(tmp, 'mkt2') }
    })
    write(path.join(tmp, 'mkt2', '.claude-plugin', 'marketplace.json'), {
      name: 'extmkt',
      plugins: [{ name: 'ext', source: { source: 'github', repo: 'o/ext' }, version: '1.0.0' }]
    })
    const { servers, skipped } = list()
    expect(servers).toEqual([])
    expect(skipped.map((s) => s.name)).toEqual(['ext@extmkt', 'gone@fakemkt', 'x@nomkt'])
    expect(skipped[0].reason).toContain('not installed on disk')
  })

  it('picks the first applicable install record in array order and ignores other projects', () => {
    setup({ enabled: { 'ext@extmkt': true } })
    write(path.join(cfg, 'plugins', 'known_marketplaces.json'), {
      extmkt: { source: { source: 'github', repo: 'o/r' }, installLocation: path.join(tmp, 'mkt2') }
    })
    write(path.join(tmp, 'mkt2', '.claude-plugin', 'marketplace.json'), {
      name: 'extmkt',
      plugins: [{ name: 'ext', source: { source: 'github', repo: 'o/ext' }, version: '1.0.0' }]
    })
    const cache = (v: string): string => path.join(cfg, 'plugins', 'cache', 'extmkt', 'ext', v)
    for (const v of ['1.0.0', '0.9.0', '0.8.0']) {
      write(path.join(cache(v), '.mcp.json'), { mcpServers: { s: { command: v } } })
    }
    const records = [
      {
        scope: 'local',
        projectPath: path.join(tmp, 'other'),
        installPath: cache('0.8.0'),
        version: '0.8.0'
      },
      { scope: 'user', installPath: cache('1.0.0'), version: '1.0.0' },
      { scope: 'local', projectPath: proj, installPath: cache('0.9.0'), version: '0.9.0' }
    ]
    const installed = path.join(cfg, 'plugins', 'installed_plugins.json')
    write(installed, { version: 2, plugins: { 'ext@extmkt': records } })
    const command = (): string => (list().servers[0].config as { command: string }).command
    expect(command()).toBe('1.0.0')
    write(installed, { version: 2, plugins: { 'ext@extmkt': [records[2], records[1]] } })
    expect(command()).toBe('0.9.0')
  })

  it('names the server after the manifest name, not the marketplace entry name', () => {
    const root = setup({ manifest: { name: 'renamed' }, mcpJson: { s: { command: 'x' } } })
    const { servers } = list()
    expect(servers[0].key).toBe('plugin:renamed:s')
    expect(servers[0].pluginId).toBe('fake@fakemkt')
    expect(servers[0].root).toBe(root)
  })

  it('never throws on corrupt files', () => {
    setup({})
    write(path.join(cfg, 'plugins', 'installed_plugins.json'), '{nope')
    write(path.join(cfg, 'plugins', 'known_marketplaces.json'), '[1]')
    expect(() => list()).not.toThrow()
  })
})
