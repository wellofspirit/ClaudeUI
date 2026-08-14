/**
 * @vitest-environment node
 *
 * The funnel guard — SyncCore phase 4a items 2, 3 and 10.
 *
 * A static SOURCE scan, deliberately. The invariants it protects are structural
 * ("there is exactly one emission path", "every channel is classified"), and a
 * behavioral test can only ever prove it about the paths it happens to exercise.
 * The scan proves it about the whole tree, and it is the thing that makes
 * "one emission ⇒ one ring append" enforceable instead of aspirational.
 *
 * Companion to `remote-channel-parity.test.ts`, which scans the invoke surface;
 * this one scans the EVENT surface.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { CHANNEL_SPECS, channelSpec, deliveryDeltas } from '../../../shared/sync/channels'

const REPO = process.cwd()

/** The delivery adapter — the ONE file allowed to fan out. */
const DELIVERY_ADAPTER = 'src/main/services/sync-host.ts'

/**
 * The remote bridge keeps a `webContents.send` shim because `extraWindows` is
 * typed `Set<BrowserWindow>`; `remote-server.ts` wires it to a loud no-op. Both
 * are named 4c deletion targets, not funnel bypasses.
 */
const SHIM_FILES = new Set(['src/main/services/remote-bridge.ts'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(rel, out)
    } else if (entry.name.endsWith('.ts')) {
      out.push(rel)
    }
  }
  return out
}

const MAIN_SOURCES = walk('src/main')

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf-8')
}

