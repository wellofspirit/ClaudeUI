/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { checkEligibility, unexpectedFilesReason, type EligibilityProbes } from '../eligibility'
import { removeOwnedDir } from '../delete-gate'
import { isLockStale, LOCK_STALE_MS, readLock, releaseLock, takeLock } from '../lock'
import { DEFAULT_TIMEOUTS, writeJobFiles, type RelaunchJob } from '../job'
import { jobFiles } from '../paths'

const marker = (entries: string[] = []): string =>
  JSON.stringify({ schema: 1, product: 'com.claudeui.app', kind: 'desktop', entries })

describe('checkEligibility', () => {
  const macExec = '/Applications/ClaudeUI.app/Contents/MacOS/ClaudeUI'
  const winExec = 'C:\\Tools\\ClaudeUI\\ClaudeUI.exe'
  const probes = (over: Partial<EligibilityProbes> = {}): EligibilityProbes => ({
    canWriteDir: () => true,
    readFile: () => marker(['ClaudeUI.exe', 'resources']),
    readdir: () => ['ClaudeUI.exe', 'resources'],
    ...over
  })

  it('accepts a packaged, marked, writable install', () => {
    const r = checkEligibility({
      packaged: true,
      platform: 'darwin',
      execPath: macExec,
      probes: probes()
    })
    expect(r).toMatchObject({ ok: true, installPath: '/Applications/ClaudeUI.app' })
    expect(
      checkEligibility({ packaged: true, platform: 'win32', execPath: winExec, probes: probes() })
        .ok
    ).toBe(true)
  })

  it.each([
    ['not packaged', { packaged: false }, /packaged/],
    ['linux', { platform: 'linux' }, /not supported/],
    ['not a bundle', { execPath: '/usr/bin/ClaudeUI' }, /\.app/],
    [
      'translocated',
      {
        execPath:
          '/private/var/folders/x/AppTranslocation/ABC/d/ClaudeUI.app/Contents/MacOS/ClaudeUI'
      },
      /App Translocation/
    ],
    ['parent not writable', { probes: probes({ canWriteDir: () => false }) }, /not writable/],
    [
      'no marker',
      {
        probes: probes({
          readFile: () => {
            throw new Error('ENOENT')
          }
        })
      },
      /no install marker/
    ],
    [
      'a foreign marker',
      {
        probes: probes({
          readFile: () => JSON.stringify({ schema: 1, product: 'x', kind: 'desktop', entries: [] })
        })
      },
      /no install marker/
    ]
  ])('refuses: %s', (_name, over, reason) => {
    const r = checkEligibility({
      packaged: true,
      platform: 'darwin',
      execPath: macExec,
      probes: probes(),
      ...(over as object)
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(reason)
  })

  it('Windows: names the files the marker does not list', () => {
    const r = checkEligibility({
      packaged: true,
      platform: 'win32',
      execPath: winExec,
      probes: probes({ readdir: () => ['ClaudeUI.exe', 'resources', 'notes.txt', 'Downloads.lnk'] })
    })
    expect(r).toEqual({
      ok: false,
      reason:
        'Unexpected files in the ClaudeUI folder: Downloads.lnk, notes.txt — move them out to enable updates'
    })
    expect(unexpectedFilesReason(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain('and 2 more')
  })
})

describe('lock', () => {
  let state: string
  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-lock-'))
  })
  afterEach(() => fs.rmSync(state, { recursive: true, force: true }))

  const token = 'abcdef0123456789abcdef0123456789'

  it('is exclusive and released', () => {
    expect(takeLock(state, { token, pid: 1, at: 1 })).toBe(true)
    expect(takeLock(state, { token, pid: 2, at: 2 })).toBe(false)
    expect(readLock(state)?.owner).toEqual({ token, pid: 1, at: 1 })
    releaseLock(state, 'f'.repeat(32)) // someone else's token: kept
    expect(readLock(state)).not.toBeNull()
    releaseLock(state, token)
    expect(readLock(state)).toBeNull()
  })

  it('is stale after 15 minutes, or once its token has a result', () => {
    const lock = { owner: { token, pid: 1, at: 1000 }, mtimeMs: 1000 }
    expect(isLockStale(lock, 1000 + LOCK_STALE_MS - 1, () => false)).toBe(false)
    expect(isLockStale(lock, 1000 + LOCK_STALE_MS + 1, () => false)).toBe(true)
    expect(isLockStale(lock, 1001, (t) => t === token)).toBe(true)
    expect(isLockStale({ owner: null, mtimeMs: 1000 }, 1001, () => true)).toBe(false)
  })
})

describe('removeOwnedDir (the deletion gate)', () => {
  let root: string
  let state: string
  let install: string
  const token = 'abcdef0123456789abcdef0123456789'
  const log = vi.fn()

  const makeOwned = (name: string, withMarker = true): string => {
    const dir = path.join(root, name)
    fs.mkdirSync(path.join(dir, 'Contents', 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Contents', 'Resources', 'keep.txt'), 'x')
    if (withMarker)
      fs.writeFileSync(path.join(dir, 'Contents', 'Resources', 'claudeui-install.json'), marker())
    return dir
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-gate-')))
    state = path.join(root, 'state')
    fs.mkdirSync(state)
    install = makeOwned('ClaudeUI.app')
    log.mockClear()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const opts = (extra: object = {}): Parameters<typeof removeOwnedDir>[2] => ({
    platform: 'darwin',
    stateDir: state,
    log,
    ...extra
  })

  it('removes an owned backup', () => {
    const backup = makeOwned('.ClaudeUI.app.old-1.0.0-abcdef01')
    expect(removeOwnedDir(install, backup, opts({ token }))).toEqual({ removed: true })
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.existsSync(install)).toBe(true)
  })

  const refusals: Array<[string, () => string, object, RegExp]> = [
    [
      'wrong parent',
      () => {
        fs.mkdirSync(path.join(root, 'sub'))
        return makeOwned('sub/.ClaudeUI.app.old-1.0.0-abcdef01')
      },
      {},
      /not a sibling/
    ],
    ['wrong pattern', () => makeOwned('Downloads'), {}, /name is not/],
    ['the install itself', () => install, {}, /name is not/],
    ['another base', () => makeOwned('.Other.app.old-1.0.0-abcdef01'), {}, /name is not/],
    [
      'wrong token',
      () => makeOwned('.ClaudeUI.app.old-1.0.0-abcdef01'),
      { token: '0123456789abcdef0123456789abcdef' },
      /token/
    ],
    [
      'a symlink',
      () => {
        const target = makeOwned('real-target')
        const link = path.join(root, '.ClaudeUI.app.old-1.0.0-abcdef01')
        fs.symlinkSync(target, link)
        return link
      },
      {},
      /not a real directory/
    ],
    ['no marker', () => makeOwned('.ClaudeUI.app.failed-2.0.0-abcdef01', false), {}, /marker/],
    ['missing', () => path.join(root, '.ClaudeUI.app.old-1.0.0-abcdef01'), {}, /does not exist/]
  ]

  it.each(refusals)('refuses: %s', (_name, make, extra, reason) => {
    const candidate = make()
    const r = removeOwnedDir(install, candidate, opts(extra))
    expect(r.removed).toBe(false)
    if (!r.removed) expect(r.reason).toMatch(reason)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deletion gate refused'))
    if (fs.existsSync(candidate)) expect(fs.lstatSync(candidate)).toBeTruthy()
    expect(fs.existsSync(install)).toBe(true)
    // A symlink's target is never touched.
    if (fs.existsSync(path.join(root, 'real-target')))
      expect(
        fs.existsSync(path.join(root, 'real-target', 'Contents', 'Resources', 'keep.txt'))
      ).toBe(true)
  })

  it('refuses while a live lock names it, and allows once the lock is stale', () => {
    const backup = makeOwned('.ClaudeUI.app.old-1.0.0-abcdef01')
    const job: RelaunchJob = {
      schema: 1,
      token,
      pid: 1,
      platform: 'darwin',
      mode: 'swap',
      installPath: install,
      installKey: '0123456789abcdef',
      stateDir: state,
      stagedPath: path.join(root, '.ClaudeUI.app.update-2.0.0-abcdef01'),
      backupPath: backup,
      failedPath: path.join(root, '.ClaudeUI.app.failed-2.0.0-abcdef01'),
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: Date.now(),
      launch: [],
      timeouts: DEFAULT_TIMEOUTS
    }
    writeJobFiles(jobFiles(state, token), job)
    takeLock(state, { token, pid: 1, at: Date.now() })
    const r = removeOwnedDir(install, backup, opts())
    expect(r).toEqual({ removed: false, reason: 'a relaunch in progress names it' })
    expect(fs.existsSync(backup)).toBe(true)
    // Once the job has a result the lock is stale and no longer protects it.
    fs.writeFileSync(jobFiles(state, token).result, '{}')
    expect(removeOwnedDir(install, backup, opts())).toEqual({ removed: true })
  })

  it('matches names case-insensitively on darwin (APFS), token included', () => {
    const backup = makeOwned('.claudeui.APP.OLD-1.0.0-ABCDEF01')
    expect(removeOwnedDir(install, backup, opts({ token }))).toEqual({ removed: true })
    expect(fs.existsSync(backup)).toBe(false)
  })

  it('never throws: a delete that fails part-way is reported as a refusal', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const backup = makeOwned('.ClaudeUI.app.old-1.0.0-abcdef01')
    const locked = path.join(backup, 'Contents', 'Resources')
    fs.chmodSync(locked, 0o500) // its files cannot be unlinked
    try {
      let r: ReturnType<typeof removeOwnedDir> | undefined
      expect(() => {
        r = removeOwnedDir(install, backup, opts({ token }))
      }).not.toThrow()
      expect(r?.removed).toBe(false)
      if (r && !r.removed) expect(r.reason).toMatch(/the delete failed/)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('the delete failed'))
    } finally {
      fs.chmodSync(locked, 0o700)
    }
  })

  it('a live lock whose job cannot be read protects everything', () => {
    const backup = makeOwned('.ClaudeUI.app.old-1.0.0-abcdef01')
    takeLock(state, { token, pid: 1, at: Date.now() })
    expect(removeOwnedDir(install, backup, opts()).removed).toBe(false)
  })
})
