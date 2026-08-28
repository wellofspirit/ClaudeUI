/**
 * Layer 1 unit tests for the web ClaudeAPI adapter.
 *
 * Focus: the git live-watching methods. They used to be `async () => {}`
 * no-ops ("Git polling not supported in remote"), so `gitStatus` in the store
 * stayed null forever and GitChangesPill — which bails on a null status — never
 * rendered on the remote web client at any width. They are now one replace-set
 * verb (`git:watch`, phase 5 S2) which the remote server routes into the shared
 * gitWatchRegistry as this connection'''s interest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createWebSocketApi } from '../api-adapter'
import { SyncClient } from '../../core/shared/sync/sync-client'
import type { RemoteConnection } from '../connection'

type FakeConnection = {
  invoke: ReturnType<typeof vi.fn>
  on: RemoteConnection['on']
  passkeyAvailable: ReturnType<typeof vi.fn>
  stepUpWithPasskey: ReturnType<typeof vi.fn>
  whenCredentialsChanged: ReturnType<typeof vi.fn>
  /** Push a server event to the api's listeners. */
  push: (channel: string, ...args: unknown[]) => void
  /** Fire the close-4008 waiter the password-rotation path races against. */
  closeWithCredentialsChanged: () => void
}

/**
 * Fake transport around the REAL protocol core — the adapter now registers its
 * listeners on the connection's SyncClient, so `push` delivers an event exactly
 * the way a server frame does (readiness gate opened: the app is "mounted").
 */
function makeConnection(): FakeConnection {
  const sync = new SyncClient({ requestResync: () => {} })
  sync.markReady()
  let seq = 0
  const credentialsChangedWaiters: (() => void)[] = []
  return {
    invoke: vi.fn(async () => undefined),
    on: (channel) => sync.on(channel),
    passkeyAvailable: vi.fn(() => false),
    stepUpWithPasskey: vi.fn(async () => ({ type: 'step-up-response', ok: true })),
    whenCredentialsChanged: vi.fn(
      () => new Promise<void>((resolve) => credentialsChangedWaiters.push(resolve))
    ),
    push: (channel, ...args) => sync.receiveEvent({ seq: ++seq, channel, args }),
    closeWithCredentialsChanged: () => {
      for (const resolve of credentialsChangedWaiters.splice(0)) resolve()
    }
  }
}

let connection: FakeConnection
let api: ReturnType<typeof createWebSocketApi>

beforeEach(() => {
  connection = makeConnection()
  api = createWebSocketApi(connection as unknown as RemoteConnection)
})

describe('web api-adapter — git live watching', () => {
  it('watchGit invokes git:watch with the cwd set (GUARD)', async () => {
    await api.watchGit(['/repo/app'])
    expect(connection.invoke).toHaveBeenCalledWith('git:watch', { cwds: ['/repo/app'] })
  })

  it('an empty set is how a client stops watching — there is no stop verb', async () => {
    await api.watchGit([])
    expect(connection.invoke).toHaveBeenCalledWith('git:watch', { cwds: [] })
  })

  it('surfaces a safeHandler error envelope as a rejection', async () => {
    connection.invoke.mockResolvedValueOnce({ ok: false, error: 'not a repo' })
    await expect(api.watchGit(['/repo/app'])).rejects.toThrow('not a repo')
  })

  // The `git:status-update` DELIVERY test moved out of this file with SyncCore
  // phase 4c: the adapter no longer subscribes to replicated channels at all
  // (`shared/sync/client-registry` does, for both clients), so asserting it here
  // would only be re-testing `SyncClient.on`. What remains in this file is the
  // INVOKE surface, which 4c did not touch.
})

