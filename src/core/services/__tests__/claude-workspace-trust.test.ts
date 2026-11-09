/**
 * @vitest-environment node
 *
 * Workspace trust (`projects[K].hasTrustDialogAccepted`) read, write and the
 * cli.js-compatible config lock. Everything runs in a temp tree: HOME and
 * CLAUDE_CONFIG_DIR point at fixtures, the real ~/.claude.json is never read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// statSync / rmdirSync are wrapped so the lock races (holder vanishes between mkdir and stat,
// a second stale lock appears after a takeover) can be staged; by default they are the real ones.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    default: actual,
    statSync: vi.fn(actual.statSync),
    rmdirSync: vi.fn(actual.rmdirSync)
  }
})

import {
  getWorkspaceTrust,
  setWorkspaceTrust,
  withClaudeConfigLock
} from '../claude-workspace-trust'

let tmp: string
let home: string
let cfgDir: string
let cfg: string
let env: Record<string, string>
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

const mkdirs = (p: string): string => {
  fs.mkdirSync(p, { recursive: true })
  return p
}
const writeCfg = (data: unknown): void =>
  fs.writeFileSync(cfg, typeof data === 'string' ? data : JSON.stringify(data))
const readCfg = (): any => JSON.parse(fs.readFileSync(cfg, 'utf-8'))

/** A plain repo (a `.git` dir) under tmp. */
function repo(name: string): string {
  const r = mkdirs(path.join(tmp, name))
  mkdirs(path.join(r, '.git'))
  return r
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-trust-')))
  home = mkdirs(path.join(tmp, 'home'))
  cfgDir = mkdirs(path.join(tmp, 'cfg'))
  cfg = path.join(cfgDir, '.claude.json')
  env = { CLAUDE_CONFIG_DIR: cfgDir }
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  vi.mocked(fs.statSync).mockReset()
  vi.mocked(fs.rmdirSync).mockReset()
  for (const [k, v] of Object.entries(savedHome)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getWorkspaceTrust', () => {
  it('reads exactly the project key: the repo root, from a subdir too', () => {
    const r = repo('proj')
    const sub = mkdirs(path.join(r, 'a', 'b'))
    writeCfg({ projects: { [r]: { hasTrustDialogAccepted: true } } })
    expect(getWorkspaceTrust(r, env)).toEqual({ root: r, worktree: false, trusted: true })
    expect(getWorkspaceTrust(sub, env)).toEqual({ root: r, worktree: false, trusted: true })
  })

  it('does not accept a parent or child spelling, an explicit false, or a missing/corrupt config', () => {
    const r = repo('proj')
    const sub = mkdirs(path.join(r, 'sub'))
    writeCfg({
      projects: { [tmp]: { hasTrustDialogAccepted: true }, [sub]: { hasTrustDialogAccepted: true } }
    })
    expect(getWorkspaceTrust(r, env)?.trusted).toBe(false)
    writeCfg({ projects: { [r]: { hasTrustDialogAccepted: false } } })
    expect(getWorkspaceTrust(r, env)?.trusted).toBe(false)
    writeCfg('{ not json')
    expect(getWorkspaceTrust(r, env)?.trusted).toBe(false)
    fs.rmSync(cfg)
    expect(getWorkspaceTrust(r, env)?.trusted).toBe(false)
  })

  it('a linked worktree reports the main checkout as root and the checkout trust', () => {
    const main = repo('main')
    const gitdir = mkdirs(path.join(main, '.git', 'worktrees', 'w'))
    const wt = mkdirs(path.join(tmp, 'wt'))
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n')
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`)
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`)
    writeCfg({ projects: { [main]: { hasTrustDialogAccepted: true } } })
    expect(getWorkspaceTrust(wt, env)).toEqual({ root: main, worktree: true, trusted: true })
  })

  it('is null for no cwd, the home directory (even via a symlink) and a filesystem root', () => {
    expect(getWorkspaceTrust('', env)).toBeNull()
    expect(getWorkspaceTrust(path.parse(tmp).root, env)).toBeNull()
    expect(getWorkspaceTrust(home, env)).toBeNull()
    const link = path.join(tmp, 'home-link')
    fs.symlinkSync(home, link)
    expect(getWorkspaceTrust(link, env)).toBeNull()
    // a plain (non-git) folder under home is fine: only home itself is excluded
    expect(getWorkspaceTrust(mkdirs(path.join(home, 'work')), env)).not.toBeNull()
  })

  it('home that is itself a repo: its subfolder keys on home, home itself stays null', () => {
    mkdirs(path.join(home, '.git'))
    const sub = mkdirs(path.join(home, 'work', 'app'))
    writeCfg({ projects: { [home]: { hasTrustDialogAccepted: true } } })
    expect(getWorkspaceTrust(home, env)).toBeNull()
    expect(getWorkspaceTrust(sub, env)).toEqual({ root: home, worktree: false, trusted: true })
  })
})

