/**
 * @vitest-environment node
 *
 * The McpDialog helpers in `claude-mcp.ts` that the native-write flow leans on:
 * removing ClaudeUI legacy entries without touching cli.js's own `<cwd>/.mcp.json`,
 * and the catalog list keyed by the name Claude Code knows a server by. Real files
 * under a throwaway CLAUDE_CONFIG_DIR.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { removeClaudeUiLegacyMcpServer, removeMcpServer } from '../claude-mcp'

let root: string
let cfg: string
let repo: string
const env = (): Record<string, string> => ({ CLAUDE_CONFIG_DIR: cfg })
const writeJson = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
}
const readJson = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf-8'))

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-dialog-')))
  cfg = path.join(root, 'cfg')
  repo = path.join(root, 'repo')
  fs.mkdirSync(cfg, { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('removing a ClaudeUI legacy entry', () => {
  it('clears every legacy file but leaves <cwd>/.mcp.json (cli.js owns it)', () => {
    const entry = { command: 'x' }
    writeJson(path.join(cfg, '.mcp.json'), { mcpServers: { dup: entry, keep: entry } })
    writeJson(path.join(cfg, 'settings.json'), { mcpServers: { dup: entry } })
    writeJson(path.join(repo, '.claude', 'settings.json'), { mcpServers: { dup: entry } })
    writeJson(path.join(repo, '.claude', 'settings.local.json'), { mcpServers: { dup: entry } })
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { dup: entry } })

    removeClaudeUiLegacyMcpServer('dup', repo, env())

    expect(readJson(path.join(cfg, '.mcp.json')).mcpServers).toEqual({ keep: entry })
    expect(readJson(path.join(cfg, 'settings.json')).mcpServers).toBeUndefined()
    expect(readJson(path.join(repo, '.claude', 'settings.json')).mcpServers).toBeUndefined()
    expect(readJson(path.join(repo, '.claude', 'settings.local.json')).mcpServers).toBeUndefined()
    expect(readJson(path.join(repo, '.mcp.json')).mcpServers).toEqual({ dup: entry })
  })

  it('removeMcpServer without legacyLayer still clears the project .mcp.json (old behaviour)', () => {
    writeJson(path.join(repo, '.mcp.json'), { mcpServers: { dup: { command: 'x' } } })
    removeMcpServer('project', 'dup', repo, { env: env() })
    expect(readJson(path.join(repo, '.mcp.json')).mcpServers).toBeUndefined()
  })
})