describe('web api-adapter — passkeys (ADR-052)', () => {
  it('maps all SIX verbs to their channels (GUARD: this is the only surface with the two register verbs)', async () => {
    await api.webauthnCredentials()
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:credentials')
    await api.webauthnRename('cred-1', 'Phone')
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:rename', 'cred-1', 'Phone')
    await api.webauthnRevoke('cred-1')
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:revoke', 'cred-1')
    await api.webauthnMintEnrollToken()
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:mint-enroll-token')
    await api.webauthnRegisterOptions()
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:register-options')
    const payload = { response: { id: 'c' }, nickname: null } as never
    await api.webauthnRegisterVerify(payload)
    expect(connection.invoke).toHaveBeenCalledWith('webauthn:register-verify', payload)
  })

  it('never unwraps a webauthn result (they are not safeHandler envelopes)', async () => {
    // `webauthn:register-verify` legitimately answers `{ok:false, error}` as
    // DATA. Routing it through `unwrap()` would turn a "that key did not
    // verify" answer into a thrown transport error and lose the reason.
    connection.invoke.mockResolvedValueOnce({ ok: false, error: 'malformed' })
    await expect(api.webauthnRegisterVerify({ response: {} } as never)).resolves.toEqual({
      ok: false,
      error: 'malformed'
    })
  })

  it('merges the client-side passkey hint into terminal availability', async () => {
    connection.invoke.mockResolvedValueOnce({
      allowed: true,
      granted: false,
      needsStepUp: true,
      stepUp: null
    })
    connection.passkeyAvailable.mockReturnValue(true)
    // The host cannot answer this: whether a ceremony is possible depends on
    // this browser's origin and this socket's auth method, neither of which
    // `terminal:availability` knows about.
    await expect(api.terminalAvailability()).resolves.toMatchObject({
      needsStepUp: true,
      passkey: true
    })
  })

  it('passkey step-up goes through the connection, with no local pre-checks', async () => {
    connection.stepUpWithPasskey.mockResolvedValue({
      type: 'step-up-response',
      ok: false,
      code: 'throttled',
      error: 'Too many attempts',
      retryable: false
    })
    await expect(api.terminalStepUpPasskey()).resolves.toEqual({
      ok: false,
      code: 'throttled',
      error: 'Too many attempts',
      retryable: false,
      expiresAt: undefined
    })
    // Unlike the password path, nothing is probed first — the challenge request
    // IS the probe, and guessing client-side could only guess wrong.
    expect(connection.invoke).not.toHaveBeenCalled()
  })
})

describe('web api-adapter — remote-access settings (ADR-054 decision 6)', () => {
  it('READS the config over `authcfg:get`, not the host-anchor channel', async () => {
    // "Routine settings become web-reachable" is unimplementable without a read:
    // a pane cannot administer a surface it cannot render. `authcfg:get` is a
    // QUERY, so it costs no ceremony — the operator sees the tier before being
    // asked to prove presence in order to change it.
    connection.invoke.mockResolvedValueOnce({ stepUpTier: 'strong' })
    await expect(api.getRemoteConfig()).resolves.toMatchObject({ stepUpTier: 'strong' })
    expect(connection.invoke).toHaveBeenCalledWith('authcfg:get')
  })

  it('REFUSES the host-anchor writer locally — it is never on the wire', async () => {
    // `remote:set-config` is the only writer that can reach the `off` master
    // switch and has no remote registration at all. Refusing here (rather than
    // invoking and letting the registry deny it) is what lets the settings pane
    // say WHY, and keeps the structural guarantee visible in this file.
    await expect(api.setRemoteConfig({ authPolicy: 'off' })).rejects.toThrow(/on the host/i)
    await expect(api.setRemotePassword('x')).rejects.toThrow(/Not available in remote mode/)
    await expect(api.clearRemotePassword()).rejects.toThrow(/Not available in remote mode/)
    expect(connection.invoke).not.toHaveBeenCalled()
  })

  it('maps the routine verbs to their channels', async () => {
    // ONE save verb, not one per field (ADR-054 §6 amendment): the editor is a
    // mode, so a Save is a batch.
    connection.invoke.mockResolvedValueOnce({ ok: true, config: { stepUpTier: 'strong' } })
    await api.authcfgApply({ stepUpTier: 'strong', auditRetentionDays: 90 })
    expect(connection.invoke).toHaveBeenCalledWith('authcfg:apply', {
      stepUpTier: 'strong',
      auditRetentionDays: 90
    })
    await api.authcfgEnd()
    expect(connection.invoke).toHaveBeenCalledWith('authcfg:end')
  })

  describe('password rotation — success and disconnection are the same event', () => {
    it('resolves on the normal response (a passkey actor is not disconnected)', async () => {
      connection.invoke.mockResolvedValueOnce({ ok: true })
      await expect(api.authcfgSetPassword('a-long-enough-password')).resolves.toEqual({ ok: true })
      expect(connection.invoke).toHaveBeenCalledWith(
        'authcfg:set-password',
        'a-long-enough-password'
      )
    })

    it('resolves on close-4008 when the ACTOR held the password it rotated', async () => {
      // The server drops every socket holding the old password — the caller
      // included — BEFORE the invoke response goes out. Without the race this
      // would sit out the 30-second invoke timeout on a rotation that worked
      // perfectly, and report a failure for it.
      connection.invoke.mockImplementationOnce(() => new Promise(() => {}))
      const rotating = api.authcfgSetPassword('a-long-enough-password')
      connection.closeWithCredentialsChanged()
      await expect(rotating).resolves.toEqual({ ok: true })
    })

    it('still REJECTS a refused rotation — the close is what never comes', async () => {
      // A dismissed step-up, or a password the server calls too weak: the invoke
      // settles with an error and no socket closes, so the race has one runner.
      connection.invoke.mockRejectedValueOnce(new Error('needs-step-up'))
      await expect(api.authcfgSetPassword('short')).rejects.toThrow('needs-step-up')
    })
  })
})

