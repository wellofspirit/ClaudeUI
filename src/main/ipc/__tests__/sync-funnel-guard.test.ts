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
import {
  CHANNEL_SPECS,
  channelSpec,
  deliveryDeltas,
  volatileStreamChannels
} from '../../../shared/sync/channels'
import { applyEvent, emptyAux } from '../../../shared/sync/reducer'
import {
  sessionIdOfStream,
  streamEventScopeOf,
  streamFrameFrom,
  streamFrameToEmission
} from '../../../shared/sync/stream'
import { emptyCanonicalState, emptySession, type CanonicalState } from '../../../shared/sync/state'
import { STREAM_WATCH_COMMAND } from '../stream-watch'
import { GIT_WATCH_COMMAND } from '../git-watch'

/** A canonical state holding one session — the minimum a stream frame needs. */
function stateWithSession(routingId: string): CanonicalState {
  const base = emptyCanonicalState()
  return { ...base, sessions: { [routingId]: emptySession(routingId, '/repo') } }
}

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

  it('an EVENT-lane canonical channel always rings (they would contradict)', () => {
    // Canonical-without-ring on the EVENT lane would mean core applies an event a
    // reconnecting client can never replay — the snapshot and the stream would
    // disagree. The `volatile` class is the sanctioned exception and the reason
    // this test names a lane: its channels are canonical-backed AND ringless by
    // design, because their frames are not events at all (phase 5 S1). The
    // classification-invariant suite below is what holds them to that.
    const contradictions = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => s.canonical && !s.ring && s.cls !== 'volatile')
      .map(([c]) => c)
    expect(contradictions).toEqual([])
  })

  it('every spec carries a rationale (the docs table is generated from these)', () => {
    const missing = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => !s.why || s.why.length < 20)
      .map(([c]) => c)
    expect(missing).toEqual([])
  })
})

