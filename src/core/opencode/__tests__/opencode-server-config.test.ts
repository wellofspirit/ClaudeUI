/**
 * The opencode 2.x OPENCODE_CONFIG_CONTENT builder (ADR-097 §2, §4).
 *
 * Guards:
 * - native 2.x keys only: `mcp.servers`, `plugins`, `agents.*.permissions`;
 *   none of the 1.x keys (`mcp.<name>` flat, `plugin`, `agent`,
 *   `experimental.continue_loop_on_deny`, `autoupdate`, `enabled`);
 * - the reserved `claudeui` server: remote, bearer, `oauth:false`,
 *   `codemode:false`, and it wins over a bridged server of the same name;
 * - bridged servers keep `codemode:false`;
 * - `configIdentity` keys a server by what is injected — order-independent,
 *   blind to the per-server hosted endpoint, and a digest (never a secret).
 */
import { describe, it, expect } from 'vitest'
import {
  buildOpencodeConfig,
  buildOpencodeConfigContent,
  configIdentity,
  HOSTED_MCP_SERVER,
  type OpencodeConfigInput
} from '../opencode-server-config'
import type { Config_InfoEncoded } from '../protocol-v2/openapi'

const HOSTED = { port: 19000, token: 'hosted-secret-token' }
const BRIDGED: OpencodeConfigInput['bridgedMcp'] = {
  github: {
    type: 'local',
    command: ['gh-mcp', '--stdio'],
    environment: { GITHUB_TOKEN: 'ghp_bridged_secret' },
    codemode: false
  },
  docs: {
    type: 'remote',
    url: 'https://docs.example/mcp',
    headers: { Authorization: 'Bearer docs-secret' },
    codemode: false
  }
}

const parse = (input: OpencodeConfigInput): Record<string, unknown> =>
  JSON.parse(buildOpencodeConfigContent(input, HOSTED)) as Record<string, unknown>

describe('buildOpencodeConfig (opencode 2.x)', () => {
  it('is typed as the 2.x Config.InfoEncoded', () => {
    const config: Config_InfoEncoded = buildOpencodeConfig({}, HOSTED)
    expect(config.mcp?.servers).toBeDefined()
  })

  it('emits only native 2.x keys — no continue_loop_on_deny, autoupdate or 1.x keys', () => {
    const out = parse({ bridgedMcp: BRIDGED, pluginDir: '/app/resources/opencode/claudeui-xeng' })
    expect(Object.keys(out).sort()).toEqual(['mcp', 'plugins'])
    expect(out).not.toHaveProperty('experimental')
    expect(out).not.toHaveProperty('autoupdate')
    expect(out).not.toHaveProperty('plugin')
    expect(out).not.toHaveProperty('agent')
    expect(JSON.stringify(out)).not.toContain('continue_loop_on_deny')
    expect(JSON.stringify(out)).not.toContain('"enabled"')
    expect(Object.keys(out.mcp as object)).toEqual(['servers'])
  })

  it('the hosted claudeui server: remote, bearer, oauth:false, codemode:false, no numeric timeout', () => {
    const servers = buildOpencodeConfig({}, HOSTED).mcp!.servers!
    expect(servers[HOSTED_MCP_SERVER]).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:19000/mcp',
      headers: { Authorization: 'Bearer hosted-secret-token' },
      oauth: false,
      codemode: false
    })
  })

  it('bridged servers sit beside claudeui, all codemode:false', () => {
    const servers = buildOpencodeConfig({ bridgedMcp: BRIDGED }, HOSTED).mcp!.servers!
    expect(Object.keys(servers).sort()).toEqual(['claudeui', 'docs', 'github'])
    for (const entry of Object.values(servers)) expect(entry.codemode).toBe(false)
    expect(servers.github).toEqual(BRIDGED!.github)
  })

  it('a bridged server named claudeui never shadows the hosted one', () => {
    const servers = buildOpencodeConfig(
      { bridgedMcp: { claudeui: { type: 'remote', url: 'https://evil/mcp', codemode: false } } },
      HOSTED
    ).mcp!.servers!
    expect(servers.claudeui).toMatchObject({ url: 'http://127.0.0.1:19000/mcp', oauth: false })
  })

  it('plugins lists the directory plugin, and is absent without one', () => {
    expect(parse({ pluginDir: '/p/claudeui-xeng' }).plugins).toEqual(['/p/claudeui-xeng'])
    expect(parse({ pluginDir: null })).not.toHaveProperty('plugins')
    expect(parse({})).not.toHaveProperty('plugins')
  })

  it('S6 seam: agents.<name>.permissions from the overlay; empty rule lists and overlays emit nothing', () => {
    const out = buildOpencodeConfig(
      {
        agentPermissions: {
          general: [{ action: 'shell', resource: '*', effect: 'ask' }],
          explore: []
        }
      },
      HOSTED
    )
    expect(out.agents).toEqual({
      general: { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }
    })
    expect(buildOpencodeConfig({ agentPermissions: {} }, HOSTED)).not.toHaveProperty('agents')
    expect(buildOpencodeConfig({ agentPermissions: { explore: [] } }, HOSTED)).not.toHaveProperty(
      'agents'
    )
  })
})

describe('configIdentity', () => {
  it('is equal for equal inputs whatever the key order', () => {
    const reordered: OpencodeConfigInput['bridgedMcp'] = {
      docs: {
        codemode: false,
        url: 'https://docs.example/mcp',
        type: 'remote',
        headers: { Authorization: 'Bearer docs-secret' }
      },
      github: {
        environment: { GITHUB_TOKEN: 'ghp_bridged_secret' },
        codemode: false,
        command: ['gh-mcp', '--stdio'],
        type: 'local'
      }
    }
    expect(configIdentity({ bridgedMcp: BRIDGED, pluginDir: '/p' })).toBe(
      configIdentity({ pluginDir: '/p', bridgedMcp: reordered })
    )
  })

  it('changes when what is injected changes', () => {
    const base = configIdentity({ bridgedMcp: BRIDGED, pluginDir: '/p' })
    expect(configIdentity({ bridgedMcp: {}, pluginDir: '/p' })).not.toBe(base)
    expect(configIdentity({ bridgedMcp: BRIDGED, pluginDir: null })).not.toBe(base)
    expect(
      configIdentity({
        bridgedMcp: BRIDGED,
        pluginDir: '/p',
        agentPermissions: { general: [{ action: 'shell', resource: '*', effect: 'ask' }] }
      })
    ).not.toBe(base)
  })

  it('treats absent and empty the same (no spurious second server)', () => {
    expect(configIdentity({})).toBe(
      configIdentity({ bridgedMcp: {}, pluginDir: null, agentPermissions: { explore: [] } })
    )
  })

  it('is a short hex digest that carries no secret', () => {
    const id = configIdentity({ bridgedMcp: BRIDGED })
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(id).not.toContain('secret')
  })
})