/**
 * The vendor-OAuth / account / native-OAuth family (ADR-057, S4 + S4-UI).
 *
 * S4 registered all of these on the remote transport, but this adapter still
 * carried the pre-S4 stubs — so the remote UI could not reach a single one of
 * them, and the two WORST stubs failed silently rather than loudly:
 * `vendorAuthSetKey` and `vendorAuthRemove` resolved with `undefined`, so a
 * remote user could "save" an API key that went nowhere. These guards pin the
 * channel names and the safeHandler unwrapping.
 */
describe('web api-adapter — auth / account / vendor-auth reach the remote handlers', () => {
  it('drives the native Claude flow over the wire (the host opens no browser)', async () => {
    connection.invoke.mockResolvedValueOnce({ status: 'authorizing', manualUrl: 'https://x' })
    await expect(api.signIn()).resolves.toMatchObject({ manualUrl: 'https://x' })
    expect(connection.invoke).toHaveBeenCalledWith('auth:sign-in')

    await api.submitOAuthCode('pasted-code')
    expect(connection.invoke).toHaveBeenCalledWith('auth:submit-code', 'pasted-code')

    await api.cancelSignIn()
    expect(connection.invoke).toHaveBeenCalledWith('auth:cancel')
  })

  it('account mutations are real invokes, and addAccount carries pendingSignIn back', async () => {
    connection.invoke.mockResolvedValueOnce({
      enabled: true,
      activeId: 'a1',
      accounts: [],
      pendingSignIn: { status: 'authorizing', account: null, error: null, manualUrl: 'https://m' }
    })
    await expect(api.addAccount()).resolves.toMatchObject({
      pendingSignIn: { manualUrl: 'https://m' }
    })
    expect(connection.invoke).toHaveBeenCalledWith('account:add')

    await api.setMultiAccountEnabled(true)
    expect(connection.invoke).toHaveBeenCalledWith('account:set-enabled', true)
    await api.switchAccount('a2')
    expect(connection.invoke).toHaveBeenCalledWith('account:switch', 'a2')
    await api.deleteAccount('a2')
    expect(connection.invoke).toHaveBeenCalledWith('account:delete', 'a2')
  })

  it('vendor-auth verbs invoke their channels and unwrap the safeHandler envelope', async () => {
    connection.invoke.mockResolvedValueOnce({ ok: true, data: { openai: [{ type: 'oauth' }] } })
    await expect(api.vendorAuthListOptions('pi')).resolves.toEqual({
      openai: [{ type: 'oauth' }]
    })
    expect(connection.invoke).toHaveBeenCalledWith('vendor-auth:list-options', 'pi')

    connection.invoke.mockResolvedValueOnce({ ok: true, data: { url: 'u', method: 'auto' } })
    await api.vendorAuthOauthAuthorize('pi', 'openai-codex', 0)
    expect(connection.invoke).toHaveBeenCalledWith(
      'vendor-auth:oauth-authorize',
      'pi',
      'openai-codex',
      0,
      undefined
    )

    connection.invoke.mockResolvedValueOnce({ ok: true, data: true })
    await expect(
      api.vendorAuthOauthCallback('pi', 'openai-codex', 0, 'http://localhost:1455/cb?code=c')
    ).resolves.toBe(true)
    expect(connection.invoke).toHaveBeenCalledWith(
      'vendor-auth:oauth-callback',
      'pi',
      'openai-codex',
      0,
      'http://localhost:1455/cb?code=c'
    )
  })

  it('a refused vendor-auth mutation now THROWS instead of resolving silently', async () => {
    connection.invoke.mockResolvedValueOnce({ ok: false, error: 'not permitted' })
    await expect(api.vendorAuthSetKey('pi', 'openai', 'sk-x')).rejects.toThrow('not permitted')
    expect(connection.invoke).toHaveBeenCalledWith('vendor-auth:set-key', 'pi', 'openai', 'sk-x')
  })
})

