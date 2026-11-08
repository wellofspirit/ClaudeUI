/**
 * Layer 4: Integration test — McpDialog's native writes (`claude-mcp-cli.ts`).
 *
 * Runs the REAL vendored `bun-claude` as `mcp add-json` / `mcp remove` against an
 * isolated HOME and `CLAUDE_CONFIG_DIR`, then reads the result back through the
 * catalog (what the bridges and the dialog see). Pins what the writer relies on: the
 * `--` separator, JSON surviving Windows argv quoting (spaces, quotes, unicode), the
 * three scopes landing where cli.js reads them, and cli.js's own error text on a
 * duplicate / a missing name. No network, no model.
 *
 * Gated behind CLAUDE_INTEGRATION_TESTS=1.
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMcpServerNative, removeMcpServerNative } from '../../core/services/claude-mcp-cli'
import { resolveClaudeMcpCatalog } from '../../core/services/claude-mcp-catalog'
import { locateClaudeLaunch } from '../../core/sdk/locate'

const launch = locateClaudeLaunch()
const SKIP = !process.env.CLAUDE_INTEGRATION_TESTS || !existsSync(launch.command)

describe.skipIf(SKIP)('mcp add-json / remove through the vendored cli.js', () => {
  let root: string
  let project: string
  let env: NodeJS.ProcessEnv
  let managedDir: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claudeui-mcp-cli-')))
    const home = join(root, 'home')
    project = join(root, 'proj')
    managedDir = join(root, 'managed')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(project, 'sub'), { recursive: true })
    mkdirSync(managedDir)
    execFileSync('git', ['init', '-q'], { cwd: project })
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude')
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const catalog = (cwd: string) => resolveClaudeMcpCatalog(cwd, env, { managedDir }).servers

  it('lands each scope where the catalog reads it, from a subdirectory', async () => {
    const cwd = join(project, 'sub')
    const tricky = {
      type: 'stdio' as const,
      command: 'node',
      args: ['-e', 'console.log("a b")', "it's", 'ünï'],
      env: { GREETING: 'hello "world"' }
    }
    expect(await addMcpServerNative('user', 'u1', tricky, cwd, { env })).toEqual({})
    expect(
      await addMcpServerNative(
        'local',
        'l1',
        {
          type: 'http',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: 'Bearer x y' }
        },
        cwd,
        { env }
      )
    ).toEqual({})
    expect(
      await addMcpServerNative('project', 'p1', { command: 'node', args: [] }, cwd, { env })
    ).toEqual({})

    const servers = catalog(cwd)
    expect(servers.u1.source).toBe('user')
    expect(servers.u1.config).toMatchObject({ command: 'node', args: tricky.args, env: tricky.env })
    expect(servers.l1.source).toBe('local')
    expect(servers.l1.config).toMatchObject({ headers: { Authorization: 'Bearer x y' } })
    expect(servers.p1.source).toBe('project')
    // project scope is cwd/.mcp.json: the sub dir, not the git root
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(true)
    // local scope is keyed by the git root, so the root cwd sees it too
    expect(catalog(project).l1?.source).toBe('local')
  })

  it('reports cli.js text for a duplicate name and a missing name', async () => {
    const cwd = join(project, 'sub')
    const dup = await addMcpServerNative('user', 'u1', { command: 'node' }, cwd, { env })
    expect(dup.error).toMatch(/already exists/i)
    const missing = await removeMcpServerNative('user', 'nope', cwd, { env })
    expect(missing.error).toMatch(/No MCP server named "nope"/)
  })

  it('removes from the chosen scope only', async () => {
    const cwd = join(project, 'sub')
    expect(await removeMcpServerNative('user', 'u1', cwd, { env })).toEqual({})
    expect(await removeMcpServerNative('local', 'l1', cwd, { env })).toEqual({})
    expect(await removeMcpServerNative('project', 'p1', cwd, { env })).toEqual({})
    expect(Object.keys(catalog(cwd))).toEqual([])
    expect(readFileSync(join(cwd, '.mcp.json'), 'utf-8')).not.toContain('p1')
  })
})
