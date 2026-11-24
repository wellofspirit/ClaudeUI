/**
 * @vitest-environment node
 *
 * The update host's boot sweep: what goes (through the real gates) and what is
 * kept, in a temp folder laid out for the host's platform.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { INSTALL_MARKER_PRODUCT } from '../../../../shared/install-marker'
import { DEFAULT_TIMEOUTS, writeJobFiles, type RelaunchJob } from '../../relaunch/job'
import { installKeyFor, jobFiles } from '../../relaunch/paths'
import { takeLock } from '../../relaunch/lock'
import { LEFTOVER_KEEP_MS, bootCleanup, type BootCleanupArgs } from '../boot-cleanup'
import { openExtractContainer } from '../extract-container'

const HOST: 'darwin' | 'win32' = process.platform === 'win32' ? 'win32' : 'darwin'
const DAY = 24 * 60 * 60_000

let root: string
let parent: string
let install: string
let base: string
let state: string
let downloads: string
const NOW = Date.now()

/** A marked build at `dir` (macOS bundle or Windows folder layout). */
function build(dir: string, withMarker = true): string {
  const res =
    HOST === 'darwin' ? path.join(dir, 'Contents', 'Resources') : path.join(dir, 'resources')
  fs.mkdirSync(res, { recursive: true })
  fs.writeFileSync(path.join(res, 'keep.txt'), 'x')
  if (withMarker)
    fs.writeFileSync(
      path.join(res, 'claudeui-install.json'),
      JSON.stringify({
        schema: 1,
        product: INSTALL_MARKER_PRODUCT,
        kind: 'desktop',
        entries: HOST === 'darwin' ? [] : ['resources'],
        version: '1.0.0'
      })
    )
  return dir
}
const sib = (name: string): string => path.join(parent, `.${base}.${name}`)