// ---------------------------------------------------------------------------
// Method → channel parity, both directions
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown

/** Call an adapter method by name without widening the ClaudeAPI surface. */
function callMethod(name: string, args: readonly unknown[]): unknown {
  return (api as unknown as Record<string, AnyFn>)[name](...args)
}

/**
 * The FORWARD direction: every wired method, the channel it must reach, and the
 * arguments it must forward — written out rather than derived, because "which
 * channel does this verb speak" is precisely the fact that drifted.
 *
 * The config/agent half of this table is the drift that made it necessary. Those
 * channels have been registered for both transports since the everything-remote
 * ruling (`core/ipc/config-commands.ts`, `capability: 'config'`), but the adapter
 * still answered them with `async () => {}` — so on the web client every
 * engine-config-backed settings pane rendered and then resolved a save that went
 * nowhere. A stub cannot be spotted at the call site; this table can.
 */
const WIRED: ReadonlyArray<{ method: string; channel: string; args: readonly unknown[] }> = [
  // Engine / vendor config (plain handlers — preload uses a bare invoke here).
  { method: 'loadEngineConfig', channel: 'config:load-engine-config', args: ['opencode'] },
  {
    method: 'saveEngineConfig',
    channel: 'config:save-engine-config',
    args: ['opencode', { autoMode: { enabled: true } }]
  },
  { method: 'loadVendorConfig', channel: 'config:load-vendor-config', args: ['anthropic'] },
  {
    method: 'saveVendorConfig',
    channel: 'config:save-vendor-config',
    args: ['anthropic', { endpoint: { baseUrl: 'https://x' } }]
  },
  // opencode engine-native settings + the raw (schema-driven) pair.
  { method: 'loadOpencodeSettings', channel: 'config:load-opencode-settings', args: [] },
  {
    method: 'saveOpencodeSettings',
    channel: 'config:save-opencode-settings',
    args: [{ theme: 'dark' }]
  },
  { method: 'readOpencodeNativeRaw', channel: 'config:read-opencode-native-raw', args: [] },
  {
    method: 'patchOpencodeNative',
    channel: 'config:patch-opencode-native',
    args: [[{ path: ['model'], value: 'anthropic/x' }]]
  },
  // pi's raw trio — the in-file precedent this pass extended to its neighbours.
  { method: 'readPiNativeRaw', channel: 'config:read-pi-native-raw', args: [] },
  {
    method: 'patchPiNative',
    channel: 'config:patch-pi-native',
    args: [[{ path: ['thinking'], value: 'high' }]]
  },
  { method: 'writePiNativeText', channel: 'config:write-pi-native-text', args: ['{}\n'] },
  // pi's models.json pair — the same raw shape for the model catalog file.
  { method: 'readPiModelsRaw', channel: 'config:read-pi-models-raw', args: [] },
  {
    method: 'patchPiModels',
    channel: 'config:patch-pi-models',
    args: [[{ path: ['providers', 'my-api', 'models', 0, 'contextWindow'], value: 200_000 }]]
  },
  // opencode agent CRUD — five `config` verbs plus one `chat` verb.
  { method: 'listOpencodeAgents', channel: 'opencode-agents:list', args: ['/repo/app'] },
  {
    method: 'readOpencodeAgent',
    channel: 'opencode-agents:read',
    args: ['reviewer', 'global', '/repo/app']
  },
  {
    method: 'saveOpencodeAgent',
    channel: 'opencode-agents:save',
    args: [{ name: 'reviewer', scope: 'global' }, '/repo/app']
  },
  {
    method: 'deleteOpencodeAgent',
    channel: 'opencode-agents:delete',
    args: ['reviewer', 'project', '/repo/app']
  },
  {
    method: 'setOpencodeAgentDisabled',
    channel: 'opencode-agents:set-disabled',
    args: ['reviewer', 'global', '/repo/app', true]
  },
  {
    method: 'generateOpencodeAgent',
    channel: 'opencode-agents:generate',
    args: ['an agent that reviews diffs', '/repo/app']
  },
  // Engine-routed per-vendor auth (S4, ADR-057) — the other block that used to
  // be stubbed here, kept in the table so the two cannot regress separately.
  { method: 'vendorAuthProbe', channel: 'vendor-auth:probe', args: ['opencode'] },
  { method: 'vendorAuthListOptions', channel: 'vendor-auth:list-options', args: ['pi'] },
  { method: 'vendorAuthListKeys', channel: 'vendor-auth:list-keys', args: ['pi'] },
  { method: 'vendorAuthSetKey', channel: 'vendor-auth:set-key', args: ['pi', 'openai', 'sk-x'] },
  {
    method: 'vendorAuthOauthAuthorize',
    channel: 'vendor-auth:oauth-authorize',
    args: ['pi', 'openai-codex', 0, { team: 'x' }]
  },
  {
    method: 'vendorAuthOauthCallback',
    channel: 'vendor-auth:oauth-callback',
    args: ['pi', 'openai-codex', 0, 'code-1']
  },
  { method: 'vendorAuthRemove', channel: 'vendor-auth:remove', args: ['pi', 'openai'] },
  { method: 'vendorAuthOauthCancel', channel: 'vendor-auth:oauth-cancel', args: ['pi'] }
]

