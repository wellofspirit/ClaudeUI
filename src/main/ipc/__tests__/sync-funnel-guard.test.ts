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
 * No shim files as of SyncCore phase 4c. 4a had one — `remote-bridge.ts` kept a
 * `webContents.send` entry point because the extras registry was typed
 * `Set<BrowserWindow>` and a WebSocket broadcaster had to masquerade as a window.
 * The registry, the bridge and the masquerade are all deleted; a client is a
 * plain `(seq, channel, args)` subscriber. An empty exemption set is the point.
 */
const SHIM_FILES = new Set<string>()

function walk(dir: string, out: string[] = [], exts: string[] = ['.ts']): string[] {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(rel, out, exts)
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(rel)
    }
  }
  return out
}

const MAIN_SOURCES = walk('src/main')

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf-8')
}

/**
 * Source with comments removed.
 *
 * Every identifier scan below has to run on CODE only: 4c's doc comments name the
 * things they deleted (`addExtraWindow`, `RemoteBridge`, `webContents.send`) on
 * purpose — that prose is how a future reader learns what the shape used to be —
 * and a scan that counted it would either fail forever or force the explanation
 * out of the tree.
 */
function readCode(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('emission funnel (item 2)', () => {
  it('the scan sees the tree it thinks it sees (non-vacuity)', () => {
    expect(MAIN_SOURCES.length).toBeGreaterThan(50)
    expect(MAIN_SOURCES).toContain(DELIVERY_ADAPTER)
    expect(MAIN_SOURCES).toContain('src/main/providers/BaseSession.ts')
  })

  it('the extra-window registry is GONE from the tree (4c)', () => {
    // `getExtraWindows` was the SHAPE of the delivery privilege: a set of
    // fake-`BrowserWindow` objects that every non-desktop client had to disguise
    // itself as. 4a allowed the accessor and banned only hand-rolled loops over
    // it; 4c bans the identifier outright, everywhere, including the adapter.
    const offenders = MAIN_SOURCES.filter((rel) =>
      /getExtraWindows|addExtraWindow|removeExtraWindow|addExtraSink|extraSinks/.test(
        readCode(rel)
      )
    )
    expect(
      offenders,
      `these still reference the deleted extra-window registry: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('the fake-BrowserWindow remote bridge is gone', () => {
    expect(fs.existsSync(path.join(REPO, 'src/main/services/remote-bridge.ts'))).toBe(false)
    const offenders = MAIN_SOURCES.filter((rel) =>
      /RemoteBridge|deliverSequenced/.test(readCode(rel))
    )
    expect(offenders, `these still reference RemoteBridge: ${offenders.join(', ')}`).toEqual([])
  })

  it('no delivery TARGET survives at any call site (delivery follows class)', () => {
    // A call site that could pick `'extras-only'` could choose which clients see a
    // replicated event — the asymmetry `notifyMainWindow` encoded. Delivery is a
    // function of the channel's class now, so neither the literals nor the flag may
    // reappear.
    const offenders: string[] = []
    for (const rel of MAIN_SOURCES) {
      const src = readCode(rel)
      if (/'extras-only'|"extras-only"/.test(src)) offenders.push(`${rel}: extras-only`)
      // `notifyMainWindow` appears in doc comments recording its death; only a
      // CODE reference (an identifier followed by `:`/`?`/`)`) is a violation.
      if (/notifyMainWindow\s*[:?)]/.test(src)) offenders.push(`${rel}: notifyMainWindow`)
    }
    expect(
      offenders,
      `these still choose a delivery target per call site: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('no replicated/volatile channel is sent by a direct webContents.send — including the adapter', () => {
    // The whole point of the funnel: an event that replicates MUST be appended to
    // the ring and applied to canonical state before anyone sees it. A direct
    // send skips both, which is defect 5 in docs/architecture/remote.md.
    //
    // 4c tightened this to cover the DELIVERY ADAPTER too. In 4a the adapter was
    // the one legitimate `webContents.send` of a replicated channel (the desktop
    // window was a fan-out target); now its only `send` is the host-local lane, so
    // a replicated channel appearing there would be the privilege growing back.
    const offenders: string[] = []
    for (const rel of MAIN_SOURCES) {
      if (SHIM_FILES.has(rel)) continue
      const src = readCode(rel)
      const re = /webContents\s*\.\s*send\(\s*['"]([^'"]+)['"]/g
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const spec = channelSpec(m[1])
        if (spec && spec.cls !== 'host-local') offenders.push(`${rel}: ${m[1]}`)
      }
    }
    expect(
      offenders,
      `replicated channels sent by a targeted webContents.send: ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('a VARIABLE-channel webContents.send exists only where it is host-local by construction', () => {
    // The scan above matches a channel LITERAL, so `wc.send(channel, ...args)`
    // slipped straight past it — and that is not hypothetical: `VoiceClient.send`
    // was routing the REPLICATED `voice:error` through a targeted window send, which
    // 4c made invisible to the renderer (it subscribes to that channel now). Caught
    // by reading the tree, not by this test, so the test exists to make the next one
    // cheaper.
    //
    // The allowlist is per-file and each entry must be host-local BY CONSTRUCTION —
    // i.e. every channel that reaches the helper is classified `host-local`.
    const ALLOWED = new Set([
      // Only `voice:state` / `voice:transcript` (microphone capture belongs to the
      // machine with the microphone). `voice:error` goes through the funnel.
      'src/main/services/voice-client.ts',
      // The separate log-viewer BrowserWindow: `log-viewer:*`, host diagnostics.
      'src/main/services/log-viewer.ts',
      // `plugin:<id>:<event>` (ADR-005) — matched by the `plugin:` PREFIX spec,
      // which is host-local. Plugin-declared capabilities are the follow-up that
      // decides whether plugin surfaces may ever replicate.
      'src/main/services/plugin-manager.ts'
    ])
    const offenders: string[] = []
    for (const rel of MAIN_SOURCES) {
      if (rel === DELIVERY_ADAPTER || ALLOWED.has(rel)) continue
      const src = readCode(rel)
      // A `webContents.send(` / `wc.send(` whose first argument is not a string
      // literal. Anchored on the RECEIVER so `this.send(channel, …)` (BaseSession,
      // which funnels) and `ws.send(…)` (the WebSocket) are not false positives.
      if (/(?:webContents|\bwc)\s*\.\s*send\(\s*(?!['"`])[A-Za-z_$]/.test(src)) {
        offenders.push(rel)
      }
    }
    expect(
      offenders,
      `these send an event on a computed channel — prove it is host-local and allowlist it, ` +
        `or route it through emitEvent(): ${offenders.join(', ')}`
    ).toEqual([])

    // The allowlist has to EARN itself, or it is just an exemption that decays.
    // For each allowlisted file, every literal channel handed to its own `send`
    // helper must be host-local: that is what makes the computed-channel path
    // host-local by construction, and it is the check that would have caught
    // `voice:error` being routed through `VoiceClient.send`.
    const notHostLocal: string[] = []
    for (const rel of ALLOWED) {
      const src = readCode(rel)
      const re = /\.send\(\s*['"]([^'"]+)['"]/g
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const spec = channelSpec(m[1])
        if (spec && spec.cls !== 'host-local') notHostLocal.push(`${rel}: ${m[1]}`)
      }
    }
    expect(
      notHostLocal,
      `an allowlisted computed-channel sender also carries NON-host-local channels, so its ` +
        `exemption is unsound: ${notHostLocal.join(', ')}`
    ).toEqual([])
  })

  it('the delivery adapter routes by channel CLASS, not by a per-call target', () => {
    const src = readCode(DELIVERY_ADAPTER)
    expect(src).toMatch(/delivery\.cls === 'host-local'/)
    expect(src).toMatch(/for \(const sink of \[\.\.\.subscribers\]\)/)
    // Only ONE `webContents.send` in the adapter, and it is the host-local lane.
    expect(src.match(/webContents\.send/g) ?? []).toHaveLength(1)
  })

  it('BaseSession.send delegates to the funnel rather than sending directly', () => {
    const src = read('src/main/providers/BaseSession.ts')
    expect(src).toMatch(/protected send\([\s\S]{0,400}?emitEvent\(/)
    expect(src).not.toMatch(/this\.win\.webContents\.send\(/)
    // 4c: a session emission names no window at all — every channel it emits is
    // replicated or volatile, so the per-session `win` is not a delivery target.
    expect(src).toMatch(/emitEvent\(channel, \[this\.routingId, this\.trackThinkingSpan\(channel, data\)\]\)/)
  })
})

describe('snapshot path is synchronous (phase 4b, invariant 2)', () => {
  // The exact watermark is a property of the CODE SHAPE, not of any single
  // execution: `getSnapshot()` reads the ring seq and serializes canonical state
  // in one synchronous tick, so nothing can be appended in between. One `await`
  // anywhere on that path silently reintroduces the race the old renderer pull
  // had to under-claim around (remote.md defect 3) — and a behavioral test would
  // only catch it on the interleaving it happens to produce.
  it('SyncCore.getSnapshot and toSnapshot are not async and contain no await', () => {
    const core = read('src/main/sync/sync-core.ts')
    const snapshotFn = /getSnapshot\(\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(core)
    expect(snapshotFn, 'getSnapshot() not found in sync-core.ts').not.toBeNull()
    expect(snapshotFn![1]).not.toMatch(/\bawait\b/)
    expect(core).not.toMatch(/async\s+getSnapshot/)

    const state = read('src/shared/sync/state.ts')
    expect(state).not.toMatch(/async\s+function\s+(to|from)Snapshot/)
    expect(state).not.toMatch(/\bawait\b/)
  })

  it('remote-server serves sync-full and /sent-file from canonical, never a renderer pull', () => {
    const src = read('src/main/services/remote-server.ts')
    // The whole point of the cutover: no window is involved in a snapshot, so a
    // busy/hung/absent renderer cannot degrade a reconnect. (Matched on the CALL,
    // not the word — the doc comments explain what was removed.)
    expect(src).not.toMatch(/\.executeJavaScript\(/)
    expect(src).not.toMatch(/window\.__getRemoteState/)
    expect(src).toMatch(/type: 'sync-full',[\s\S]{0,60}?state: decision\.state/)
    // Since 4c the full/catchup branching lives in `shared/sync/sync-decision.ts`
    // (one decision, two transports), so remote-server reads a snapshot exactly
    // ONCE on its own: the `/sent-file` allowlist. The sync answer's snapshot comes
    // from `answerSync`, which is where the same-tick seq+serialize property is
    // enforced now.
    const ownSnapshots = src.match(/this\.core\.getSnapshot\(\)/g) ?? []
    expect(ownSnapshots.length).toBe(1)
    expect(src).toMatch(/this\.core\.answerSync\(lastSeq, epoch\)/)
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

  it('the preload subscribes to HOST-LOCAL channels only (4c)', () => {
    // The per-channel preload surface used to carry every replicated channel — it
    // was the desktop's whole subscription mechanism, and its parity with the web
    // adapter was hand-maintained. 4c moved those to the sync client, so anything
    // still here that replicates is a channel the desktop would receive by a
    // privileged path no other client has.
    const src = readCode('src/preload/index.ts')
    const re = /onEvent\(\s*['"]([^'"]+)['"]\s*\)/g
    const channels: string[] = []
    for (let m = re.exec(src); m; m = re.exec(src)) channels.push(m[1])
    expect(channels.length).toBeGreaterThan(5)
    const unclassified = channels.filter((c) => !channelSpec(c)).sort()
    expect(unclassified, `preload listens for unclassified: ${unclassified.join(', ')}`).toEqual([])
    const replicated = channels.filter((c) => channelSpec(c)?.cls !== 'host-local').sort()
    expect(
      replicated,
      `preload still takes these off a privileged targeted send: ${replicated.join(', ')}`
    ).toEqual([])
  })

  it('the web adapter subscribes to HOST-LOCAL channels only (4c)', () => {
    const src = readCode('src/web/api-adapter.ts')
    const re = /\bon\(\s*['"]([^'"]+)['"]\s*\)/g
    const channels: string[] = []
    for (let m = re.exec(src); m; m = re.exec(src)) channels.push(m[1])
    const unclassified = channels.filter((c) => !channelSpec(c)).sort()
    expect(
      unclassified,
      `api-adapter listens for unclassified: ${unclassified.join(', ')}`
    ).toEqual([])
    const replicated = channels.filter((c) => channelSpec(c)?.cls !== 'host-local').sort()
    expect(
      replicated,
      `api-adapter still mirrors replicated channels (4c deleted that): ${replicated.join(', ')}`
    ).toEqual([])
  })

  it('every channel a CLIENT subscribes to through the sync transport is classified', () => {
    // The other end of the fail-closed contract. Two surfaces are scanned: the
    // typed `SyncEventMap` (the declaration) and every `onSyncEvent('…')` call in
    // the renderer + web trees (the usage). A channel in either that nothing
    // classifies would silently never arrive.
    //
    // SyncCore phase 4c shrank the per-channel usage surface on purpose: the
    // replica subscribes ONCE, channel-agnostically (`SyncClient.onAnyEvent`), and
    // folds every `canonical: true` channel through `applyEvent`. What is left as an
    // explicit `onSyncEvent(...)` is exactly the `canonical: false` set — the
    // transient toast/banner channels with no snapshot field. So the count below
    // dropped from >30 to the size of that set, and the coverage that used to come
    // from counting call sites now comes from the classification itself: every
    // canonical channel has a reducer branch, pinned by the reducer-coverage test.
    const declared = [...read('src/shared/sync/events.ts').matchAll(/^\s{2}'([^']+)':/gm)].map(
      (m) => m[1]
    )
    expect(declared.length).toBeGreaterThan(30)

    const subscribed = new Set<string>()
    for (const dir of ['src/renderer', 'src/web']) {
      for (const rel of walk(dir, [], ['.ts', '.tsx'])) {
        const code = readCode(rel)
        const re = /onSyncEvent\(\s*['"]([^'"]+)['"]/g
        for (let m = re.exec(code); m; m = re.exec(code)) subscribed.add(m[1])
      }
    }
    expect(subscribed.size).toBeGreaterThan(10)

    const all = [...new Set([...declared, ...subscribed])]
    const unclassified = all.filter((c) => !channelSpec(c)).sort()
    expect(
      unclassified,
      `clients subscribe to unclassified channels: ${unclassified.join(', ')}`
    ).toEqual([])
    const hostLocal = all.filter((c) => channelSpec(c)?.cls === 'host-local').sort()
    expect(
      hostLocal,
      `host-local channels cannot arrive on the sync transport: ${hostLocal.join(', ')}`
    ).toEqual([])

    // Every channel a client subscribes to must be DECLARED in the typed map, or
    // it is subscribed to untyped and the map has stopped being the contract.
    const undeclared = [...subscribed].filter((c) => !declared.includes(c)).sort()
    expect(
      undeclared,
      `subscribed but missing from SyncEventMap: ${undeclared.join(', ')}`
    ).toEqual([])
  })

  it('a host-local channel never rings and never touches canonical state', () => {
    // host-local means the owning window only, so a ringed host-local channel
    // would be replayed to remote clients on catchup. (The old companion check —
    // `delivery === 'main-only'` — is gone with the column: delivery IS the class
    // now, so the two can no longer disagree.)
    const violations = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => s.cls === 'host-local' && (s.ring || s.canonical))
      .map(([c]) => c)
    expect(violations).toEqual([])
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
