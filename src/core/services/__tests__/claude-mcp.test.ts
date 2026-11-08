/**
 * @vitest-environment node
 *
 * McpDialog's cold toggle (disabledMcpServers read/write) and the ClaudeUI
 * legacy layer a Claude session receives through `--mcp-config`, against real
 * files under a throwaway CLAUDE_CONFIG_DIR.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildArgs } from '../../sdk/args'
import { loadMcpServers, readDisabledMcpServers, writeDisabledMcpServers } from '../claude-mcp'
import { loadClaudeUiLegacyMcpServers } from '../claude-mcp-files'

let root: string
let cfg: string
let repo: string
let home: string
const env = (): Record<string, string> => ({ CLAUDE_CONFIG_DIR: cfg, HOME: home })
const writeJson = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
}
const readGlobal = (): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf-8'))

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-')))
  cfg = path.join(root, 'cfg')
  repo = path.join(root, 'repo')
  home = path.join(root, 'home')
  fs.mkdirSync(cfg, { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('disabledMcpServers read/write (A4)', () => {
  it('writes under the git-root key, so a subdir and the repo root share one list', () => {
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
    const sub = path.join(repo, 'pkg')
    fs.mkdirSync(sub)
    writeDisabledMcpServers(sub, ['a', 'plugin:p:s'], env())
    const key = repo.replace(/\\/g, '/')
    expect(readGlobal().projects[key].disabledMcpServers).toEqual(['a', 'plugin:p:s'])
    expect(Object.keys(readGlobal().projects)).toEqual([key])
    expect(readDisabledMcpServers(repo, env())).toEqual(['a', 'plugin:p:s'])
  })

  it('keeps unrelated fields and clears the key when emptied', () => {
    const key = repo.replace(/\\/g, '/')
    writeJson(path.join(cfg, '.claude.json'), {
      numStartups: 7,
      projects: { [key]: { hasTrustDialogAccepted: true, disabledMcpServers: ['x'] } }
    })
    writeDisabledMcpServers(repo, [], env())
    expect(readGlobal()).toEqual({
      numStartups: 7,
      projects: { [key]: { hasTrustDialogAccepted: true } }
    })
  })

  it('refuses to overwrite an unreadable global config', () => {
    fs.writeFileSync(path.join(cfg, '.claude.json'), '{ broken')
    expect(() => writeDisabledMcpServers(repo, ['a'], env())).toThrow(/Refusing/)
    expect(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf-8')).toBe('{ broken')
  })
})

describe('ClaudeUI legacy layer on the spawn (A8)', () => {
  const server = (command: string): { command: string } => ({ command })

  beforeEach(() => {
    writeJson(path.join(home, '.claude', '.mcp.json'), { mcpServers: { cfg_mcp: server('a') } })
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { cfg_settings: server('b') }
    })
    writeJson(path.join(repo, '.claude', 'settings.json'), {
      mcpServers: { proj_settings: server('c') }
    })
    writeJson(path.join(repo, '.claude', 'settings.local.json'), {
      mcpServers: { local_settings: server('d') }
    })
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { native_project: server('e') } })
  })

  it('carries the legacy files but not <cwd>/.mcp.json', () => {
    const servers = loadClaudeUiLegacyMcpServers(repo, env())
    expect(Object.keys(servers).sort()).toEqual([
      'cfg_mcp',
      'cfg_settings',
      'local_settings',
      'proj_settings'
    ])
    const args = buildArgs({ mcpServers: servers } as never)
    const sent = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(Object.keys(sent.mcpServers)).not.toContain('native_project')
    expect(Object.keys(sent.mcpServers)).toContain('proj_settings')
  })

  it('loadMcpServers keeps <cwd>/.mcp.json for the dialog unless asked for the legacy layer', () => {
    expect(Object.keys(loadMcpServers('project', repo))).toContain('native_project')
    expect(Object.keys(loadMcpServers('project', repo, { legacyLayer: true }))).toEqual([
      'proj_settings'
    ])
  })
})