describe('web api-adapter — wired methods reach the channel they claim', () => {
  it.each(WIRED)('$method → $channel', async ({ method, channel, args }) => {
    await callMethod(method, args)
    expect(connection.invoke).toHaveBeenCalledWith(channel, ...args)
  })

  it('the config/agent SAVES surface a refusal instead of resolving (GUARD)', async () => {
    // The half of the drift that mattered most: a stubbed mutation resolved
    // `undefined`, so a denied or failed save looked identical to a successful
    // one. Every one of these is safeHandler-wrapped server-side, so the envelope
    // is what carries the reason back.
    const mutations = WIRED.filter(({ method }) =>
      [
        'saveOpencodeSettings',
        'patchOpencodeNative',
        'saveOpencodeAgent',
        'deleteOpencodeAgent',
        'setOpencodeAgentDisabled',
        'generateOpencodeAgent'
      ].includes(method)
    )
    expect(mutations).toHaveLength(6)
    for (const { method, args } of mutations) {
      connection.invoke.mockResolvedValueOnce({ ok: false, error: 'permission denied' })
      await expect(callMethod(method, args)).rejects.toThrow('permission denied')
    }
  })

  it('the four engine/vendor channels are NOT unwrapped — their handlers are plain', async () => {
    // `config:load-engine-config` and its three siblings are the only members of
    // this family registered without `safeHandler`, so their reply is the config
    // object itself. Routing them through `unwrap()` would be harmless only for
    // as long as no config gains an `ok` field; mirroring preload keeps that
    // accident impossible.
    connection.invoke.mockResolvedValueOnce({ ok: true, autoMode: { enabled: false } })
    await expect(api.loadEngineConfig('opencode')).resolves.toEqual({
      ok: true,
      autoMode: { enabled: false }
    })
  })
})

/**
 * The REVERSE direction: everything the adapter answers WITHOUT the connection.
 *
 * Membership here is a decision, not an accident — a stub is invisible at the
 * call site, which is exactly how the config family stayed inert for a whole
 * release cycle. Adding a method that never touches the wire fails this test
 * until someone writes down why, and wiring one that used to be local fails it
 * until the row comes out.
 *
 * Each reason says WHICH of two very different things a stub is:
 *
 *  - **No channel to invoke.** The desktop verb is a raw `ipcMain.handle` (or a
 *    `host`-capability registration) with no remote twin, so a stub is the only
 *    possible answer. Nothing to decide.
 *  - **Registered, unwired.** The channel IS declared for both transports, so
 *    the client could reach it and chooses not to. That is a live question, and
 *    {@link UNWIRED} spells the channel out so the next reader can weigh it
 *    instead of assuming, as the config family was assumed, that no twin exists.
 */

/** Channel exists on both transports; this client answers locally anyway. */
const UNWIRED = (channel: string, capability: string, note: string): string =>
  `REGISTERED on both transports (\`${channel}\`, \`${capability}\`) but unwired here — ${note}`

const HOST_PHYSICAL =
  'host-physical (dialog/window/native shell) — capability `host`, no remote registration'
