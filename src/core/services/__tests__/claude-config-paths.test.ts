/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  claudeConfigDir,
  claudeGlobalConfigPath,
  claudeProjectKey,
  mergeSettings,
  readClaudeSettingsLayers
} from '../claude-config-paths'

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-paths-')))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const run = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

describe('global config path', () => {
  it('lives inside CLAUDE_CONFIG_DIR, not next to it', () => {
    expect(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: root })).toBe(
      path.join(root, '.claude.json')
    )
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: root })).toBe(root)
  })

  it('prefers a non-empty legacy .config.json, ignores an empty one, honours the oauth suffix', () => {
    const env = { CLAUDE_CONFIG_DIR: root }
    fs.writeFileSync(path.join(root, '.config.json'), '')
    expect(claudeGlobalConfigPath(env)).toBe(path.join(root, '.claude.json'))
    fs.writeFileSync(path.join(root, '.config.json'), '{}')
    expect(claudeGlobalConfigPath(env)).toBe(path.join(root, '.config.json'))
    fs.rmSync(path.join(root, '.config.json'))
    expect(claudeGlobalConfigPath({ ...env, CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://x' })).toBe(
      path.join(root, '.claude-custom-oauth.json')
    )
  })
})

describe('project key', () => {
  it('is the git root from a subdir, the main checkout from a linked worktree, the cwd outside git', () => {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    run(repo, 'init', '-q')
    run(repo, 'commit', '-q', '--allow-empty', '-m', 'i')
    const wt = path.join(root, 'wt')
    run(repo, 'worktree', 'add', '-q', wt, '-b', 'b')
    const sub = path.join(repo, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    const want = repo.replace(/\\/g, '/')
    expect(claudeProjectKey(repo)).toBe(want)
    expect(claudeProjectKey(sub)).toBe(want)
    expect(claudeProjectKey(wt)).toBe(want)
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    expect(claudeProjectKey(plain)).toBe(plain.replace(/\\/g, '/'))
  })
})

describe('settings layers', () => {
  it('reads user from the config dir and project/local from the cwd, with drop-in policy files in name order', () => {
    const cfg = path.join(root, 'cfg')
    const cwd = path.join(root, 'proj')
    const managed = path.join(root, 'managed')
    const files: [string, unknown][] = [
      [path.join(cfg, 'settings.json'), { u: 1 }],
      [path.join(cwd, '.claude', 'settings.json'), { p: 1 }],
      [path.join(cwd, '.claude', 'settings.local.json'), { l: 1 }],
      [path.join(managed, 'managed-settings.json'), { m: 1, list: ['a'] }],
      [path.join(managed, 'managed-settings.d', '20-b.json'), { m: 3, list: ['c'] }],
      [path.join(managed, 'managed-settings.d', '10-a.json'), { m: 2, list: ['b'] }]
    ]
    for (const [file, data] of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data))
    }
    expect(
      readClaudeSettingsLayers(cwd, { env: { CLAUDE_CONFIG_DIR: cfg }, managedDir: managed })
    ).toEqual({
      user: { u: 1 },
      project: { p: 1 },
      local: { l: 1 },
      policy: { m: 3, list: ['a', 'b', 'c'] }
    })
  })

  it('mergeSettings concatenates arrays without duplicates and merges objects per key', () => {
    expect(
      mergeSettings({ a: ['x'], o: { k: 1, j: 1 }, s: 1 }, { a: ['x', 'y'], o: { k: 2 }, s: 2 })
    ).toEqual({ a: ['x', 'y'], o: { k: 2, j: 1 }, s: 2 })
  })
})
