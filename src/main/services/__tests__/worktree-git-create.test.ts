/**
 * @vitest-environment node
 *
 * createWorktree's post-create setup against real temp repos: core.hooksPath, the ignore rule
 * for `.claude/worktrees/`, and `.worktreeinclude` (Claude Code's semantics).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { simpleGit } from 'simple-git'
import { makeTempGitRepo, type TempGitRepo } from '../../../test/helpers/temp-git-repo'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { createWorktree } from '../../../core/services/worktree'

const posix = (p: string): string => p.replace(/\\/g, '/')

/** Whether this machine lets the test process create symlinks (Windows needs developer mode). */
function canSymlink(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-symlink-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'target'), '')
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const SYMLINKS = canSymlink()

describe('createWorktree: core.hooksPath', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  /** simple-git refuses hooksPath writes unless told otherwise; the tests seed the repo's config. */
  const setHooksPath = (value: string): Promise<string> =>
    simpleGit({ baseDir: repo.path, unsafe: { allowUnsafeHooksPath: true } }).raw([
      'config',
      '--local',
      'core.hooksPath',
      value
    ])
  const hooksPath = async (): Promise<string> =>
    (await repo.git.raw(['config', '--local', '--get', 'core.hooksPath'])).trim()

  it('A1 pins a relative hooksPath to an absolute one so hooks run inside the worktree', async () => {
    const marker = posix(path.join(repo.path, 'hook-ran'))
    await repo.writeFile('.gitignore', '.husky/_\n')
    await repo.commit('ignore generated husky dir')
    await repo.writeFile('.husky/_/pre-commit', `#!/bin/sh\necho ran > "${marker}"\n`)
    fs.chmodSync(path.join(repo.path, '.husky/_/pre-commit'), 0o755)
    await setHooksPath('.husky/_')

    const info = await createWorktree(repo.path, 'hooked')

    expect(await hooksPath()).toBe(posix(path.join(repo.path, '.husky', '_')))

    await fs.promises.writeFile(path.join(info.worktreePath, 'change.txt'), 'x')
    const wtGit = simpleGit(info.worktreePath)
    await wtGit.add('-A')
    await wtGit.commit('from the worktree')
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('A2 leaves an unset hooksPath unset', async () => {
    await createWorktree(repo.path, 'plain')
    expect(await hooksPath()).toBe('')
  })

  it('A3 leaves an absolute hooksPath unchanged', async () => {
    const abs = posix(path.join(repo.path, 'my-hooks'))
    await setHooksPath(abs)
    await createWorktree(repo.path, 'absolute')
    expect(await hooksPath()).toBe(abs)
  })

  it('A4 leaves a ~/ hooksPath unchanged (git expands it; it is not relative)', async () => {
    await setHooksPath('~/.githooks')
    await createWorktree(repo.path, 'tilde')
    expect(await hooksPath()).toBe('~/.githooks')
  })
})

describe('createWorktree: .claude/worktrees/ in the main status', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  const excludeFile = (): string => path.join(repo.path, '.git', 'info', 'exclude')
  const excludeLines = (): string[] =>
    fs.existsSync(excludeFile())
      ? fs
          .readFileSync(excludeFile(), 'utf-8')
          .split('\n')
          .filter((l) => l === '/.claude/worktrees/')
      : []

  it('B1 hides the worktree from the main checkout, once, however many are created', async () => {
    await createWorktree(repo.path, 'one')
    await createWorktree(repo.path, 'two')

    const status = await repo.git.raw(['status', '--porcelain'])
    expect(status).not.toContain('.claude')
    expect(excludeLines()).toHaveLength(1)
  })

  it('B1 appends on its own line when the exclude file has no trailing newline', async () => {
    fs.mkdirSync(path.dirname(excludeFile()), { recursive: true })
    fs.writeFileSync(excludeFile(), '*.log')
    await createWorktree(repo.path, 'one')
    expect(fs.readFileSync(excludeFile(), 'utf-8')).toMatch(/^\*\.log\n# ClaudeUI worktrees\n/)
  })

  it('B2 leaves the exclude file alone when the repo already ignores the folder', async () => {
    await repo.writeFile('.gitignore', '.claude/worktrees/\n')
    await repo.commit('ignore worktrees')
    const before = fs.existsSync(excludeFile()) ? fs.readFileSync(excludeFile(), 'utf-8') : null

    await createWorktree(repo.path, 'one')

    const after = fs.existsSync(excludeFile()) ? fs.readFileSync(excludeFile(), 'utf-8') : null
    expect(after).toBe(before)
  })

  it('B3 adds the line once even when a .gitignore negation outranks it', async () => {
    await repo.writeFile('.gitignore', '!.claude/worktrees/\n')
    await repo.commit('un-ignore worktrees')
    await createWorktree(repo.path, 'one')
    await createWorktree(repo.path, 'two')
    expect(excludeLines()).toHaveLength(1)
  })
})

describe('createWorktree: .worktreeinclude', () => {
  let repo: TempGitRepo

  beforeEach(async () => {
    repo = await makeTempGitRepo()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  /** Commit the ignore rules, then drop in the (untracked) include file. */
  const configure = async (gitignore: string, include: string): Promise<void> => {
    await repo.writeFile('.gitignore', gitignore)
    await repo.commit('ignore rules')
    await repo.writeFile('.worktreeinclude', include)
  }
  const exists = (info: { worktreePath: string }, rel: string): boolean =>
    fs.existsSync(path.join(info.worktreePath, rel))

  it('C1 copies a listed gitignored file', async () => {
    await configure('.env\n', '.env\n')
    await repo.writeFile('.env', 'SECRET=1')
    const info = await createWorktree(repo.path, 'c1')
    expect(fs.readFileSync(path.join(info.worktreePath, '.env'), 'utf-8')).toBe('SECRET=1')
  })

  it('C2 does not copy a listed file that is untracked but not ignored', async () => {
    await configure('.env\n', 'plain.txt\n')
    await repo.writeFile('plain.txt', 'x')
    const info = await createWorktree(repo.path, 'c2')
    expect(exists(info, 'plain.txt')).toBe(false)
  })

  it('C3 honours negation', async () => {
    await configure('config/*.local\n', 'config/*.local\n!config/keep.local\n')
    await repo.writeFile('config/a.local', 'a')
    await repo.writeFile('config/keep.local', 'k')
    const info = await createWorktree(repo.path, 'c3')
    expect(exists(info, 'config/a.local')).toBe(true)
    expect(exists(info, 'config/keep.local')).toBe(false)
  })

  it('C4 expands a listed ignored directory', async () => {
    await configure('secrets/\n', 'secrets/\n')
    await repo.writeFile('secrets/a.txt', 'a')
    await repo.writeFile('secrets/sub/b.txt', 'b')
    const info = await createWorktree(repo.path, 'c4')
    expect(exists(info, 'secrets/a.txt')).toBe(true)
    expect(exists(info, 'secrets/sub/b.txt')).toBe(true)
  })

  it('C5 a basename pattern does not descend into node_modules', async () => {
    await configure('node_modules/\n*.env\n', '*.env\n')
    await repo.writeFile('local.env', 'x')
    await repo.writeFile('node_modules/pkg/.env', 'x')
    const info = await createWorktree(repo.path, 'c5')
    expect(exists(info, 'local.env')).toBe(true)
    expect(exists(info, 'node_modules')).toBe(false)
  })

  it('C6 a .claude/ pattern never copies other worktrees into the new one', async () => {
    await configure('.claude/\n', '.claude/\n')
    await repo.writeFile('.claude/extra.json', '{}')
    await createWorktree(repo.path, 'first')
    const info = await createWorktree(repo.path, 'c6')
    expect(exists(info, '.claude/extra.json')).toBe(true)
    expect(exists(info, '.claude/worktrees')).toBe(false)
  })

  it('C7 creates normally without a .worktreeinclude', async () => {
    await repo.writeFile('.gitignore', '.env\n')
    await repo.commit('ignore rules')
    await repo.writeFile('.env', 'x')
    const info = await createWorktree(repo.path, 'c7')
    expect(fs.existsSync(info.worktreePath)).toBe(true)
    expect(exists(info, '.env')).toBe(false)
  })

  it.skipIf(!SYMLINKS)('C8 skips a symlinked source', async () => {
    await configure('*.env\n', '*.env\n')
    const target = path.join(repo.path, 'real-target.txt')
    await repo.writeFile('real-target.txt', 'secret')
    fs.symlinkSync(target, path.join(repo.path, 'link.env'))
    const info = await createWorktree(repo.path, 'c8')
    expect(exists(info, 'link.env')).toBe(false)
  })

  it.skipIf(!SYMLINKS)(
    'C9 skips a destination that a committed symlink redirects outside',
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-outside-'))
      try {
        await repo.git.raw(['config', 'core.symlinks', 'true'])
        await repo.writeFile('.gitignore', '*.env\n')
        fs.symlinkSync(outside, path.join(repo.path, 'data'), 'dir')
        await repo.commit('data is a symlink')
        // In the main checkout `data` is a real directory; in the new worktree it is the symlink.
        fs.unlinkSync(path.join(repo.path, 'data'))
        await repo.writeFile('data/x.env', 'x')
        await repo.writeFile('.worktreeinclude', '*.env\n')

        await createWorktree(repo.path, 'c9')

        expect(fs.readdirSync(outside)).toEqual([])
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!SYMLINKS)(
    'C10 skips a destination that is itself a dangling committed symlink',
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-outside-'))
      try {
        await repo.git.raw(['config', 'core.symlinks', 'true'])
        await repo.writeFile('.gitignore', '*.env\n')
        // Committed as a link to a file that does not exist; force-add past the ignore rule.
        fs.symlinkSync(path.join(outside, 'cfg.env'), path.join(repo.path, 'cfg.env'))
        await repo.git.raw(['add', '-f', 'cfg.env'])
        await repo.commit('cfg.env is a symlink')
        // The main checkout untracks it and holds a real ignored file there instead.
        await repo.git.raw(['rm', '--cached', 'cfg.env'])
        fs.unlinkSync(path.join(repo.path, 'cfg.env'))
        await repo.writeFile('cfg.env', 'x')
        await repo.writeFile('.worktreeinclude', '*.env\n')

        await createWorktree(repo.path, 'c10')

        expect(fs.readdirSync(outside)).toEqual([])
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    }
  )

  it('C11 ignores a byte-order mark at the start of .worktreeinclude', async () => {
    await configure('.env\n', '\uFEFF.env\n')
    await repo.writeFile('.env', 'SECRET=1')
    const info = await createWorktree(repo.path, 'c11')
    expect(exists(info, '.env')).toBe(true)
  })
})
