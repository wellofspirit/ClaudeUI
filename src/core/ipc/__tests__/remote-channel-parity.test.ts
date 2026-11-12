/**
 * @vitest-environment node
 *
 * R5 parity guard — every channel the web api-adapter invokes MUST have a
 * registered remote handler. This prevents the whole class of gap the remote
 * client hit before R5 (git:*, account:get, live watching, multi-engine
 * catalogs, title/commit generation, … all threw "Channel not available").
 *
 * The web-client and desktop sides are static SOURCE scans on purpose: importing
 * the web api-adapter (browser module) into this test would be heavy and fragile.
 * The remote side is the checked-in dump of the static remote surface
 * (remote-surface.jsonl), which remote-handlers.ipc.test.ts holds equal to the
 * live registry, so a future api-adapter invoke with no matching registration
 * fails CI.
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
import { AUTH_OFF_GRANTS, type Capability } from '../command-registry'
import { readRemoteSurface } from '../../../test/helpers/remote-surface'
import { channelSpec } from '../../shared/sync/channels'
import {
  API_EVENTS,
  API_INVOKES,
  DESKTOP_INVOKES,
  type InvokeEntry
} from '../../../shared/api-invoke-table'

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
 *  - `ide` (ADR-064) — the remote VS Code mint. The `shell` shape on its own
 *    toggle: no static grant set holds it, the step-up ceremony arms it iff
 *    `allow_ide` is on, and toggle-off revokes it in place. Its sibling
 *    `ide:availability` is deliberately ABSENT from this list — it declares
 *    `config`, because asking "may I?" must be answerable without the grant.
 *  - `admin` (ADR-082 §7, `harness:*` writes) — choosing a harness's source,
 *    installing one into the host's store, cancelling an install, running
 *    detection, and the update commands (§6: the update mode, Update all,
 *    Check now), and the upgrade sheet's answer (§8). Putting a program on the host from a phone is close to remote
 *    code execution, so a base connection only SEES the Installed page:
 *    `harness:state` and `harness:versions` declare `config` and are absent here.
 *  - `admin` (ADR-101 §6, `voice:pack-*` writes) — installing the on-device speech
 *    pack (native code and 650 MB on the host), cancelling that install, and
 *    removing the pack (which takes voice from every client of the host). The
 *    sibling `voice:pack-status` declares `chat`, because every connection that
 *    can hold the mic can hit the wall and must be able to read it, so it is
 *    absent here.
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
  'harness:answer-upgrade-prompt',
  'harness:check-updates',
  'harness:detect',
  'harness:install',
  'harness:install-cancel',
  'harness:set-selection',
  'harness:set-update-mode',
  'harness:update-all',
  'ide:mint-entry',
  'terminal:attach',
  'terminal:create',
  'terminal:detach',
  'terminal:kill',
  'terminal:pool',
  'voice:pack-install',
  'voice:pack-install-cancel',
  'voice:pack-remove',
  'webauthn:credentials',
  'webauthn:mint-enroll-token',
  'webauthn:register-options',
  'webauthn:register-verify',
  'webauthn:rename',
  'webauthn:revoke'
]

/** The channels a table's members invoke. */
const channelsOf = (table: Record<string, InvokeEntry>): string[] =>
  Object.values(table).map((entry) => entry.channel)

/** Scan one client source file for the channels its remaining hand-written members use. */
function scanChannels(rel: string, call: RegExp): string[] {
  const src = read(rel)
  const found: string[] = []
  for (let m = call.exec(src); m; m = call.exec(src)) found.push(m[1])
  return found
}

/**
 * Channels the web client invokes over the WS: every `API_INVOKES` member (built over
 * `connection.invoke`, see `shared/api-invoke-table.ts`) plus the members the adapter still
 * writes out itself (connection.invoke / unwrap).
 */