function job(
  token: string,
  status: string | null,
  at: number,
  paths: { backup?: string; failed?: string }
): void {
  const j: RelaunchJob = {
    schema: 1,
    token,
    pid: 1,
    platform: HOST,
    mode: 'swap',
    installPath: install,
    installKey: installKeyFor(install, HOST),
    stateDir: state,
    stagedPath: '',
    backupPath: paths.backup ?? '',
    failedPath: paths.failed ?? '',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    startedAt: at - 1000,
    launch: [],
    timeouts: DEFAULT_TIMEOUTS
  }
  writeJobFiles(jobFiles(state, token), j)
  if (status)
    fs.writeFileSync(
      jobFiles(state, token).result,
      JSON.stringify({
        token,
        status,
        mode: 'swap',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        at
      })
    )
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-cleanup-')))
  parent = path.join(root, 'Apps')
  base = HOST === 'darwin' ? 'ClaudeUI.app' : 'ClaudeUI'
  install = build(path.join(parent, base))
  state = path.join(root, 'relaunch')
  fs.mkdirSync(state)
  downloads = path.join(root, 'updates', 'desktop')
  fs.mkdirSync(downloads, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const args = (over: Partial<BootCleanupArgs> = {}): BootCleanupArgs => ({
  platform: HOST,
  installPath: install,
  installKey: installKeyFor(install, HOST),
  stateDir: state,
  downloadsDir: downloads,
  stagedId: null,
  spared: () => false,
  now: NOW,
  ...over
})

describe('bootCleanup', () => {
  it('removes staging leftovers, keeping the staged one the state file names and any this process made', () => {
    const named = build(sib('update-2.0.0-aaaaaaaa'))
    const stale = build(sib('update-2.1.0-bbbbbbbb'))
    const mine = build(sib('update-2.2.0-cccccccc'))
    const extract = sib('extract-2.0.0-dddddddd')
    build(path.join(extract, 'ClaudeUI.app'))
    const unmarked = build(sib('update-2.3.0-eeeeeeee'), false)
    const otherBase = build(path.join(parent, '.Other.app.update-2.0.0-aaaaaaaa'))
    const out = bootCleanup(args({ stagedId: path.basename(named), spared: (d) => d === mine }))
    expect(fs.existsSync(named)).toBe(true)
    expect(fs.existsSync(mine)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(unmarked)).toBe(true)
    expect(fs.existsSync(otherBase)).toBe(true)
    expect(fs.existsSync(install)).toBe(true)
    if (HOST === 'darwin') expect(fs.existsSync(extract)).toBe(false)
    expect(out.removed).toContain(stale)
    expect(out.kept.map((k) => k.path)).toContain(unmarked)
  })

  it("removes failed builds and failed swaps' backups once a week old; keeps younger ones", () => {
    const oldFailed = build(sib('failed-2.0.0-11111111'))
    const newFailed = build(sib('failed-2.1.0-22222222'))
    const oldBackup = build(sib('old-1.0.0-33333333'))
    const newBackup = build(sib('old-1.0.0-44444444'))
    const updatedBackup = build(sib('old-1.0.0-55555555'))
    job('11111111'.repeat(4), 'rolled-back', NOW - 8 * DAY, { failed: oldFailed })
    job('22222222'.repeat(4), 'rolled-back', NOW - DAY, { failed: newFailed })
    job('33333333'.repeat(4), 'failed', NOW - 8 * DAY, { backup: oldBackup })
    job('44444444'.repeat(4), 'failed', NOW - DAY, { backup: newBackup })
    job('55555555'.repeat(4), 'updated', NOW - 30 * DAY, { backup: updatedBackup })
    bootCleanup(args())
    expect(fs.existsSync(oldFailed)).toBe(false)
    expect(fs.existsSync(newFailed)).toBe(true)
    expect(fs.existsSync(oldBackup)).toBe(false)
    expect(fs.existsSync(newBackup)).toBe(true)
    // An updated job's backup is the relaunch reconciliation's, not this sweep's.
    expect(fs.existsSync(updatedBackup)).toBe(true)
    expect(fs.existsSync(install)).toBe(true)
  })

  it('a failed build with no job left is judged by its own age', () => {
    const orphan = build(sib('failed-2.0.0-66666666'))
    bootCleanup(args())
    expect(fs.existsSync(orphan)).toBe(true)
    bootCleanup(args({ now: Date.now() + LEFTOVER_KEEP_MS + DAY }))
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('never removes what a live relaunch names', () => {
    const staged = build(sib('update-2.0.0-77777777'))
    const token = '77777777'.repeat(4)
    writeJobFiles(jobFiles(state, token), {
      schema: 1,
      token,
      pid: 1,
      platform: HOST,
      mode: 'swap',
      installPath: install,
      installKey: installKeyFor(install, HOST),
      stateDir: state,
      stagedPath: staged,
      backupPath: sib('old-1.0.0-77777777'),
      failedPath: sib('failed-2.0.0-77777777'),
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      startedAt: NOW,
      launch: [],
      timeouts: DEFAULT_TIMEOUTS
    })
    takeLock(state, { token, pid: 1, at: Date.now() })
    bootCleanup(args({ now: Date.now() }))
    expect(fs.existsSync(staged)).toBe(true)
  })

  it('in the downloads dir: rebuild output always, rebuild logs once a week old, nothing else', () => {
    const out = path.join(downloads, 'rebuild-0123abcd')
    fs.mkdirSync(path.join(out, 'mac-arm64'), { recursive: true })
    const log = path.join(downloads, 'rebuild-0123abcd.log')
    fs.writeFileSync(log, 'x')
    const mineOut = path.join(downloads, 'rebuild-89abcdef')
    fs.mkdirSync(mineOut)
    const release = path.join(downloads, '2.0.0')
    fs.mkdirSync(release)
    fs.writeFileSync(path.join(release, 'ClaudeUI-2.0.0-mac-arm64.zip'), 'zip')
    bootCleanup(args({ spared: (d) => d === mineOut }))
    expect(fs.existsSync(out)).toBe(false)
    expect(fs.existsSync(log)).toBe(true)
    expect(fs.existsSync(mineOut)).toBe(true)
    expect(fs.existsSync(path.join(release, 'ClaudeUI-2.0.0-mac-arm64.zip'))).toBe(true)
    bootCleanup(args({ now: Date.now() + LEFTOVER_KEEP_MS + DAY, spared: (d) => d === mineOut }))
    expect(fs.existsSync(log)).toBe(false)
    expect(fs.existsSync(mineOut)).toBe(true)
  })

  it('sweeps an interrupted extract or copy: no marker landed, its staging record proves it ours', () => {
    const interrupted = openExtractContainer({
      installPath: install,
      version: '2.0.0',
      token: '99999999'.repeat(4),
      platform: HOST,
      now: NOW
    })
    fs.mkdirSync(path.join(interrupted.inner, 'half-written'), { recursive: true })
    fs.writeFileSync(path.join(interrupted.inner, 'half-written', 'f'), 'x')
    const emptyStart = openExtractContainer({
      installPath: install,
      version: '2.1.0',
      token: '88888888'.repeat(4),
      platform: HOST,
      now: NOW
    })
    // A container with neither a record nor a marked app cannot be proven ours: kept.
    const foreign = sib('extract-2.2.0-77777777')
    fs.mkdirSync(path.join(foreign, 'app'), { recursive: true })
    const out = bootCleanup(args())
    expect(fs.existsSync(interrupted.dir)).toBe(false)
    expect(fs.existsSync(emptyStart.dir)).toBe(false)
    expect(fs.existsSync(foreign)).toBe(true)
    expect(out.removed).toEqual(expect.arrayContaining([interrupted.dir, emptyStart.dir]))
    expect(fs.existsSync(install)).toBe(true)
  })

  it('spares a container this process is still filling', () => {
    const c = openExtractContainer({
      installPath: install,
      version: '2.0.0',
      token: '99999999'.repeat(4),
      platform: HOST,
      now: NOW
    })
    bootCleanup(args({ spared: (d) => d === c.dir }))
    expect(fs.existsSync(c.dir)).toBe(true)
  })

  it('a gate that refuses or throws does not stop the sweep', () => {
    const a = build(sib('update-2.0.0-aaaaaaaa'))
    const b = build(sib('update-2.1.0-bbbbbbbb'))
    const remove = vi.fn((_install: string, candidate: string) => {
      if (candidate === a) throw new Error('boom')
      return { removed: false as const, reason: 'refused' }
    })
    const out = bootCleanup(args({ remove }))
    expect(remove).toHaveBeenCalledTimes(2)
    expect(out.kept.map((k) => k.path).sort()).toEqual([a, b].sort())
  })
})
