/**
 * @vitest-environment node
 *
 * Retention for the managed store (ADR-082 §4): what the seven-day GC keeps,
 * what it removes, and that a version in use is skipped and retried. A temp
 * store (`CLAUDEUI_HARNESS_STORE`) holds fabricated installs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HarnessId, HarnessSelection } from '../../../../shared/harness-types'
import { fakeHarnessInstall } from '../../../../test/helpers/fake-harness'
import { harnessManifest } from '../../manifests'
import { HARNESS_STORE_ENV, LAST_USED_FILE } from '../../store'
import { RETENTION_MS, collectHarnessGarbage } from '../gc'
import { STAGING_DIR, STALE_AFTER_MS, TRASH_DIR } from '../store-writer'

const NOW = Date.parse('2026-10-01T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const TESTED = harnessManifest('opencode').tested

let tmp: string
let store: string
let saved: string | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gc-'))
  store = path.join(tmp, 'store')
  saved = process.env[HARNESS_STORE_ENV]
  process.env[HARNESS_STORE_ENV] = store
})

afterEach(() => {
  if (saved === undefined) delete process.env[HARNESS_STORE_ENV]
  else process.env[HARNESS_STORE_ENV] = saved
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** An install whose `installedAt` is `ageDays` old, optionally used `usedDaysAgo` ago. */
function install(id: HarnessId, version: string, ageDays: number, usedDaysAgo?: number): string {
  const dir = fakeHarnessInstall(store, id, version, {
    record: { installedAt: new Date(NOW - ageDays * DAY).toISOString() }
  })
  if (usedDaysAgo !== undefined) {
    const file = path.join(dir, LAST_USED_FILE)
    fs.writeFileSync(file, '')
    const at = new Date(NOW - usedDaysAgo * DAY)
    fs.utimesSync(file, at, at)
  }
  return dir
}

function gc(
  selection: (id: HarnessId) => HarnessSelection = () => ({ source: 'managed', version: 'tested' }),
  remove?: (dir: string, label: string) => Promise<void>,
  resolved: (id: HarnessId) => { source: 'bundled' | 'managed'; version: string | null } = () => ({
    source: 'bundled',
    version: null
  })
) {
  return collectHarnessGarbage({
    now: () => NOW,
    selection,
    resolved,
    ...(remove ? { remove } : {})
  })
}

describe('collectHarnessGarbage', () => {
  it('keeps the tested version however old, and removes an unused old one', async () => {
    const tested = install('opencode', TESTED, 30)
    const old = install('opencode', '1.18.40', 30)
    const result = await gc()
    expect(fs.existsSync(tested)).toBe(true)
    expect(fs.existsSync(old)).toBe(false)
    expect(result).toMatchObject({ removed: ['opencode 1.18.40'], kept: 1, skipped: [] })
    // Removed by way of .trash, which is left empty.
    expect(fs.readdirSync(path.join(store, TRASH_DIR))).toEqual([])
  })

  it('invalidates each harness that lost a version, once, and no other', async () => {
    install('opencode', '1.18.40', 30)
    install('opencode', '1.18.41', 30)
    install('pi', harnessManifest('pi').tested, 30)
    const invalidated: HarnessId[] = []
    await collectHarnessGarbage({
      now: () => NOW,
      selection: () => ({ source: 'managed', version: 'tested' }),
      resolved: () => ({ source: 'bundled', version: null }),
      invalidate: (id) => invalidated.push(id)
    })
    // opencode lost two versions (one `harness:changed`); pi kept its tested one.
    expect(invalidated).toEqual(['opencode'])
  })

  it('keeps the version the selection names, even while the source is System', async () => {
    const exact = install('opencode', '1.18.40', 30)
    await gc(() => ({ source: 'system', version: '1.18.40' }))
    expect(fs.existsSync(exact)).toBe(true)
  })

  it('keeps the newest installed version for a `latest` selection', async () => {
    const newest = install('pi', '0.99.1', 30)
    const older = install('pi', '0.90.0', 30)
    await gc(() => ({ source: 'managed', version: 'latest' }))
    expect(fs.existsSync(newest)).toBe(true)
    expect(fs.existsSync(older)).toBe(false)
  })

  it('keeps the managed version the resolver runs now, however long since it was resolved', async () => {
    const running = install('pi', '0.95.0', 30, 30)
    const other = install('pi', '0.94.0', 30, 30)
    await gc(undefined, undefined, (id) =>
      id === 'pi' ? { source: 'managed', version: '0.95.0' } : { source: 'bundled', version: null }
    )
    expect(fs.existsSync(running)).toBe(true)
    expect(fs.existsSync(other)).toBe(false)
  })

  it('keeps a version used in the last seven days, whenever it was installed', async () => {
    const recent = install('opencode', '1.18.40', 30, 6)
    const stale = install('opencode', '1.18.41', 30, 8)
    const fresh = install('opencode', '1.18.42', 2)
    await gc()
    expect(fs.existsSync(recent)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(RETENTION_MS).toBe(7 * DAY)
  })

  it('skips a version it cannot move (in use) and leaves it whole for next time', async () => {
    const held = install('opencode', '1.18.40', 30)
    const result = await gc(undefined, async () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    expect(result).toMatchObject({ removed: [], skipped: ['opencode 1.18.40'] })
    expect(fs.readdirSync(held).sort()).toEqual(
      ['install.json', process.platform === 'win32' ? 'opencode.exe' : 'opencode'].sort()
    )
    // Next time it can go.
    await gc()
    expect(fs.existsSync(held)).toBe(false)
  })

  it('ignores directories not named like a version', async () => {
    const odd = path.join(store, 'opencode', 'notes')
    fs.mkdirSync(odd, { recursive: true })
    const at = new Date(NOW - 30 * DAY)
    fs.utimesSync(odd, at, at)
    await gc()
    expect(fs.existsSync(odd)).toBe(true)
  })

  it('removes stale .staging and .trash entries, but not fresh ones', async () => {
    const staleStage = path.join(store, STAGING_DIR, 'pi-0.87.1-aaaa')
    const freshStage = path.join(store, STAGING_DIR, 'pi-0.87.1-bbbb')
    const staleTrash = path.join(store, TRASH_DIR, 'pi-0.80.0-cccc')
    for (const dir of [staleStage, freshStage, staleTrash]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'part'), 'x')
    }
    const old = new Date(NOW - STALE_AFTER_MS - 1000)
    const recent = new Date(NOW - 1000)
    for (const [dir, at] of [
      [staleStage, old],
      [staleTrash, old],
      [freshStage, recent]
    ] as const) {
      fs.utimesSync(path.join(dir, 'part'), at, at)
      fs.utimesSync(dir, at, at)
    }
    const result = await gc()
    expect(result.stale).toBe(2)
    expect(fs.existsSync(staleStage)).toBe(false)
    expect(fs.existsSync(staleTrash)).toBe(false)
    expect(fs.existsSync(freshStage)).toBe(true)
  })

  it('does nothing, without throwing, when the store does not exist', async () => {
    await expect(gc()).resolves.toMatchObject({ removed: [], kept: 0, skipped: [], stale: 0 })
  })
})