function invokedChannels(): Set<string> {
  return new Set([
    ...channelsOf(API_INVOKES),
    ...scanChannels('src/web/api-adapter.ts', /(?:connection\.invoke|unwrap)\(\s*['"]([^'"]+)['"]/g)
  ])
}

/** Channels the desktop preload invokes: both invoke tables plus its hand-written members. */
function preloadInvokedChannels(): Set<string> {
  return new Set([
    ...channelsOf(API_INVOKES),
    ...channelsOf(DESKTOP_INVOKES),
    ...scanChannels('src/preload/index.ts', /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)
  ])
}

/**
 * The redacted status read: the one `remote:*` channel on the remote surface.
 *
 * ONE channel, and the reason it is worth its own table is the namespace it
 * lives in: `remote:*` is otherwise host-anchor-only by construction, so this is
 * the single exception and it must read as the decision it is. A `query`, and
 * `config` rather than `admin` because it carries no credential, no key and no
 * configuration write — the redaction (`shared/types.ts` → `RemoteStatusView`)
 * is what makes that true, and `remote-view-commands.test.ts` pins it.
 */
const REMOTE_VIEW_SWEEP: Record<string, { capability: Capability; kind: 'command' | 'query' }> = {
  'remote:status-view': { capability: 'config', kind: 'query' }
}

/**
 * ADR-065 phase 6 — the unified provider list, declared in
 * `ipc/auth-commands.ts` beside the `shared-provider:*` family whose stores it
 * reads.
 *
 * Its own table, for the reason {@link REMOTE_VIEW_SWEEP} has one. `config` and
 * a `query` — it composes the shared definitions, opencode's provider catalog
 * and pi's vendor entries into one row set and returns counts, badges and chips;
 * no key material crosses it, and every mutation the rows drive is an EXISTING
 * channel already on this surface. Being on both transports from one declaration
 * is the point: the phone's provider page must read the same list the desktop
 * does.
 */
const PROVIDER_REGISTRY_SWEEP: Record<
  string,
  { capability: Capability; kind: 'command' | 'query' }
> = {
  'provider-registry:list': { capability: 'config', kind: 'query' }
}

/**
 * ADR-068 §2 — the subscription ACCOUNTS family, declared beside the provider
 * registry it feeds.
 *
 * Its own table for the same reason that one has one. All `config`: the account
 * list is provider configuration, it carries no key material, and the phone must
 * be able to switch which account the host bills.
 */
const PROVIDER_ACCOUNT_SWEEP: Record<
  string,
  { capability: Capability; kind: 'command' | 'query' }
> = {
  'provider-account:list': { capability: 'config', kind: 'query' },
  'provider-account:switch': { capability: 'config', kind: 'command' },
  'provider-account:remove': { capability: 'config', kind: 'command' }
}

/** channel → declared capability, read from the checked-in remote surface dump. */
function remoteDeclarations(): Map<string, Capability> {
  return new Map(readRemoteSurface().map((e) => [e.channel, e.capability]))
}

/** Every channel the two shared config modules declare, read from their source. */
function sharedConfigDeclarations(): Map<string, { capability: Capability; kind: string }> {
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
  // A scan that found nothing would pass every per-channel check below.
  expect(found.size).toBeGreaterThanOrEqual(50)
  for (const anchor of ['automation:save', 'config:save-engine-config', 'worktree:create']) {
    expect(found.has(anchor), `${anchor} not found in the shared modules`).toBe(true)
  }
  return found
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
    expect(
      missing,
      `api-adapter invokes these with no remote handler: ${missing.join(', ')}`
    ).toEqual([])
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
    // (1) Each channel the shared modules declare is declared exactly once there,
    //     is on the remote surface with the same capability/kind (the checked-in
    //     dump), and is NOT re-declared inline in either transport registrar,
    //     which is the only way the two surfaces could come to disagree.
    const found = sharedConfigDeclarations()
    const dump = new Map(readRemoteSurface().map((e) => [e.channel, e]))
    for (const [channel, decl] of found) {
      expect(
        { capability: dump.get(channel)?.capability, kind: dump.get(channel)?.kind },
        `${channel}: the dump must record what the shared module declares`
      ).toEqual(decl)
    }

    const registrars = [
      read('src/core/ipc/session.ipc.ts'),
      read('src/core/ipc/remote-handlers.ts')
    ].join('\n')
    const inline = [...found.keys()].filter((c) => registrars.includes(`channel: '${c}'`)).sort()
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
    const found = [...sharedConfigDeclarations().keys()]
    const missing = found.filter((c) => !declared.has(c)).sort()
    expect(missing, `S1b channels with no remote registration: ${missing.join(', ')}`).toEqual([])
    const ungranted = found.filter((c) => !AUTH_OFF_GRANTS.has(declared.get(c)!)).sort()
    expect(ungranted).toEqual([])
  })

  it('the status view is declared ONCE, spread by both transports, and is the only remote:* channel', () => {
    // Same two halves as the S1b case above, applied to the one channel that
    // widens the `remote:*` namespace (owner ruling, 2026-08-28).
    const shared = read('src/core/ipc/remote-view-commands.ts')
    const declRe = /channel:\s*'([^']+)',\s*capability:\s*'([^']+)',\s*kind:\s*'([^']+)'/g
    const found = new Map<string, { capability: Capability; kind: string }>()
    for (let m = declRe.exec(shared); m; m = declRe.exec(shared)) {
      found.set(m[1], { capability: m[2] as Capability, kind: m[3] })
    }
    expect(Object.fromEntries(found)).toEqual(REMOTE_VIEW_SWEEP)

    // Both transports spread it: `registerRemoteViewIpc` (desktop, called from
    // core-services once the server exists) and `registerRemoteHandlers`.
    expect(shared).toMatch(/for \(const cmd of remoteViewCommands\(host\)\) handleIpc\(cmd\)/)
    expect(read('src/core/ipc/remote-handlers.ts')).toMatch(
      /for \(const cmd of remoteViewCommands\(enrollTokens \?\? null\)\) \{\s*handleRemote\(cmd\)/
    )

    // And it is the ONLY `remote:*` channel any shared declaration or transport
    // registrar contributes. The mutations — start/stop/set-config/set-password/
    // clear-password/force-reserve — are raw `ipcMain.handle` on the host anchor
    // with no registration at all, which is what stops a remote client cutting
    // the connection it is riding. Structural, not a hidden button.
    const declared = remoteDeclarations()
    expect([...declared.keys()].filter((c) => c.startsWith('remote:'))).toEqual([
      'remote:status-view'
    ])
  })

  it('the provider registry is declared ONCE in the shared auth family and is base-reachable', () => {
    // Same two halves as the S1b case: declared exactly once in the shared
    // module with the capability/kind this table freezes, never re-declared
    // inline in a transport registrar — and reachable on the base grant set, so
    // the remote provider page is not a desktop-only surface by omission.
    const shared = read('src/core/ipc/auth-commands.ts')
    const declRe = /channel:\s*'([^']+)',\s*capability:\s*'([^']+)',\s*kind:\s*'([^']+)'/g
    const found = new Map<string, { capability: Capability; kind: string }>()
    for (let m = declRe.exec(shared); m; m = declRe.exec(shared)) {
      if (!(m[1] in PROVIDER_REGISTRY_SWEEP)) continue
      expect(found.has(m[1]), `${m[1]} is declared twice in auth-commands.ts`).toBe(false)
      found.set(m[1], { capability: m[2] as Capability, kind: m[3] })
    }
    expect(Object.fromEntries(found)).toEqual(PROVIDER_REGISTRY_SWEEP)

    const registrars = [
      read('src/core/ipc/session.ipc.ts'),
      read('src/core/ipc/remote-handlers.ts')
    ].join('\n')
    const inline = Object.keys(PROVIDER_REGISTRY_SWEEP).filter((c) =>
      registrars.includes(`channel: '${c}'`)
    )
    expect(inline, `re-declared inline in a transport registrar: ${inline.join(', ')}`).toEqual([])

    const declared = remoteDeclarations()
    for (const channel of Object.keys(PROVIDER_REGISTRY_SWEEP)) {
      expect(declared.get(channel), `${channel} has no remote registration`).toBe('config')
      expect(AUTH_OFF_GRANTS.has(declared.get(channel)!)).toBe(true)
    }
  })

  it('the provider ACCOUNT family is declared once, base-reachable, and on both transports', () => {
    // The registry test above, applied to ADR-068's four: same shared module,
    // same `config` reachability, and never re-declared inline — a second
    // declaration in one registrar is how the desktop and the phone would end up
    // with different rules for switching the billed account.
    const shared = read('src/core/ipc/auth-commands.ts')
    const declRe = /channel:\s*'([^']+)',\s*capability:\s*'([^']+)',\s*kind:\s*'([^']+)'/g
    const found = new Map<string, { capability: Capability; kind: string }>()
    for (let m = declRe.exec(shared); m; m = declRe.exec(shared)) {
      if (!(m[1] in PROVIDER_ACCOUNT_SWEEP)) continue
      expect(found.has(m[1]), `${m[1]} is declared twice in auth-commands.ts`).toBe(false)
      found.set(m[1], { capability: m[2] as Capability, kind: m[3] })
    }
    expect(Object.fromEntries(found)).toEqual(PROVIDER_ACCOUNT_SWEEP)

    const registrars = [
      read('src/core/ipc/session.ipc.ts'),
      read('src/core/ipc/remote-handlers.ts')
    ].join('\n')
    const inline = Object.keys(PROVIDER_ACCOUNT_SWEEP).filter((c) =>
      registrars.includes(`channel: '${c}'`)
    )
    expect(inline, `re-declared inline in a transport registrar: ${inline.join(', ')}`).toEqual([])

    const declared = remoteDeclarations()
    for (const channel of Object.keys(PROVIDER_ACCOUNT_SWEEP)) {
      expect(declared.get(channel), `${channel} has no remote registration`).toBe('config')
      expect(AUTH_OFF_GRANTS.has(declared.get(channel)!)).toBe(true)
    }
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
    const invoked = new Set([...preloadInvokedChannels()].filter((c) => c.startsWith('webauthn:')))

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

  it('the speech pack verbs reach exactly the declared channels on BOTH clients (ADR-101 section 6)', () => {
    // The desktop preload, the web adapter and the test helper all build these from
    // `API_INVOKES`, mirroring `voice-pack-commands.ts`; a verb that drifted would invoke
    // a channel with no handler, discovered by whoever pressed Download.
    const declared = new Set<string>()
    const declRe = /channel:\s*['"](voice:pack-[^'"]+)['"]/g
    const commands = read('src/core/ipc/voice-pack-commands.ts')
    for (let m = declRe.exec(commands); m; m = declRe.exec(commands)) declared.add(m[1])
    expect([...declared].sort()).toEqual([
      'voice:pack-install',
      'voice:pack-install-cancel',
      'voice:pack-remove',
      'voice:pack-status'
    ])

    const packChannels = (channels: Iterable<string>): string[] =>
      [...new Set(channels)].filter((c) => c.startsWith('voice:pack-')).sort()
    expect(packChannels(preloadInvokedChannels())).toEqual([...declared].sort())
    expect(packChannels(invokedChannels())).toEqual([...declared].sort())
    // All three clients (the test helper's copy must not lag the real one) take the pass-through
    // members from the one table, so they cannot disagree about it.
    for (const file of [
      'src/preload/index.ts',
      'src/web/api-adapter.ts',
      'src/test/helpers/boot-test-app.ts'
    ]) {
      expect(read(file), file).toMatch(/buildInvokeApi\(API_INVOKES,/)
    }
  })

  it('both clients pass the preview choice through as the start verb third argument', () => {
    // The desktop side (preload and test helper) is one `DESKTOP_INVOKES` entry: all three
    // positional args ride the wire unshaped, the envelope unwrapped.
    expect(DESKTOP_INVOKES.voiceStart).toMatchObject({
      channel: 'voice:start-recording',
      arity: 3,
      mode: 'unwrap'
    })
    expect('wire' in DESKTOP_INVOKES.voiceStart).toBe(false)
    for (const file of ['src/preload/index.ts', 'src/test/helpers/boot-test-app.ts']) {
      expect(read(file), file).toMatch(/buildInvokeApi\(DESKTOP_INVOKES,/)
    }
    expect(read('src/web/api-adapter.ts')).toMatch(
      /connection\.invoke\('voice:start', routingId, language, opts\)/
    )
  })

  it('every table invoke is registered for BOTH transports (desktop ipcMain and remote)', () => {
    // A table member whose channel is bound on only one transport is the same silent gap as an
    // adapter invoke with no remote handler, but for the desktop: the preload would invoke a
    // channel nobody handles. The declaration sources are the registrars plus every shared
    // `*-commands` module both of them spread, so moving a declaration between those modules
    // cannot make this vacuous or fail it.
    const ipcDir = 'src/core/ipc'
    const shared = fs
      .readdirSync(path.join(REPO, ipcDir))
      .filter((f) => /-commands\.ts$/.test(f) || /^(stream-watch|git-watch)\.ts$/.test(f))
      .map((f) => `${ipcDir}/${f}`)
    const channelsDeclaredIn = (files: string[]): Set<string> => {
      const found = new Set<string>()
      for (const file of files) {
        const src = read(file)
        for (const re of [
          /channel:\s*['"]([^'"]+)['"]/g,
          /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g
        ]) {
          for (let m = re.exec(src); m; m = re.exec(src)) found.add(m[1])
        }
      }
      return found
    }
    const ownIpc = ['authcfg', 'terminal', 'webauthn'].map((n) => `${ipcDir}/${n}.ipc.ts`)
    const desktop = channelsDeclaredIn([
      `${ipcDir}/session.ipc.ts`,
      ...ownIpc,
      'src/main/index.ts',
      ...shared
    ])
    // The remote half is the checked-in dump of the static remote surface.
    const remote = new Set(readRemoteSurface().map((e) => e.channel))
    // Non-vacuity: a scan that found nothing would pass the checks below.
    expect(desktop.size).toBeGreaterThan(100)
    expect(remote.size).toBeGreaterThan(100)
    const channels = channelsOf(API_INVOKES)
    expect(channels.length).toBeGreaterThan(200)
    expect(
      channels.filter((c) => !desktop.has(c)),
      'table invokes with no desktop registration'
    ).toEqual([])
    expect(
      channels.filter((c) => !remote.has(c)),
      'table invokes with no remote registration'
    ).toEqual([])
  })

  it('the web client subscribes only to CLASSIFIED event channels (4a)', () => {
    // The invoke surface and the event surface are the two halves of the client
    // contract. A channel the web client listens for that nothing classifies can
    // never arrive, because the funnel is fail-closed — the same class of silent
    // gap this file was written to catch on the invoke side.
    // The web client's subscriptions are the `API_EVENTS` table (built over `connection.on`)
    // plus any `on('…')` the adapter still writes out.
    const listened: string[] = [
      ...Object.values(API_EVENTS),
      ...scanChannels('src/web/api-adapter.ts', /\bon\(\s*['"]([^'"]+)['"]\s*\)/g)
    ]
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
