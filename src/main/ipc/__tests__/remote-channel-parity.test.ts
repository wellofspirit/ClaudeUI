/**
 * @vitest-environment node
 *
 * R5 parity guard — every channel the web api-adapter invokes MUST have a
 * registered remote handler. This prevents the whole class of gap the remote
 * client hit before R5 (git:*, account:get, live watching, multi-engine
 * catalogs, title/commit generation, … all threw "Channel not available").
 *
 * It's a static SOURCE scan on purpose: importing the web api-adapter (browser
 * module) and remote-handlers (full Electron/service graph) into one test would
 * be heavy and fragile. The scan pairs the two source files instead, so a future
 * api-adapter invoke with no matching registration fails CI.
 *
 * Since SyncCore phase 1 the dispatcher denylist is gone: reachability is
 * "registered for the remote transport AND capability ∈ grants". The third test
 * below therefore checks the CAPABILITY each invoked channel declares instead
 * of denylist membership — the capability is what can now silently make a
 * channel unreachable. (The behavioral twin of this file, running against the
 * real registry, is the parity pin in remote-handlers.ipc.test.ts.)
 *
 * Since SyncCore phase 4a there is a matching pin for the OTHER direction — the
 * EVENT surface — in `sync-funnel-guard.test.ts`: every channel the main process
 * emits, and every channel either client subscribes to, must be classified in
 * `src/shared/sync/channels.ts`. The two together cover both halves of the
 * contract: what a client may call, and what a client may be told. The last test
 * here ties the knot so neither pin can be recut without the other in view.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { AUTH_OFF_GRANTS, type Capability } from '../../../core/ipc/command-registry'
import { channelSpec } from '../../../core/shared/sync/channels'

const REPO = process.cwd()
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf-8')

/**
 * Remote channels the web client invokes whose capability is deliberately NOT
 * in the base grant set. Sorted, and kept in sync with the registrations in
 * remote-handlers.ts.
 *
 * Three families, three reasons:
 *  - `shell` (terminal) — reachable only after the step-up ceremony;
 *  - `enroll` / `admin` (ADR-052 passkeys) — reachable only from a passkey or
 *    break-glass-password connection, or (for the two `enroll` verbs) a
 *    one-time enrollment link. A token/tailnet connection never holds either.
 *  - `admin` (ADR-054 §6, `authcfg:*`) — the routine remote-access settings.
 *    Same reachability as the passkey management verbs, PLUS a live
 *    settings-editing session for the mutations (`apply`, `set-password`) and
 *    for the two ADR-056 LAN-channel verbs — `lan-link` is a `query` and is
 *    session-gated anyway, because it hands out a channel key. The `off` master
 *    switch is deliberately not among them: it stays in `remote:set-config`,
 *    which has no remote registration at all.
 *
 * "Invoked but not grantable at connect time" is the POINT for all three, which
 * is why this list is an allowlist rather than an emptiness assertion: a new
 * channel that lands here without a line in this comment is a channel whose
 * reachability nobody thought about.
 */
const UNGRANTED_AT_CONNECT_REMOTE_CHANNELS = [
  'authcfg:apply',
  'authcfg:end',
  'authcfg:get',
  'authcfg:lan-link',
  'authcfg:rotate-lan-key',
  'authcfg:set-password',
  'terminal:attach',
  'terminal:create',
  'terminal:detach',
  'terminal:kill',
  'terminal:pool',
  'webauthn:credentials',
  'webauthn:mint-enroll-token',
  'webauthn:register-options',
  'webauthn:register-verify',
  'webauthn:rename',
  'webauthn:revoke'
]

/** Channels the web client invokes over the WS (connection.invoke / unwrap). */
function invokedChannels(): Set<string> {
  const src = read('src/web/api-adapter.ts')
  const set = new Set<string>()
  const re = /(?:connection\.invoke|unwrap)\(\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) set.add(m[1])
  return set
}

/**
 * remote-handlers.ts, plus every module whose transport-agnostic declarations it
 * SPREADS. A channel registered for both transports from one shared constant
 * (`handleRemote(STREAM_WATCH_COMMAND)`, `for (…of configCommands(manager))`) is
 * still a remote registration; the constants exist precisely so the two surfaces
 * cannot declare it differently, and a scan that only read the inline form would
 * report those channels as missing.
 */