describe('the volatile lane (phase 5 S1 + S2)', () => {
  // The single-source rule, enforced as a property of the TABLE rather than of
  // any one dispatch site: everything that treats a channel as volatile reads
  // `cls === 'volatile'`, and everything that decides WHICH frame it becomes
  // reads `volatileFlavor`. If the table and the dispatch could disagree, these
  // assertions are where it shows.
  const volatile = volatileStreamChannels()
  const textStreams = volatileStreamChannels('text-stream')
  const passThrough = volatileStreamChannels('pass-through')

  it('is the two delta channels plus the three tails, split by flavor', () => {
    expect(textStreams).toEqual(['session:stream', 'session:subagent-stream'])
    expect(passThrough).toEqual([
      'automation:stream-event',
      'session:background-output',
      'session:bash-output'
    ])
    // Every member has a flavor, and the two flavors partition the lane. A
    // volatile channel with no flavor would be routed by `SyncCore.process`'s
    // else-branch into `streamFrameFrom`, which returns null for it — a silent
    // drop of the whole channel.
    expect([...textStreams, ...passThrough].sort()).toEqual(volatile)
  })

  it('the interim `volatile-pending-phase-5` class is GONE, not merely empty', () => {
    // Deletion is the retirement (4a rule 1). An empty option left in the union
    // would let a future channel be parked there with no lane to ride.
    expect(readCode('src/shared/sync/channels.ts')).not.toContain('volatile-pending-phase-5')
    for (const spec of Object.values(CHANNEL_SPECS)) {
      expect(['replicated', 'volatile', 'host-local']).toContain(spec.cls)
    }
  })

  it('volatile ⇒ NEVER rings, whichever flavor', () => {
    for (const channel of volatile) {
      // No ring ⇒ no seq ⇒ neither a turn of tokens nor a noisy bash command can
      // flush the 5000-entry ring and force a `sync-full` on the next reconnect.
      // That IS the phase-5 exit criterion.
      expect(channelSpec(channel)!.ring, `${channel} still rings`).toBe(false)
    }
  })

  it('text-stream ⇒ canonical-backed, and has a streamId', () => {
    for (const channel of textStreams) {
      const spec = channelSpec(channel)!
      // Canonical-backed: the accumulation is a snapshot field, which is what
      // makes an unwatched session still converge at message boundaries.
      expect(spec.canonical, `${channel} lost its canonical backing`).toBe(true)
      // And the streamId helper covers it — a channel on the lane with no frame
      // translation would be silently dropped by `SyncCore.process`.
      const frame = streamFrameFrom(
        stateWithSession('rid'),
        emptyAux(),
        channel,
        ['rid', { type: 'text', text: 'hi', toolUseId: 'tu-1' }]
      )
      expect(frame, `${channel} has no streamId translation`).not.toBeNull()
      expect(sessionIdOfStream(frame!.streamId)).toBe('rid')
    }
  })

  it('pass-through ⇒ NOT canonical, and every one has a delivery scope', () => {
    const payloads: Record<string, unknown[]> = {
      'session:bash-output': ['rid', { toolUseId: 'tu-1', output: 'x' }],
      'session:background-output': ['rid', { toolUseId: 'tu-1', tail: 'x' }],
      'automation:stream-event': [{ automationId: 'auto-1', type: 'text', text: 'x' }]
    }
    for (const channel of passThrough) {
      // A tail has no snapshot field: nothing accumulates it, which is exactly
      // why losing one is honest rather than a hole.
      expect(channelSpec(channel)!.canonical, `${channel} claims canonical backing`).toBe(false)
      // A frame with no scope reaches NOBODY (sync-host drops it), so a channel
      // the scope helper does not understand would be a silently dead lane.
      const scope = streamEventScopeOf({ type: 'stream-ev', channel, args: payloads[channel] })
      expect(scope, `${channel} has no delivery scope`).not.toBeNull()
    }
    // The two session tails are session-scoped by position; the automation tail
    // is scoped by AUTOMATION (its payload carries no run id — see
    // docs/architecture/sync-channels.md).
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'session:bash-output',
        args: payloads['session:bash-output']
      })
    ).toEqual({ kind: 'session', id: 'rid' })
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'automation:stream-event',
        args: payloads['automation:stream-event']
      })
    ).toEqual({ kind: 'automation', id: 'auto-1' })
  })

  it('volatile ⇒ no reducer branch, and applyEvent refuses one', () => {
    // Both halves matter. The SOURCE half: a `case 'session:stream':` growing
    // back would be a second accumulator racing `applyStreamFrame`.
    const reducerSrc = readCode('src/shared/sync/reducer.ts')
    for (const channel of volatile) {
      expect(reducerSrc).not.toContain(`case '${channel}':`)
    }
    // The BEHAVIORAL half: even routed onto the event lane by mistake, the fold
    // is identity-stable rather than a duplicate append.
    const before = stateWithSession('rid')
    for (const channel of volatile) {
      const after = applyEvent(
        before,
        { channel, args: ['rid', { type: 'text', text: 'hi', toolUseId: 't' }], seq: 1 },
        emptyAux()
      )
      expect(after, `applyEvent still folds ${channel}`).toBe(before)
    }
  })

  it('replicated channels are untouched by the migration', () => {
    // The bounded half of the claim: the lane took five rows and nothing else.
    // Any `replicated` row that stopped ringing would be an unnoticed lane change.
    const broken = Object.entries(CHANNEL_SPECS)
      .filter(([, s]) => s.cls === 'replicated' && !s.ring)
      .map(([c]) => c)
    expect(broken).toEqual([])
  })

  it('text-stream channels have left SyncEventMap; the TAILS deliberately stay', () => {
    // The typed map IS the subscription contract. For a text stream, leaving an
    // entry would advertise a listener that can never fire — the replica folds
    // those frames instead. For a TAIL it is the opposite: the pass-through
    // flavor exists so the existing per-channel listeners keep working verbatim,
    // so an entry that vanished would delete a live subscription.
    const declared = [...read('src/shared/sync/events.ts').matchAll(/^\s{2}'([^']+)':/gm)].map(
      (m) => m[1]
    )
    expect(declared.length).toBeGreaterThan(30)
    for (const channel of textStreams) {
      expect(declared, `${channel} is still declared as a subscribable event`).not.toContain(
        channel
      )
    }
    for (const channel of passThrough) {
      expect(declared, `${channel} lost its listener contract`).toContain(channel)
    }
  })

  it('in-process consumers keep their pre-split payload through ONE shared inverse', () => {
    // The plugin bridge (ADR-005) and the engine tests' stub window both consumed
    // these channels before the split. They still do — through an OBSERVER on the
    // lane, not a connection — and both go through the same `streamFrameToEmission`,
    // so there is one answer to "what did the emitter send".
    expect(streamFrameToEmission({
      type: 'stream',
      streamId: 'rid/thinking',
      turnId: 0,
      offset: 0,
      chunk: 'weighing'
    })).toEqual({
      channel: 'session:stream',
      routingId: 'rid',
      data: { type: 'thinking', text: 'weighing' }
    })
    expect(streamFrameToEmission({
      type: 'stream',
      streamId: 'rid/sub/tu-1/text',
      turnId: 0,
      offset: 0,
      chunk: 'out'
    })).toEqual({
      channel: 'session:subagent-stream',
      routingId: 'rid',
      data: { type: 'text', toolUseId: 'tu-1', text: 'out' }
    })
    expect(streamFrameToEmission({
      type: 'stream',
      streamId: 'bogus',
      turnId: 0,
      offset: 0,
      chunk: 'x'
    })).toBeNull()

    // Both consumers import it rather than hand-rolling the reconstruction.
    for (const rel of [
      'src/main/services/plugin-manager.ts',
      'src/test/helpers/sync-subscriber-window.ts'
    ]) {
      expect(readCode(rel), `${rel} does not use the shared inverse`).toMatch(
        /streamFrameToEmission/
      )
    }
    // And the plugin bridge observes the lane instead of pretending to be a client.
    expect(readCode('src/main/services/plugin-manager.ts')).toMatch(/addStreamObserver\(/)
    // A PASS-THROUGH frame needs no inverse — it never stopped being the emission
    // — but the bridge must still forward it, or every plugin silently loses the
    // three tails it has always received.
    expect(readCode('src/main/services/plugin-manager.ts')).toMatch(/frame\.type === 'stream-ev'/)
  })

  it('the volatile lane never reaches the audit log or the event fan-out', () => {
    // `stream:watch` is a QUERY, and the registry does not audit queries — the
    // structural reason a subscription toggle leaves no row. Pinned against the
    // declaration rather than against a log, because the log is what would be
    // empty either way.
    expect(STREAM_WATCH_COMMAND.kind).toBe('query')
    expect(STREAM_WATCH_COMMAND.capability).toBe('chat')
    expect(STREAM_WATCH_COMMAND.withConnection).toBe(true)
    // And the frames go out through the stream registry, never `addSyncSubscriber`.
    const host = readCode(DELIVERY_ADAPTER)
    expect(host).toMatch(/syncCore\.setStreamDelivery\(streamDelivery\)/)
    const core = readCode('src/main/sync/sync-core.ts')
    expect(core).toMatch(/spec\.cls === 'volatile'/)
    expect(core).toMatch(/spec\.volatileFlavor === 'pass-through'/)
  })

  it('the WS sink drops stream frames under backpressure, and only stream frames', () => {
    // The cap is stream-lane-only by construction: it is applied inside the
    // stream sink's closure, not inside `sendTo`, so an event, a sync answer or a
    // terminal frame cannot take that branch. A missing EVENT is a permanent hole
    // in a seq-ordered stream; a missing stream frame heals or is lossy by
    // contract.
    const server = readCode('src/main/services/remote-server.ts')
    expect(server).toMatch(/addStreamSubscriber\(connectionId, \(frame\) => \{/)
    expect(server).toMatch(/if \(this\.streamCongested\(ws, newClient\)\) return/)
    expect(server).toMatch(/STREAM_BACKPRESSURE_BYTES/)
    // The desktop MessagePort sink is exempt — no socket, no `bufferedAmount` —
    // and its source says why. Read RAW: the exemption is a comment, which is the
    // honest form for "we deliberately did not do the thing next door does".
    expect(read('src/main/services/sync-port.ts')).toMatch(/NO BACKPRESSURE CAP HERE/)
    expect(readCode('src/main/services/sync-port.ts')).not.toMatch(/bufferedAmount/)
  })

  it('git:watch is a per-connection query at the capability git reads already need', () => {
    // The retirement (phase 5 S2): the collective-owner refcount is gone, and the
    // replacement must not have widened anything — both retired channels declared
    // exactly this, so security.md needs no amendment.
    expect(GIT_WATCH_COMMAND.channel).toBe('git:watch')
    expect(GIT_WATCH_COMMAND.capability).toBe('git')
    expect(GIT_WATCH_COMMAND.kind).toBe('query')
    expect(GIT_WATCH_COMMAND.withConnection).toBe(true)
    // The owner ids are DELETED, not merely unused — deletion is the retirement.
    const registry = readCode('src/main/services/git-watch-registry.ts')
    expect(registry).not.toMatch(/GIT_WATCH_OWNER/)
    expect(registry).not.toMatch(/releaseOwner|startWatching|stopWatching/)
    // And the wire event is untouched: still replicated, still ringed.
    expect(channelSpec('git:status-update')).toMatchObject({ cls: 'replicated', ring: true })
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