const NO_REMOTE_CHANNEL = 'no remote registration at all — desktop-only `ipcMain.handle`'
const DESKTOP_ANCHOR_ONLY =
  'no remote registration: a remote client must never reconfigure the transport it rides (ADR-042/054)'
const QUIT_HANDSHAKE =
  'no remote registration — the quit handshake is the host shell talking to itself'
const VOICE_SERVER_VERBS =
  'no remote registration; starting cli.js’s transcription server is `voice:start`’s business'
const NO_MAIN_LOG_FILE =
  'a `log:*` send, not an invoke — no main-process log file here, so both relays hit the console'
/** The pre-existing desktop-first stubs the everything-remote ruling outran. */
const WRITE_HALF_UNREVIEWED = 'the stub predates that registration and has not been re-reviewed'

const NOT_ON_THE_WIRE: Readonly<Record<string, string>> = {
  pickFolder: HOST_PHYSICAL,
  openInVSCode: HOST_PHYSICAL,
  minimizeWindow: HOST_PHYSICAL,
  maximizeWindow: HOST_PHYSICAL,
  closeWindow: HOST_PHYSICAL,
  confirmQuit: QUIT_HANDSHAKE,
  cancelQuit: QUIT_HANDSHAKE,
  acquireSyncPort:
    'no port to acquire — the connection installed its sync client before `window.api` existed (web/main.tsx)',
  killTerminalsByCwd:
    'no remote registration: the cold-session sweep is off the remote surface so a web client never mass-kills the operator’s shells',
  createWorktree: UNWIRED('worktree:create', 'git', WRITE_HALF_UNREVIEWED),
  getWorktreeStatus: UNWIRED('worktree:status', 'git', WRITE_HALF_UNREVIEWED),
  removeWorktree: UNWIRED('worktree:remove', 'git', WRITE_HALF_UNREVIEWED),
  listWorktrees: UNWIRED('worktree:list', 'git', WRITE_HALF_UNREVIEWED),
  getSentFilePreview:
    'real client-side implementation: the src IS an authenticated same-origin /sent-file URL, so no RPC',
  getMockupPreviewUrl:
    'real client-side implementation: a same-origin URL built from `__MOCKUP_TOKEN__`',
  saveSlashCommands: UNWIRED('config:save-slash-commands', 'config', WRITE_HALF_UNREVIEWED),
  mcpToggleServer: UNWIRED('mcp:toggle', 'config', WRITE_HALF_UNREVIEWED),
  mcpReconnectServer: UNWIRED('mcp:reconnect', 'config', WRITE_HALF_UNREVIEWED),
  // The worst shape in this table: it resolves an empty SUCCESS result, so a
  // remote caller cannot tell the write from a no-op.
  mcpSetServers: UNWIRED('mcp:set-servers', 'config', WRITE_HALF_UNREVIEWED),
  saveMcpServers: UNWIRED('mcp:save-servers', 'config', WRITE_HALF_UNREVIEWED),
  removeMcpServer: UNWIRED('mcp:remove-server', 'config', WRITE_HALF_UNREVIEWED),
  mcpToggleDisabled: UNWIRED('mcp:toggle-disabled', 'config', WRITE_HALF_UNREVIEWED),
  // These seven at least REFUSE (one shared rejecting function) rather than
  // resolving, so the pane can say so — the refusal copy is now the stale part.
  saveSharedProvider: UNWIRED('shared-provider:save', 'config', WRITE_HALF_UNREVIEWED),
  removeSharedProvider: UNWIRED('shared-provider:remove', 'config', WRITE_HALF_UNREVIEWED),
  setSharedProviderRoute: UNWIRED('shared-provider:set-route', 'config', WRITE_HALF_UNREVIEWED),
  setSharedProviderApiKey: UNWIRED('shared-provider:set-key', 'config', WRITE_HALF_UNREVIEWED),
  syncSharedProvider: UNWIRED('shared-provider:sync', 'config', WRITE_HALF_UNREVIEWED),
  disconnectSharedProvider: UNWIRED('shared-provider:disconnect', 'config', WRITE_HALF_UNREVIEWED),
  setSharedProviderDefaultModel: UNWIRED(
    'shared-provider:set-default',
    'config',
    WRITE_HALF_UNREVIEWED
  ),
  listAutomations: UNWIRED('automation:list', 'config', WRITE_HALF_UNREVIEWED),
  saveAutomation: UNWIRED('automation:save', 'config', WRITE_HALF_UNREVIEWED),
  deleteAutomation: UNWIRED('automation:delete', 'config', WRITE_HALF_UNREVIEWED),
  runAutomationNow: UNWIRED('automation:run-now', 'config', WRITE_HALF_UNREVIEWED),
  toggleAutomation: UNWIRED('automation:toggle', 'config', WRITE_HALF_UNREVIEWED),
  listAutomationRuns: UNWIRED('automation:list-runs', 'config', WRITE_HALF_UNREVIEWED),
  loadAutomationRunHistory: UNWIRED('automation:load-run-history', 'config', WRITE_HALF_UNREVIEWED),
  cancelAutomationRun: UNWIRED('automation:cancel', 'config', WRITE_HALF_UNREVIEWED),
  dismissAutomationRun: UNWIRED('automation:dismiss-run', 'config', WRITE_HALF_UNREVIEWED),
  sendAutomationMessage: UNWIRED('automation:send-message', 'config', WRITE_HALF_UNREVIEWED),
  getNetworkInterfaces: DESKTOP_ANCHOR_ONLY,
  startRemoteServer: DESKTOP_ANCHOR_ONLY,
  stopRemoteServer: DESKTOP_ANCHOR_ONLY,
  getRemoteStatus: DESKTOP_ANCHOR_ONLY,
  onRemoteStatus: DESKTOP_ANCHOR_ONLY,
  setRemoteConfig:
    'no remote registration: the only writer that can reach the `off` master switch, so refusing locally is what lets the pane say why',
  setRemotePassword: DESKTOP_ANCHOR_ONLY,
  clearRemotePassword: DESKTOP_ANCHOR_ONLY,
  detectTailscale: DESKTOP_ANCHOR_ONLY,
  forceReserve: DESKTOP_ANCHOR_ONLY,
  voiceStartServer: VOICE_SERVER_VERBS,
  voiceStopServer: VOICE_SERVER_VERBS,
  logError: NO_MAIN_LOG_FILE,
  logRelay: NO_MAIN_LOG_FILE,
  openLogViewer: NO_REMOTE_CHANNEL,
  listPlugins: NO_REMOTE_CHANNEL,
  reloadPlugin: NO_REMOTE_CHANNEL,
  getPluginViews: NO_REMOTE_CHANNEL,
  getPluginPreloadPath: NO_REMOTE_CHANNEL,
  onPluginViewsChanged: NO_REMOTE_CHANNEL,
  testProxyConnection: UNWIRED(
    'proxy:test-connection',
    'config',
    'a probe of the host’s egress rather than a setting, so the stub costs a refusal, not an edit'
  ),
  refreshPrices: UNWIRED(
    'usage:refresh-prices',
    'config',
    'refreshes a host-side price cache rather than anything the user typed'
  )
}