const SHARED_DECLARATION_SOURCES = [
  'src/core/ipc/remote-handlers.ts',
  'src/core/ipc/stream-watch.ts',
  'src/core/ipc/git-watch.ts',
  // S1b — the config/worktree sweep and the automation port.
  'src/core/ipc/config-commands.ts',
  'src/core/ipc/automation-commands.ts',
  // S4 (ADR-057) — the vendor-OAuth / account / native-OAuth family.
  'src/core/ipc/auth-commands.ts'
]

/**
 * The S1b sweep: channel → the ONE declaration both transports must serve it
 * with. Written out rather than derived, because "what capability is this
 * reachable under" is the decision the review gate exists to freeze.
 */
const S1B_SWEEP: Record<string, { capability: Capability; kind: 'command' | 'query' }> = {
  'worktree:create': { capability: 'git', kind: 'command' },
  'worktree:status': { capability: 'git', kind: 'query' },
  'worktree:remove': { capability: 'git', kind: 'command' },
  'worktree:list': { capability: 'git', kind: 'query' },
  'config:save-slash-commands': { capability: 'config', kind: 'command' },
  'config:load-engine-config': { capability: 'config', kind: 'query' },
  'config:save-engine-config': { capability: 'config', kind: 'command' },
  'config:load-vendor-config': { capability: 'config', kind: 'query' },
  'config:save-vendor-config': { capability: 'config', kind: 'command' },
  'config:load-opencode-settings': { capability: 'config', kind: 'query' },
  'config:save-opencode-settings': { capability: 'config', kind: 'command' },
  'config:read-opencode-native-raw': { capability: 'config', kind: 'query' },
  'config:patch-opencode-native': { capability: 'config', kind: 'command' },
  'opencode-agents:list': { capability: 'config', kind: 'query' },
  'opencode-agents:read': { capability: 'config', kind: 'query' },
  'opencode-agents:save': { capability: 'config', kind: 'command' },
  'opencode-agents:delete': { capability: 'config', kind: 'command' },
  'opencode-agents:set-disabled': { capability: 'config', kind: 'command' },
  // Spends model tokens, so `chat` rather than `config`.
  'opencode-agents:generate': { capability: 'chat', kind: 'command' },
  'mcp:toggle': { capability: 'config', kind: 'command' },
  'mcp:reconnect': { capability: 'config', kind: 'command' },
  'mcp:set-servers': { capability: 'config', kind: 'command' },
  'mcp:save-servers': { capability: 'config', kind: 'command' },
  'mcp:remove-server': { capability: 'config', kind: 'command' },
  'mcp:toggle-disabled': { capability: 'config', kind: 'command' },
  'proxy:test-connection': { capability: 'config', kind: 'command' },
  'usage:refresh-prices': { capability: 'config', kind: 'command' },
  'automation:list': { capability: 'config', kind: 'query' },
  'automation:list-runs': { capability: 'config', kind: 'query' },
  'automation:load-run-history': { capability: 'config', kind: 'query' },
  'automation:save': { capability: 'config', kind: 'command' },
  'automation:delete': { capability: 'config', kind: 'command' },
  'automation:toggle': { capability: 'config', kind: 'command' },
  'automation:run-now': { capability: 'config', kind: 'command' },
  'automation:cancel': { capability: 'config', kind: 'command' },
  'automation:send-message': { capability: 'config', kind: 'command' },
  'automation:dismiss-run': { capability: 'config', kind: 'command' }
}

/** channel → declared capability, parsed from remote-handlers.ts registrations. */
function remoteDeclarations(): Map<string, Capability> {
  const src = SHARED_DECLARATION_SOURCES.map(read).join('\n')
  const map = new Map<string, Capability>()
  const re = /channel:\s*['"]([^'"]+)['"],\s*capability:\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(src); m; m = re.exec(src)) map.set(m[1], m[2] as Capability)
  return map
}

