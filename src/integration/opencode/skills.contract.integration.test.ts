/**
 * opencode 2.x contract: the shared Claude skill catalog reaches the real engine through the
 * REAL `claudeui-xeng` plugin and ClaudeUI's per-server host route (`GET /skills`), with
 * `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` (what `buildServerEnv` sets). The catalog is a
 * hand-built fixture (`startMcpHttpHost`'s `skillCatalog`); no model is involved.
 *
 * Proven against the pinned binary:
 *  (a) a `.claude/skills` skill the catalog does not name is NOT loaded natively (the flag);
 *  (b) a catalog skill (incl. a plugin skill `p:s`) is listed by `skill.list` under its Claude id,
 *      with the catalog's content, and `guard` reports `skillsLoaded: true`;
 *  (c) a same-id skill from `.agents/skills` wins over the catalog's;
 *  (d) `reloadSkills` re-fetches and the registry changes without a new location
 *      (`skill.reload()` re-runs the plugin's transform).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ClaudeSkillCatalog, ClaudeSkillEntry } from '../../core/services/claude-skill-catalog'
import { startMcpHttpHost, type McpHttpHost } from '../../core/opencode/mcp-http-host'
import { buildServerEnv } from '../../core/opencode/opencode-server-spawn'
import type { Config_InfoEncoded } from '../../core/opencode/protocol-v2/openapi'
import { describeV2, fixtureConfig, useRig, type Rig, type TestHome } from './harness/host'
import type { FixtureProvider } from './harness/fixture-provider'

const PLUGIN_SRC = join(__dirname, '..', '..', '..', 'resources', 'opencode', 'claudeui-xeng')

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: on-disk ${name}\n---\n${body}\n`

const entry = (name: string, file: string, body: string): ClaudeSkillEntry => ({
  name,
  kind: 'skill',
  source: 'project',
  file,
  baseDir: file.replace(/\/SKILL\.md$/, ''),
  description: `catalog ${name}`,
  argumentNames: [],
  body,
  userInvocable: true,
  modelInvocable: true,
  claudeOnly: [],
  ...(name.includes(':') ? { source: 'plugin' as const, pluginName: name.split(':')[0] } : {})
})

let host: McpHttpHost
let catalog: ClaudeSkillCatalog = { entries: [], skipped: [] }

beforeAll(async () => {
  host = await startMcpHttpHost(() => new McpServer({ name: 'blank', version: '0' }), {
    skillCatalog: () => catalog
  })
})
afterAll(async () => {
  await host?.close()
})

/** The workspace's files and the config handing the plugin the host endpoint. */
function skillConfig(fixture: FixtureProvider, home: TestHome): Config_InfoEncoded {
  const cwd = home.workspace('main')
  const skill = (dir: string, name: string, body: string) => {
    mkdirSync(join(cwd, dir, name), { recursive: true })
    writeFileSync(join(cwd, dir, name, 'SKILL.md'), skillMd(name, body))
    return join(cwd, dir, name, 'SKILL.md')
  }
  const claudeFile = skill('.claude/skills', 'from-claude', 'CLAUDE DISK BODY')
  skill('.claude/skills', 'native-only', 'NATIVE ONLY')
  skill('.agents/skills', 'clash', 'ENGINE CLASH BODY')
  catalog = {
    entries: [
      entry('from-claude', claudeFile, 'CATALOG BODY from-claude'),
      entry('p:s', join(home.root, 'plugin', 'skills', 's', 'SKILL.md'), 'PLUGIN BODY'),
      entry('clash', join(cwd, '.claude', 'skills', 'clash', 'SKILL.md'), 'CATALOG CLASH BODY')
    ],
    skipped: []
  }
  const directory = join(home.root, 'plugins', 'claudeui-xeng')
  mkdirSync(directory, { recursive: true })
  for (const file of ['index.js', 'package.json'])
    copyFileSync(join(PLUGIN_SRC, file), join(directory, file))
  return {
    ...fixtureConfig(fixture),
    plugins: [
      {
        package: directory,
        options: {
          modelAllowlist: {},
          skills: { url: `http://127.0.0.1:${host.port}/skills`, token: host.token }
        }
      }
    ]
  }
}

async function rpc(r: Rig, method: string): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${r.server.url}/api/rpc/claudeui-xeng/${method}`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`opencode:${r.server.password}`).toString('base64'),
      'x-opencode-directory': r.cwd,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ input: {} })
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  return response.ok ? body.output : undefined
}

describeV2('opencode 2.x contract: the shared Claude skill catalog', () => {
  const rig = useRig('skills', {
    config: skillConfig,
    // What `buildServerEnv` sets: opencode's own `.claude/skills` reader is off.
    env: () => ({
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: buildServerEnv({}, 'x', '{}')
        .OPENCODE_DISABLE_CLAUDE_CODE_SKILLS as string
    })
  })
  beforeAll(() => {
    execFileSync('git', ['init', '-q'], { cwd: rig().cwd })
  })

  /** `skill.list` once the plugin has registered (the guard RPC answers: what ClaudeUI waits for too). */
  const listed = async (r: Rig) => {
    for (let i = 0; i < 50 && !(await rpc(r, 'guard')); i++)
      await new Promise((resolve) => setTimeout(resolve, 100))
    return (await r.api.ok('skill.list')).data
  }

  it('(a) a .claude/skills skill the catalog does not name is not loaded natively', async () => {
    const ids = (await listed(rig())).map((s) => s.id)
    expect(ids).not.toContain('native-only')
  })

  it('(b) catalog skills (plugin skill included) are listed under their Claude ids, with the catalog content', async () => {
    const r = rig()
    const skills = await listed(r)
    expect(skills.find((s) => s.id === 'from-claude')).toMatchObject({
      content: expect.stringContaining('CATALOG BODY from-claude'),
      description: 'catalog from-claude'
    })
    expect(skills.find((s) => s.id === 'p:s')).toMatchObject({
      content: expect.stringContaining('PLUGIN BODY')
    })
    await expect(rpc(r, 'guard')).resolves.toMatchObject({ skillsLoaded: true })
  })

  it("(c) the engine's own same-id skill (.agents) wins over the catalog's", async () => {
    const clash = (await listed(rig())).find((s) => s.id === 'clash')
    expect(clash?.content).toContain('ENGINE CLASH BODY')
    expect(clash?.content).not.toContain('CATALOG CLASH BODY')
  })

  it('(d) reloadSkills re-fetches and rebuilds the registry for the open location', async () => {
    const r = rig()
    catalog = {
      ...catalog,
      entries: [...catalog.entries, entry('late', join(r.cwd, 'late', 'SKILL.md'), 'LATE BODY')]
    }
    expect((await listed(r)).map((s) => s.id)).not.toContain('late')
    await expect(rpc(r, 'reloadSkills')).resolves.toMatchObject({ loaded: true })
    expect((await listed(r)).map((s) => s.id)).toContain('late')
  })
})