describe('emission funnel (item 2)', () => {
  it('the scan sees the tree it thinks it sees (non-vacuity)', () => {
    expect(MAIN_SOURCES.length).toBeGreaterThan(50)
    expect(MAIN_SOURCES).toContain(DELIVERY_ADAPTER)
    expect(MAIN_SOURCES).toContain('src/main/providers/BaseSession.ts')
  })

  it('no hand-rolled getExtraWindows() fan-out loop survives outside the adapter', () => {
    const offenders = MAIN_SOURCES.filter((rel) => {
      if (rel === DELIVERY_ADAPTER) return false
      const src = read(rel)
      // A `for (… of …getExtraWindows())` loop is the shape every funneled site
      // used. The accessor itself is still allowed (BaseSession re-exports it).
      return /for\s*\([^)]*of\s+[A-Za-z.]*getExtraWindows\(\)/.test(src)
    })
    expect(
      offenders,
      `these still fan out by hand instead of calling emitEvent(): ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('no replicated/volatile channel is sent by a direct webContents.send', () => {
    // The whole point of the funnel: an event that replicates MUST be appended to
    // the ring and applied to canonical state before anyone sees it. A direct
    // send skips both, which is defect 5 in docs/architecture/remote.md.
    const offenders: string[] = []
    for (const rel of MAIN_SOURCES) {
      if (rel === DELIVERY_ADAPTER || SHIM_FILES.has(rel)) continue
      const src = read(rel)
      const re = /webContents\s*\.\s*send\(\s*['"]([^'"]+)['"]/g
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const spec = channelSpec(m[1])
        if (spec && spec.cls !== 'host-local') offenders.push(`${rel}: ${m[1]}`)
      }
    }
    expect(
      offenders,
      `replicated channels sent outside the delivery adapter: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('BaseSession.send delegates to the funnel rather than sending directly', () => {
    const src = read('src/main/providers/BaseSession.ts')
    expect(src).toMatch(/protected send\([\s\S]{0,400}?emitEvent\(/)
    expect(src).not.toMatch(/this\.win\.webContents\.send\(/)
  })
})

describe('channel classification coverage (item 3, fail-closed)', () => {
  /**
   * Every channel literal the main process emits, from both emission shapes:
   * `emitEvent('x', …)` and `this.send('x', …)` (BaseSession, which funnels).
   * Also picks up the remaining host-local `webContents.send('x', …)` sites, so
   * a host-local channel cannot dodge classification either.
   */
  function emittedChannels(): Set<string> {
    const found = new Set<string>()
    const patterns = [
      /emitEvent\(\s*['"]([^'"]+)['"]/g,
      /this\.send\(\s*['"]([^'"]+)['"]/g,
      /sendFn\(\s*['"]([^'"]+)['"]/g,
      /webContents\s*\.\s*send\(\s*['"]([^'"]+)['"]/g
    ]
    for (const rel of MAIN_SOURCES) {
      if (rel === DELIVERY_ADAPTER || SHIM_FILES.has(rel)) continue
      const src = read(rel)
      for (const re of patterns) {
        re.lastIndex = 0
        for (let m = re.exec(src); m; m = re.exec(src)) found.add(m[1])
      }
    }
    return found
  }

  it('the scan finds the channels we know exist (non-vacuity)', () => {
    const emitted = emittedChannels()
    expect(emitted.size).toBeGreaterThan(40)
    expect(emitted.has('session:message')).toBe(true)
    expect(emitted.has('session:config-changed')).toBe(true)
    expect(emitted.has('git:status-update')).toBe(true)
  })

  it('every emitted channel is classified', () => {
    const unclassified = [...emittedChannels()].filter((c) => !channelSpec(c)).sort()
    expect(
      unclassified,
      `unclassified channels (add them to src/shared/sync/channels.ts): ${unclassified.join(', ')}`
    ).toEqual([])
  })

  it('every preload `onEvent` channel is classified', () => {
    // The renderer's subscription surface is the other end of the same contract:
    // a channel a client listens for but nothing classifies would silently never
    // arrive once the funnel became fail-closed.
    const src = read('src/preload/index.ts')
    const re = /onEvent\(\s*['"]([^'"]+)['"]\s*\)/g
    const channels: string[] = []
    for (let m = re.exec(src); m; m = re.exec(src)) channels.push(m[1])
    expect(channels.length).toBeGreaterThan(40)
    const unclassified = channels.filter((c) => !channelSpec(c)).sort()
    expect(unclassified, `preload listens for unclassified: ${unclassified.join(', ')}`).toEqual([])
  })

  it('the web client subscribes only to classified channels', () => {
    const src = read('src/web/api-adapter.ts')
    const re = /\bon\(\s*['"]([^'"]+)['"]\s*\)/g
    const channels: string[] = []
    for (let m = re.exec(src); m; m = re.exec(src)) channels.push(m[1])
    expect(channels.length).toBeGreaterThan(30)
    const unclassified = channels.filter((c) => !channelSpec(c)).sort()
    expect(
      unclassified,
      `api-adapter listens for unclassified: ${unclassified.join(', ')}`
    ).toEqual([])
  })

  it('a host-local channel never rings and never touches canonical state', () => {
    // Rule 2: host-local means the desktop window only. A ringed host-local
    // channel would be replayed to remote clients on catchup.
    const violations = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => s.cls === 'host-local' && (s.ring || s.canonical))
      .map(([c]) => c)
    expect(violations).toEqual([])
    const misdelivered = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => s.cls === 'host-local' && s.delivery !== 'main-only')
      .map(([c]) => c)
    expect(misdelivered).toEqual([])
  })

  it('the delivery-delta column holds EXACTLY the 4a-sanctioned rows', () => {
    // The sanctioned set is `session:config-changed` (a new channel) and the
    // metering snapshot FIELD. Anything else appearing here means 4a changed what
    // some client can see, which is out of scope by construction.
    expect(deliveryDeltas().map((d) => d.channel)).toEqual([
      'session:config-changed',
      'session:metering'
    ])
  })

  it('a canonical channel is never host-local (they would contradict)', () => {
    const contradictions = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => s.canonical && !s.ring)
      .map(([c]) => c)
    // Canonical-without-ring would mean core applies an event a reconnecting
    // client can never replay — the snapshot and the stream would disagree.
    expect(contradictions).toEqual([])
  })

  it('every spec carries a rationale (the docs table is generated from these)', () => {
    const missing = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => !s.why || s.why.length < 20)
      .map(([c]) => c)
    expect(missing).toEqual([])
  })
})

describe('no-Electron fence (item 10)', () => {
  it('is configured for BOTH fenced trees', () => {
    const config = read('eslint.config.mjs')
    expect(config).toContain('no-restricted-imports')
    expect(config).toContain('src/main/sync/**')
    expect(config).toContain('src/shared/sync/**')
  })

  it('no source under the fence imports electron (belt to the lint braces)', () => {
    const fenced = [...walk('src/main/sync'), ...walk('src/shared/sync')]
    expect(fenced.length).toBeGreaterThan(4)
    const offenders = fenced.filter((rel) =>
      /from\s+['"](electron|electron\/|@electron)/.test(read(rel))
    )
    expect(offenders, `Electron imports under the fence: ${offenders.join(', ')}`).toEqual([])
  })
})