describe('remote channel parity (R5)', () => {
  it('the scan actually finds channels (non-vacuity)', () => {
    const invoked = invokedChannels()
    const declared = remoteDeclarations()
    // If a regex broke, these would be empty and the coverage test below would
    // pass vacuously — anchor on channels we know exist.
    expect(invoked.size).toBeGreaterThan(30)
    expect(invoked.has('git:commit')).toBe(true)
    expect(invoked.has('account:get')).toBe(true)
    expect(declared.get('git:commit')).toBe('git')
    expect(declared.size).toBeGreaterThan(50)
  })

  it('every invoked channel has a registered remote handler', () => {
    const invoked = invokedChannels()
    const declared = remoteDeclarations()
    const missing = [...invoked].filter((c) => !declared.has(c)).sort()
    // Surfacing the list makes a regression immediately actionable.
    expect(missing, `api-adapter invokes these with no remote handler: ${missing.join(', ')}`).toEqual(
      []
    )
  })

  it('no invoked channel declares a capability remote connections lack', () => {
    const invoked = invokedChannels()
    const declared = remoteDeclarations()
    const ungranted = [...invoked]
      .filter((c) => declared.has(c) && !AUTH_OFF_GRANTS.has(declared.get(c)!))
      .sort()
    // The terminal and passkey channels are the deliberate exceptions (SyncCore
    // phase 2 / ADR-052): they declare `shell`, `enroll` or `admin`, none of
    // which authentication alone grants. The web client invokes the terminal
    // ones only after `terminal:availability` says the toggle is on and a
    // step-up armed the grant, and the passkey ones only from the settings /
    // enrollment surfaces a qualifying connection reaches — "not grantable at
    // connect time" is the point, not a gap.
    expect(
      ungranted,
      `invoked but not grantable: ${ungranted.map((c) => `${c}(${declared.get(c)})`).join(', ')}`
    ).toEqual(UNGRANTED_AT_CONNECT_REMOTE_CHANNELS)
  })

  it('the S1b sweep is declared ONCE and both transports spread that declaration', () => {
    // The guard the everything-remote ruling needs: a future desktop-only
    // registration must be a DECISION, not drift. Two halves.
    //
    // (1) Each swept channel is declared exactly once, in a shared module, with
    //     the capability/kind this table freezes — and NOT re-declared inline in
    //     either transport registrar, which is the only way the two surfaces
    //     could come to disagree.
    const shared = [
      read('src/core/ipc/config-commands.ts'),
      read('src/core/ipc/automation-commands.ts')
    ].join('\n')
    const declRe = /channel:\s*'([^']+)',\s*capability:\s*'([^']+)',\s*kind:\s*'([^']+)'/g
    const found = new Map<string, { capability: Capability; kind: string }>()
    for (let m = declRe.exec(shared); m; m = declRe.exec(shared)) {
      expect(found.has(m[1]), `${m[1]} is declared twice in the shared modules`).toBe(false)
      found.set(m[1], { capability: m[2] as Capability, kind: m[3] })
    }
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries(Object.entries(S1B_SWEEP).sort())
    )

    const registrars = [
      read('src/core/ipc/session.ipc.ts'),
      read('src/core/ipc/remote-handlers.ts')
    ].join('\n')
    const inline = Object.keys(S1B_SWEEP)
      .filter((c) => registrars.includes(`channel: '${c}'`))
      .sort()
    expect(
      inline,
      `these S1b channels are re-declared inline in a transport registrar: ${inline.join(', ')}`
    ).toEqual([])

    // (2) Both transports actually spread the shared declarations. `handleIpc` on
    //     the desktop side (session.ipc.ts for the config family,
    //     automation.ipc.ts for the automations), `handleRemote` on the other.
    const sessionIpc = read('src/core/ipc/session.ipc.ts')
    const automationIpc = read('src/core/ipc/automation.ipc.ts')
    const remoteHandlers = read('src/core/ipc/remote-handlers.ts')
    expect(sessionIpc).toMatch(
      /for \(const cmd of configCommands\(manager\)\) \{\s*handleIpc\(cmd\)/
    )
    expect(automationIpc).toMatch(/for \(const cmd of AUTOMATION_COMMANDS\) \{\s*handleIpc\(cmd\)/)
    expect(remoteHandlers).toMatch(
      /for \(const cmd of configCommands\(manager\)\) \{\s*handleRemote\(cmd\)/
    )
    expect(remoteHandlers).toMatch(
      /for \(const cmd of AUTOMATION_COMMANDS\) \{\s*handleRemote\(cmd\)/
    )
  })

  it('every S1b channel is remotely reachable with the base grant set', () => {
    // The ruling itself: everything except host-PHYSICAL verbs is changeable
    // from the remote UI. `git`, `config` and `chat` are all in AUTH_OFF_GRANTS,
    // so an ordinary authenticated connection reaches every one of them.
    const declared = remoteDeclarations()
    const missing = Object.keys(S1B_SWEEP).filter((c) => !declared.has(c)).sort()
    expect(missing, `S1b channels with no remote registration: ${missing.join(', ')}`).toEqual([])
    const ungranted = Object.keys(S1B_SWEEP)
      .filter((c) => !AUTH_OFF_GRANTS.has(declared.get(c)!))
      .sort()
    expect(ungranted).toEqual([])
  })

  it('the passkey channels declare enroll/admin, not anything grantable (ADR-052)', () => {
    // Same class of guard as the test above, applied ahead of the series-2 UI:
    // these six ARE registered for the remote transport, so the only thing
    // keeping a plain token connection away from "revoke the operator's passkey"
    // is the declared capability. A future edit that relabels one `config` would
    // otherwise be silent until someone read the diff.
    const declared = remoteDeclarations()
    expect(declared.get('webauthn:register-options')).toBe('enroll')
    expect(declared.get('webauthn:register-verify')).toBe('enroll')
    expect(declared.get('webauthn:credentials')).toBe('admin')
    expect(declared.get('webauthn:rename')).toBe('admin')
    expect(declared.get('webauthn:revoke')).toBe('admin')
    expect(declared.get('webauthn:mint-enroll-token')).toBe('admin')
    for (const [channel, capability] of declared) {
      if (!channel.startsWith('webauthn:')) continue
      expect(AUTH_OFF_GRANTS.has(capability), channel).toBe(false)
    }
  })

  it('the desktop preload wires only the passkey channels that exist there (ADR-052)', () => {
    // The two ceremony verbs are remote-ONLY: the desktop renderer loads from
    // `file://` / the vite dev origin, so it has no RP ID to bind a credential
    // to and `webauthn.ipc.ts` deliberately registers four channels, not six.
    // A preload `ipcRenderer.invoke('webauthn:register-…')` would therefore be
    // an invoke at a channel with no handler — a runtime throw, discovered by
    // whoever pressed the button. The same SOURCE-scan reasoning as the tests
    // above: importing the preload here would need a live Electron.
    const preload = read('src/preload/index.ts')
    const invoked = new Set<string>()
    const re = /ipcRenderer\.invoke\(\s*['"](webauthn:[^'"]+)['"]/g
    for (let m = re.exec(preload); m; m = re.exec(preload)) invoked.add(m[1])

    const ipcSrc = read('src/core/ipc/webauthn.ipc.ts')
    const registered = new Set<string>()
    const regRe = /['"](webauthn:[^'"]+)['"]/g
    for (let m = regRe.exec(ipcSrc); m; m = regRe.exec(ipcSrc)) registered.add(m[1])

    expect([...registered].sort()).toEqual([
      'webauthn:credentials',
      'webauthn:mint-enroll-token',
      'webauthn:rename',
      'webauthn:revoke'
    ])
    expect([...invoked].sort()).toEqual([...registered].sort())
  })

  it('the web client subscribes only to CLASSIFIED event channels (4a)', () => {
    // The invoke surface and the event surface are the two halves of the client
    // contract. A channel the web client listens for that nothing classifies can
    // never arrive, because the funnel is fail-closed — the same class of silent
    // gap this file was written to catch on the invoke side.
    const src = read('src/web/api-adapter.ts')
    const re = /\bon\(\s*['"]([^'"]+)['"]\s*\)/g
    const listened: string[] = []
    for (let m = re.exec(src); m; m = re.exec(src)) listened.push(m[1])
    // SyncCore phase 4c shrank this surface by design: the adapter's replicated
    // subscriptions moved to the shared sync client, so what is left here is
    // host-local only. `sync-funnel-guard.test.ts` owns the full EVENT-surface scan
    // (both clients, plus the typed `SyncEventMap`); this file stays on the invoke
    // half.
    expect(listened.length).toBeGreaterThan(2)
    const unclassified = listened.filter((c) => !channelSpec(c)).sort()
    expect(
      unclassified,
      `api-adapter listens for channels with no entry in shared/sync/channels.ts: ${unclassified.join(', ')}`
    ).toEqual([])
  })
})