describe('web api-adapter — the local surface is an explicit list', () => {
  /**
   * A member is ON THE WIRE if its body reaches the connection (directly, or
   * through this module's `unwrap` helper), or if it IS a connection listener —
   * `on(channel)` returns the SyncClient's registrar, so those share one source
   * string that the probe below captures rather than hard-codes.
   */
  function localSurface(): string[] {
    const probe = makeConnection()
    const listenerSource = (probe.on('probe:channel') as unknown as AnyFn).toString()
    return Object.entries(api as unknown as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'function')
      .filter(([, value]) => {
        const source = (value as AnyFn).toString()
        if (source === listenerSource) return false
        return !/\bconnection\./.test(source) && !/\bunwrap\(/.test(source)
      })
      .map(([name]) => name)
      .sort()
  }

  it('the classifier actually separates the two halves (non-vacuity)', () => {
    const local = new Set(localSurface())
    // Wired through `connection.invoke`, through `unwrap`, and through `on()`.
    expect(local.has('gitCommit')).toBe(false)
    expect(local.has('loadEngineConfig')).toBe(false)
    expect(local.has('readPiNativeRaw')).toBe(false)
    expect(local.has('onVoiceState')).toBe(false)
    expect(local.size).toBeGreaterThan(20)
  })

  it('every method that never touches the connection is listed with a reason', () => {
    expect(localSurface()).toEqual(Object.keys(NOT_ON_THE_WIRE).sort())
    for (const [name, reason] of Object.entries(NOT_ON_THE_WIRE)) {
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(20)
    }
  })
})
