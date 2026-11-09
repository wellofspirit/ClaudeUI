/**
 * Layer 4: Integration test — the skill catalog (`claude-skill-catalog.ts`) against the names
 * the REAL vendored cli.js reports.
 *
 * Spawns the pinned cli.js (through the in-house `query()` harness) in an isolated HOME and
 * `CLAUDE_CONFIG_DIR` over a fixture project with user / project skills, nested legacy
 * commands, an enabled plugin with skills and commands, a disabled plugin and a `skillOverrides`
 * `off`, and reads the `commands` of the `reload_plugins` response, which needs no model call, no
 * credentials and no network. The catalog's user-invocable names must be exactly the fixture's
 * names that cli.js lists, and what the catalog drops (off, disabled plugin, conditional) must
 * be absent from cli.js too. The managed directory is a fixed system path and is not covered.
 *
 * Gated behind CLAUDE_INTEGRATION_TESTS=1.
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveClaudeSkillCatalog } from '../../core/services/claude-skill-catalog'
import { locateClaudeLaunch } from '../../core/sdk/locate'

const launch = locateClaudeLaunch()
const SKIP = !process.env.CLAUDE_INTEGRATION_TESTS || !existsSync(launch.command)

const put = (file: string, text: string | object): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text))
}
const skillMd = (description: string, extra = ''): string =>
  `---\ndescription: ${description}\n${extra}---\nbody of ${description}\n`

describe.skipIf(SKIP)('the skill catalog against the vendored cli.js', () => {
  let root: string
  let project: string
  let home: string
  let env: NodeJS.ProcessEnv
  let cliNames: Set<string>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claudeui-skill-catalog-')))
    home = join(root, 'home')
    const cfg = join(home, '.claude')
    project = join(home, 'work', 'proj')
    const mkt = join(root, 'mkt')
    mkdirSync(project, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: project })

    put(join(cfg, 'skills', 'user-skill', 'SKILL.md'), skillMd('user skill'))
    put(join(cfg, 'skills', 'turned-off', 'SKILL.md'), skillMd('off by override'))
    put(join(cfg, 'commands', 'ucmd.md'), 'user command body\n')
    put(join(project, '.claude', 'skills', 'proj-skill', 'SKILL.md'), skillMd('project skill'))
    put(
      join(project, '.claude', 'skills', 'cond-skill', 'SKILL.md'),
      skillMd('conditional', 'paths:\n  - "src/**/*.ts"\n')
    )
    put(join(project, '.claude', 'commands', 'ns', 'deep', 'cmd.md'), 'nested command body\n')
    put(join(project, '.claude', 'commands', 'plain.md'), skillMd('plain command'))

    put(join(mkt, '.claude-plugin', 'marketplace.json'), {
      name: 'fakemkt',
      owner: { name: 'probe' },
      plugins: ['on', 'off'].map((n) => ({ name: n, source: `./plugins/${n}`, version: '1.0.0' }))
    })
    for (const n of ['on', 'off']) {
      put(join(mkt, 'plugins', n, '.claude-plugin', 'plugin.json'), { name: n })
      put(join(mkt, 'plugins', n, 'skills', 'ps', 'SKILL.md'), skillMd(`${n} plugin skill`))
      put(join(mkt, 'plugins', n, 'commands', 'pc.md'), skillMd(`${n} plugin command`))
    }
    put(join(cfg, 'plugins', 'known_marketplaces.json'), {
      fakemkt: { source: { source: 'directory', path: mkt }, installLocation: mkt }
    })
    put(join(cfg, 'settings.json'), {
      enabledPlugins: { 'on@fakemkt': true, 'off@fakemkt': false },
      skillOverrides: { 'turned-off': 'off' }
    })

    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: cfg
    }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    delete env.CLAUDE_CODE_DISABLE_POLICY_SKILLS

    const { query } = await import('../../core/sdk')
    let release: () => void = () => {}
    const idle = new Promise<void>((resolve) => (release = resolve))
    // A streaming prompt that never sends a message: cli.js initializes, no model is called.
    // eslint-disable-next-line require-yield
    async function* prompt(): AsyncGenerator<never> {
      await idle
    }
    const abort = new AbortController()
    const q = query({
      prompt: prompt(),
      options: { cwd: project, persistSession: false, env, abortController: abort }
    })
    try {
      // The initialize response predates plugin loading; reload_plugins returns the full set.
      const reloaded = (await q.reloadPlugins()) as { commands?: Array<{ name?: string }> }
      const commands = reloaded.commands ?? []
      cliNames = new Set(commands.map((c) => c.name).filter((n): n is string => !!n))
    } finally {
      release()
      abort.abort()
      await q.endSession().catch(() => undefined)
    }
  }, 60_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists exactly the fixture names the catalog lists, under the same spelling', () => {
    const catalog = resolveClaudeSkillCatalog(project, { env, homeDir: home })
    const mine = catalog.entries.filter((e) => e.userInvocable).map((e) => e.name)
    expect(mine.sort()).toEqual(
      ['user-skill', 'proj-skill', 'ucmd', 'ns:deep:cmd', 'plain', 'on:ps', 'on:pc'].sort()
    )
    for (const name of mine) expect(cliNames, name).toContain(name)
  })

  it('does not list what the catalog drops', () => {
    for (const name of ['turned-off', 'cond-skill', 'off:ps', 'off:pc']) {
      expect(cliNames, name).not.toContain(name)
    }
  })
})
