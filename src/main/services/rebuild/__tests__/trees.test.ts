/**
 * @vitest-environment node
 *
 * The trees a rebuild may build: parsed from `git worktree list --porcelain`
 * fixtures (a scripted git), ClaudeUI checkouts only, no path in what clients see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BuildInfo } from '../../../../shared/build-info'
import type { Exec } from '../../app-update/exec'
import {
  isClaudeUiCheckout,
  listTrees,
  parseWorktreePorcelain,
  publicTree,
  sourceRepoFor,
  treeIdFor
} from '../trees'

const PORCELAIN = [
  'worktree /work/ClaudeUI',
  'HEAD e4f1a2c9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3',
  'branch refs/heads/pre-release',
  '',
  'worktree /work/ClaudeUI/.claude/worktrees/auto-update',
  'HEAD 1111111aaaaaaabbbbbbbcccccccdddddddeeeee',
  'branch refs/heads/feat/auto-update',
  '',
  'worktree /work/ClaudeUI/.claude/worktrees/detached',
  'HEAD 2222222aaaaaaabbbbbbbcccccccdddddddeeeee',
  'detached',
  '',
  'worktree /work/ClaudeUI/.claude/worktrees/gone',
  'HEAD 3333333aaaaaaabbbbbbbcccccccdddddddeeeee',
  'branch refs/heads/gone',
  'prunable gitdir file points to non-existent location',
  '',
  'worktree /work/elsewhere/notes',
  'HEAD 4444444aaaaaaabbbbbbbcccccccdddddddeeeee',
  'branch refs/heads/notes',
  ''
].join('\n')

describe('parseWorktreePorcelain', () => {
  it('reads every entry in order: path, HEAD, branch (short), detached, prunable', () => {
    const entries = parseWorktreePorcelain(PORCELAIN)
    expect(entries.map((e) => [e.path, e.branch, e.prunable])).toEqual([
      ['/work/ClaudeUI', 'pre-release', false],
      ['/work/ClaudeUI/.claude/worktrees/auto-update', 'feat/auto-update', false],
      ['/work/ClaudeUI/.claude/worktrees/detached', null, false],
      ['/work/ClaudeUI/.claude/worktrees/gone', 'gone', true],
      ['/work/elsewhere/notes', 'notes', false]
    ])
    expect(entries[0].head).toBe('e4f1a2c9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3')
  })

  it('reads a bare main repository, CRLF output, and no trailing blank line', () => {
    const text =
      'worktree /srv/repo.git\r\nbare\r\n\r\nworktree C:/w/tree\r\nHEAD abcdef1\r\nbranch refs/heads/x'
    expect(parseWorktreePorcelain(text)).toEqual([
      { path: '/srv/repo.git', head: null, branch: null, bare: true, prunable: false },
      { path: 'C:/w/tree', head: 'abcdef1', branch: 'x', bare: false, prunable: false }
    ])
  })

  it('ignores garbage and lines before the first worktree', () => {
    expect(parseWorktreePorcelain('HEAD abc\nnonsense\n\n')).toEqual([])
    expect(parseWorktreePorcelain('')).toEqual([])
  })
})

describe('listTrees', () => {
  const exec = (status: Record<string, string>): Exec & { calls: string[][] } => {
    const calls: string[][] = []
    const fn: Exec = async (file, args) => {
      expect(file).toBe('git')
      calls.push([...args])
      if (args.includes('worktree')) return { code: 0, stdout: PORCELAIN, stderr: '' }
      const dir = args[1]
      if (dir in status) return { code: 0, stdout: status[dir], stderr: '' }
      return { code: 128, stdout: '', stderr: 'fatal' }
    }
    return Object.assign(fn, { calls })
  }
  const notNotes = (dir: string): boolean => !dir.includes('elsewhere')

  it('keeps ClaudeUI checkouts that exist, names the main one, counts uncommitted files', async () => {
    const git = exec({
      '/work/ClaudeUI': ' M src/a.ts\n?? new.txt\n',
      '/work/ClaudeUI/.claude/worktrees/auto-update': '',
      '/work/ClaudeUI/.claude/worktrees/detached': ' D gone.ts\n'
    })
    const trees = await listTrees('/work/ClaudeUI', { exec: git, isCheckout: notNotes })
    expect(trees.map(publicTree)).toEqual([
      {
        id: treeIdFor('/work/ClaudeUI'),
        name: 'main checkout',
        branch: 'pre-release',
        commit: 'e4f1a2c',
        dirty: 2
      },
      {
        id: treeIdFor('/work/ClaudeUI/.claude/worktrees/auto-update'),
        name: 'auto-update',
        branch: 'feat/auto-update',
        commit: '1111111',
        dirty: 0
      },
      {
        id: treeIdFor('/work/ClaudeUI/.claude/worktrees/detached'),
        name: 'detached',
        branch: null,
        commit: '2222222',
        dirty: 1
      }
    ])
    expect(trees[0].path).toBe(path.resolve('/work/ClaudeUI'))
    expect(git.calls[0]).toEqual(['-C', '/work/ClaudeUI', 'worktree', 'list', '--porcelain'])
    // Status never takes index.lock (agents commit in these worktrees).
    const statuses = git.calls.filter((c) => c.includes('status'))
    expect(statuses).toHaveLength(3)
    for (const c of statuses)
      expect(c).toEqual(['-C', c[1], '--no-optional-locks', 'status', '--porcelain'])
    // The prunable tree was never asked about.
    expect(git.calls.some((c) => c[1]?.endsWith('gone'))).toBe(false)
  })

  it('what clients see carries no path', async () => {
    const trees = await listTrees('/work/ClaudeUI', { exec: exec({}), isCheckout: notNotes })
    expect(JSON.stringify(trees.map(publicTree))).not.toContain('/work')
  })

  it('a repository git cannot list gives no trees', async () => {
    const failing: Exec = async () => ({ code: 128, stdout: '', stderr: 'not a git repository' })
    await expect(listTrees('/nowhere', { exec: failing })).resolves.toEqual([])
  })

  it('ids are stable per path and differ between trees', () => {
    expect(treeIdFor('/work/ClaudeUI')).toMatch(/^[0-9a-f]{16}$/)
    expect(treeIdFor('/work/ClaudeUI')).toBe(treeIdFor('/work/ClaudeUI/'))
    expect(treeIdFor('/work/ClaudeUI')).not.toBe(treeIdFor('/work/ClaudeUI2'))
  })
})

describe('isClaudeUiCheckout', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-trees-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const tree = (name: string, pkg: unknown, buildScript = true): string => {
    const dir = path.join(root, name)
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    if (pkg !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg))
    if (buildScript) fs.writeFileSync(path.join(dir, 'scripts', 'build.mjs'), '')
    return dir
  }

  it('needs package.json named claudui and scripts/build.mjs', () => {
    expect(isClaudeUiCheckout(tree('ok', { name: 'claudui' }))).toBe(true)
    expect(isClaudeUiCheckout(tree('other', { name: 'something-else' }))).toBe(false)
    expect(isClaudeUiCheckout(tree('noscript', { name: 'claudui' }, false))).toBe(false)
    expect(isClaudeUiCheckout(tree('nopkg', undefined))).toBe(false)
    expect(isClaudeUiCheckout(path.join(root, 'missing'))).toBe(false)
  })
})

describe('sourceRepoFor', () => {
  const local: BuildInfo = {
    schema: 1,
    kind: 'local',
    version: '1.0.0',
    git: { describe: null, baseTag: null, ahead: null, commit: null, dirty: null, branch: null },
    sourcePath: path.resolve('/work/ClaudeUI'),
    builtAt: '2026-11-01T00:00:00.000Z'
  }
  const release: BuildInfo = { ...local, kind: 'release', sourcePath: undefined }
  const abs = path.resolve('/srv/checkout')

  it('the setting wins when set (an absolute path)', () => {
    expect(sourceRepoFor(abs, local)).toBe(abs)
    expect(sourceRepoFor(`  ${abs}  `, release)).toBe(abs)
  })

  it('a relative setting is ignored, not resolved against some cwd', () => {
    expect(sourceRepoFor('checkout', local)).toBeNull()
  })

  it("unset: a local build's own source; a release or dev build has none", () => {
    expect(sourceRepoFor(undefined, local)).toBe(path.resolve('/work/ClaudeUI'))
    expect(sourceRepoFor('', local)).toBe(path.resolve('/work/ClaudeUI'))
    expect(sourceRepoFor(undefined, release)).toBeNull()
    expect(sourceRepoFor(undefined, { kind: 'dev' })).toBeNull()
  })
})
