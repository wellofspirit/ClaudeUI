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
  claudeProjectLocation,
  mergeSettings,
  readClaudeSettingsLayers
} from '../claude-config-paths'

let root: string
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-paths-'))) // long form: git writes it into a worktree's .git file (8.3 temp dirs on CI)
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
  }, 30_000) // three real git spawns: past 5 s on a loaded box
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

describe('realpath rooting', () => {
  it('keys a symlinked or junctioned project dir like its target, and keeps a plain path unchanged', () => {
    const repo = path.join(root, 'real-repo')
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
    run(repo, 'init', '-q')
    const link = path.join(root, 'link-repo')
    // a junction needs no privilege on Windows; on POSIX it is an ordinary symlink
    fs.symlinkSync(repo, link, 'junction')
    const want = repo.replace(/\\/g, '/')
    expect(claudeProjectKey(link)).toBe(want)
    expect(claudeProjectKey(path.join(link, 'sub'))).toBe(want)
    // spelling (drive-letter case) of an ordinary path is untouched
    expect(claudeProjectKey(repo)).toBe(want)
    expect(claudeProjectKey(repo).startsWith(repo.slice(0, 2).replace(/\\/g, '/'))).toBe(true)
  }, 30_000) // a real git spawn
})

describe('project location (cli.js kt port, fabricated layouts)', () => {
  const mk = (p: string, file?: string, body = ''): string => {
    if (file === undefined) fs.mkdirSync(p, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(path.join(p, file)), { recursive: true })
      fs.writeFileSync(path.join(p, file), body)
    }
    return p
  }
  /** A linked worktree `wt` of `common` (the common dir), laid out the way a worktree add does. */
  const linkedWorktree = (
    common: string,
    wt: string,
    o: { commondir?: string | null; back?: string | null; name?: string } = {}
  ): string => {
    const name = o.name ?? 'wt1'
    const gitdir = path.join(common, 'worktrees', name)
    mk(gitdir)
    if (o.commondir !== null) {
      fs.writeFileSync(path.join(gitdir, 'commondir'), o.commondir ?? '../..\n')
    }
    if (o.back !== null) {
      fs.writeFileSync(path.join(gitdir, 'gitdir'), `${o.back ?? path.join(wt, '.git')}\n`)
    }
    mk(wt, '.git', `gitdir: ${gitdir}\n`)
    return wt
  }

  it('plain repo and subdir resolve to the repo root; outside a repo is the cwd', () => {
    const repo = mk(path.join(root, 'repo'))
    mk(repo, '.git/HEAD')
    const sub = mk(path.join(repo, 'a', 'b'))
    expect(claudeProjectLocation(repo)).toEqual({ root: repo, worktree: false })
    expect(claudeProjectLocation(sub)).toEqual({ root: repo, worktree: false })
    const plain = mk(path.join(root, 'plain'))
    expect(claudeProjectLocation(plain)).toEqual({ root: plain, worktree: false })
  })

  it('a linked worktree resolves to its main checkout, flagged worktree', () => {
    const main = mk(path.join(root, 'main'))
    mk(main, '.git/HEAD')
    const wt = linkedWorktree(path.join(main, '.git'), path.join(root, 'wt'))
    const sub = mk(path.join(wt, 'src'))
    expect(claudeProjectLocation(wt)).toEqual({ root: main, worktree: true })
    expect(claudeProjectLocation(sub)).toEqual({ root: main, worktree: true })
  })

  it.each([
    ['a back-pointer naming another checkout', { back: '/elsewhere/.git' }],
    ['a missing back-pointer', { back: null }],
    ['a missing commondir', { commondir: null }],
    ['a gitdir that is not under <common>/worktrees', { commondir: '..' }]
  ])('a malformed worktree (%s) keeps the worktree own root', (_n, o) => {
    const main = mk(path.join(root, 'main'))
    mk(main, '.git/HEAD')
    const wt = linkedWorktree(path.join(main, '.git'), path.join(root, 'wt'), o)
    expect(claudeProjectLocation(wt)).toEqual({ root: wt, worktree: false })
  })

  it('a bare-common worktree resolves to the common dir; a common dir that holds .git does not', () => {
    const bare = mk(path.join(root, 'bare.git'))
    mk(bare, 'HEAD')
    const wt = linkedWorktree(bare, path.join(root, 'wt'))
    expect(claudeProjectLocation(wt)).toEqual({ root: bare, worktree: true })

    const odd = mk(path.join(root, 'odd'))
    mk(odd, '.git/HEAD')
    const wt2 = linkedWorktree(odd, path.join(root, 'wt2'))
    expect(claudeProjectLocation(wt2)).toEqual({ root: wt2, worktree: false })
  })

  it('a .git file without a commondir (a submodule) keeps its own directory', () => {
    const sm = mk(path.join(root, 'sm'), '.git', 'gitdir: ../outer/.git/modules/sm\n')
    expect(claudeProjectLocation(sm)).toEqual({ root: sm, worktree: false })
  })

  it('a symlinked commondir or gitdir back-pointer file bails', () => {
    if (process.platform === 'win32') return
    for (const name of ['commondir', 'gitdir']) {
      const main = mk(path.join(root, `main-${name}`))
      mk(main, '.git/HEAD')
      const wt = linkedWorktree(path.join(main, '.git'), path.join(root, `wt-${name}`))
      const file = path.join(main, '.git', 'worktrees', 'wt1', name)
      const real = path.join(root, `real-${name}`)
      fs.renameSync(file, real)
      fs.symlinkSync(real, file)
      expect(claudeProjectLocation(wt)).toEqual({ root: wt, worktree: false })
    }
  })

  it('a .git file whose gitdir: line is not first bails', () => {
    const main = mk(path.join(root, 'main'))
    mk(main, '.git/HEAD')
    const wt = linkedWorktree(path.join(main, '.git'), path.join(root, 'wt'))
    const gitdir = path.join(main, '.git', 'worktrees', 'wt1')
    fs.writeFileSync(path.join(wt, '.git'), `# note\ngitdir: ${gitdir}\n`)
    expect(claudeProjectLocation(wt)).toEqual({ root: wt, worktree: false })
  })

  it.skipIf(process.platform === 'win32')(
    'a worktree directory whose own name holds a backslash bails on POSIX',
    () => {
      const main = mk(path.join(root, 'main'))
      mk(main, '.git/HEAD')
      const wt = linkedWorktree(path.join(main, '.git'), path.join(root, 'w\\t'))
      expect(claudeProjectLocation(wt)).toEqual({ root: wt, worktree: false })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'a mis-cased cwd yields the on-disk spelling (realpath.native)',
    () => {
      const dir = mk(path.join(root, 'proj'))
      const wrong = path.join(root, 'PROJ')
      if (!fs.existsSync(wrong)) return // case-sensitive volume: nothing to pin
      expect(claudeProjectLocation(wrong).root).toBe(dir)
    }
  )

  it('keys are NFC, and the key spells backslashes as slashes', () => {
    const decomposed = path.join(root, 'cafe\u0301')
    mk(decomposed)
    expect(claudeProjectLocation(decomposed).root.endsWith('caf\u00e9')).toBe(true)
    expect(claudeProjectKey(decomposed)).toBe(
      claudeProjectLocation(decomposed).root.replace(/\\/g, '/')
    )
    expect(claudeProjectKey('C:\\proj\\x')).not.toContain('\\')
  })
})