describe('setWorkspaceTrust', () => {
  const FAST = { pollMinMs: 5, pollMaxMs: 10 }

  it('sets only projects[K].hasTrustDialogAccepted and keeps every other field and project', async () => {
    const r = repo('proj')
    const other = repo('other')
    const before = {
      numStartups: 7,
      oauthAccount: { emailAddress: 'x' },
      projects: {
        [r]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false, mcpServers: { a: {} } },
        [other]: { hasTrustDialogAccepted: true }
      }
    }
    writeCfg(before)
    const state = await setWorkspaceTrust(r, true, { env, ...FAST })
    expect(state).toEqual({ root: r, worktree: false, trusted: true })
    const after = readCfg()
    expect(after.projects[r]).toEqual({ ...before.projects[r], hasTrustDialogAccepted: true })
    expect({ ...after, projects: { ...after.projects, [r]: undefined } }).toEqual({
      ...before,
      projects: { ...before.projects, [r]: undefined }
    })
    expect(fs.readFileSync(cfg, 'utf-8').endsWith('\n')).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(cfg).mode & 0o777).toBe(0o600)
  })

  it('untrust writes false and keeps the entry; a missing config is created', async () => {
    const r = repo('proj')
    expect(fs.existsSync(cfg)).toBe(false)
    await setWorkspaceTrust(r, true, { env, ...FAST })
    expect(readCfg()).toEqual({ projects: { [r]: { hasTrustDialogAccepted: true } } })
    const state = await setWorkspaceTrust(r, false, { env, ...FAST })
    expect(state.trusted).toBe(false)
    expect(readCfg().projects[r]).toEqual({ hasTrustDialogAccepted: false })
  })

  it('records a worktree cwd on the main checkout', async () => {
    const main = repo('main')
    const gitdir = mkdirs(path.join(main, '.git', 'worktrees', 'w'))
    const wt = mkdirs(path.join(tmp, 'wt'))
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n')
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`)
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`)
    const state = await setWorkspaceTrust(wt, true, { env, ...FAST })
    expect(state).toEqual({ root: main, worktree: true, trusted: true })
    expect(Object.keys(readCfg().projects)).toEqual([main])
  })

  it('skips the write when the value is already set', async () => {
    const r = repo('proj')
    writeCfg({ projects: { [r]: { hasTrustDialogAccepted: true } } })
    const old = new Date(2020, 0, 1)
    fs.utimesSync(cfg, old, old)
    const raw = fs.readFileSync(cfg, 'utf-8')
    await setWorkspaceTrust(r, true, { env, ...FAST })
    expect(fs.statSync(cfg).mtimeMs).toBe(old.getTime())
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(raw)
  })

  it('writes through a symlinked config and keeps the link', async () => {
    if (process.platform === 'win32') return
    const r = repo('proj')
    const real = path.join(tmp, 'dotfiles-claude.json')
    fs.writeFileSync(real, JSON.stringify({ keep: 1 }))
    fs.symlinkSync(real, cfg)
    await setWorkspaceTrust(r, true, { env, ...FAST })
    expect(fs.lstatSync(cfg).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(real, 'utf-8'))).toEqual({
      keep: 1,
      projects: { [r]: { hasTrustDialogAccepted: true } }
    })
  })

  it('throws on a corrupt config and leaves it unchanged', async () => {
    const r = repo('proj')
    writeCfg('{ truncated')
    await expect(setWorkspaceTrust(r, true, { env, ...FAST })).rejects.toThrow(/unreadable/)
    expect(fs.readFileSync(cfg, 'utf-8')).toBe('{ truncated')
    expect(fs.existsSync(`${cfg}.lock`)).toBe(false)
  })

  it('refuses the home directory (and writes nothing), a filesystem root and an empty cwd', async () => {
    for (const bad of [home, path.parse(tmp).root, '']) {
      await expect(setWorkspaceTrust(bad, true, { env, ...FAST })).rejects.toThrow(
        /cannot be recorded/
      )
    }
    expect(fs.existsSync(cfg)).toBe(false)
  })

  it('refuses a non-boolean trust value (remote callers are unvalidated)', async () => {
    const r = repo('proj')
    for (const bad of ['true', 1, null] as unknown[]) {
      await expect(setWorkspaceTrust(r, bad as boolean, { env, ...FAST })).rejects.toThrow(
        /boolean/
      )
    }
    expect(fs.existsSync(cfg)).toBe(false)
  })

  it('home that is itself a repo: a subfolder records projects[<home>]', async () => {
    mkdirs(path.join(home, '.git'))
    const sub = mkdirs(path.join(home, 'work'))
    const state = await setWorkspaceTrust(sub, true, { env, ...FAST })
    expect(state).toEqual({ root: home, worktree: false, trusted: true })
    expect(readCfg().projects[home]).toEqual({ hasTrustDialogAccepted: true })
    await expect(setWorkspaceTrust(home, true, { env, ...FAST })).rejects.toThrow(
      /cannot be recorded/
    )
  })

  it('honours CLAUDE_CONFIG_DIR: the file next to settings, not ~/.claude.json', async () => {
    const r = repo('proj')
    await setWorkspaceTrust(r, true, { env, ...FAST })
    expect(fs.existsSync(cfg)).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
  })
})

describe('withClaudeConfigLock', () => {
  const lockDir = (): string => `${cfg}.lock`
  const T = { pollMinMs: 5, pollMaxMs: 10 }

  it('waits for a fresh holder, then runs and releases', async () => {
    fs.mkdirSync(lockDir())
    let ran = false
    const p = withClaudeConfigLock(
      () => {
        ran = true
        expect(fs.existsSync(lockDir())).toBe(true)
        return 42
      },
      { env, ...T }
    )
    await new Promise((r) => setTimeout(r, 60))
    expect(ran).toBe(false)
    fs.rmdirSync(lockDir())
    await expect(p).resolves.toBe(42)
    expect(fs.existsSync(lockDir())).toBe(false)
  })

  it('takes over a stale lock', async () => {
    fs.mkdirSync(lockDir())
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockDir(), old, old)
    await expect(withClaudeConfigLock(() => 'ok', { env, ...T })).resolves.toBe('ok')
    expect(fs.existsSync(lockDir())).toBe(false)
  })

  it('takes over only once per acquisition: a lock that is stale again is waited on', async () => {
    fs.mkdirSync(lockDir())
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockDir(), old, old)
    let takeovers = 0
    const realRmdir = vi.mocked(fs.rmdirSync).getMockImplementation()!
    vi.mocked(fs.rmdirSync).mockImplementation(((p: fs.PathLike, o?: fs.RmDirOptions) => {
      realRmdir(p, o)
      if (String(p) === lockDir() && ++takeovers === 1) {
        // another process grabs the lock the instant we remove the stale one, and it is stale too
        fs.mkdirSync(lockDir())
        fs.utimesSync(lockDir(), old, old)
      }
    }) as typeof fs.rmdirSync)
    await expect(withClaudeConfigLock(() => 'never', { env, ...T, timeoutMs: 80 })).rejects.toThrow(
      'the file stayed locked by another Claude Code process'
    )
    expect(takeovers).toBe(1)
  })

  it('retries at once when the holder releases between our mkdir and stat (ENOENT)', async () => {
    fs.mkdirSync(lockDir())
    const realStat = vi.mocked(fs.statSync).getMockImplementation()!
    vi.mocked(fs.statSync).mockImplementation(((p: fs.PathLike, o?: any) => {
      if (String(p) === lockDir()) {
        fs.rmdirSync(lockDir())
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }
      return realStat(p, o)
    }) as typeof fs.statSync)
    // a 1 s poll would blow the 200 ms budget: only the immediate retry passes
    await expect(
      withClaudeConfigLock(() => 'ok', { env, pollMinMs: 1000, pollMaxMs: 1000, timeoutMs: 200 })
    ).resolves.toBe('ok')
  })

  it('times out with the locked error, and leaves the other holder lock alone', async () => {
    fs.mkdirSync(lockDir())
    await expect(withClaudeConfigLock(() => 1, { env, ...T, timeoutMs: 60 })).rejects.toThrow(
      'the file stayed locked by another Claude Code process'
    )
    expect(fs.existsSync(lockDir())).toBe(true)
  })

  it('releases when fn throws', async () => {
    await expect(
      withClaudeConfigLock(
        () => {
          throw new Error('boom')
        },
        { env, ...T }
      )
    ).rejects.toThrow('boom')
    expect(fs.existsSync(lockDir())).toBe(false)
  })

  it('a write waits for a fresh lock holder and lands once it is released', async () => {
    const r = repo('proj')
    fs.mkdirSync(lockDir())
    const p = setWorkspaceTrust(r, true, { env, ...T })
    await new Promise((res) => setTimeout(res, 40))
    expect(fs.existsSync(cfg)).toBe(false)
    fs.rmdirSync(lockDir())
    await expect(p).resolves.toMatchObject({ trusted: true })
    expect(readCfg().projects[r]).toEqual({ hasTrustDialogAccepted: true })
  })
})
