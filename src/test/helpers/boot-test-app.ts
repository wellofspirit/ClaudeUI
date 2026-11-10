/**
 * bootTestApp — Orchestrator for Layer 2 (component) and Layer 3 (E2E) tests.
 *
 * Wires main-process services + renderer store in a single Node/jsdom process.
 * Only two fakes: Electron transport (TestIpcBridge) and SDK (event generator stub).
 *
 * Usage in test files:
 *
 *   // At top of test file, BEFORE any imports from main/:
 *   vi.mock('electron', () => import('../../test/stubs/electron-shim'))
 *   vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkStub.queryFn }))
 *
 *   // In test:
 *   const app = await bootTestApp({ sdkEvents: textResponseSequence('session-1', 'Hello') })
 *   // ... use app.api, app.store, app.bridge
 */

import { TestIpcBridge } from '../bridges/test-ipc-bridge'
import { setIpcBridge } from '../stubs/electron-shim'
import { SyncClient } from '../../core/shared/sync/sync-client'
import { resetSyncClientForTests, onSyncEvent } from '../../core/shared/sync/client-registry'
import { installSyncSeam, resetSyncSeam, emitSync, nextSeq, advanceSeqTo } from './replica-seed'
import { channelSpec } from '../../core/shared/sync/channels'
import {
  startReplica,
  hydrateReplica,
  resetReplicaForTests
} from '../../renderer/src/stores/replica'
import { finishHydrate } from '../../renderer/src/lib/session-history-load'
import type { SyncEventMap } from '../../core/shared/sync/events'
import type { FullStateSnapshot } from '../../shared/remote-protocol'
import type { ClaudeAPI } from '../../shared/types'
import {
  API_EVENTS,
  API_INVOKES,
  DESKTOP_EVENTS,
  DESKTOP_INVOKES,
  buildEventApi,
  buildInvokeApi,
  type InvokeTransport
} from '../../shared/api-invoke-table'

// Build a ClaudeAPI object backed by the bridge.
// The pass-through members come from the same tables as src/preload/index.ts
// (`shared/api-invoke-table.ts`), over bridge.ipcRenderer instead of Electron's.
function buildTestApi(bridge: TestIpcBridge): ClaudeAPI {
  const { ipcRenderer } = bridge

  const transport: InvokeTransport = {
    failurePrefix: 'IPC',
    invoke: (channel, args) => ipcRenderer.invoke(channel, ...args),
    // The harness bridge has no progress channel: the callback is simply never called.
    invokeWithProgress: (channel, args) => ipcRenderer.invoke(channel, ...args),
    /**
     * HOST-LOCAL channels only — mirrors `src/preload/index.ts` since SyncCore
     * phase 4c. Replicated / volatile events reach the renderer through the
     * harness's `SyncClient` instead (see {@link TestApp.emit}).
     */
    on: (channel) => (cb: (...args: never[]) => void) => {
      const handler = (_: unknown, ...args: unknown[]): void =>
        (cb as unknown as (...a: unknown[]) => void)(...args)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  }

  // Members that are not a table pass-through (same split as the preload).
  const own: Omit<
    ClaudeAPI,
    | keyof typeof API_INVOKES
    | keyof typeof API_EVENTS
    | keyof typeof DESKTOP_INVOKES
    | keyof typeof DESKTOP_EVENTS
  > = {
    platform: process.platform,
    // The jsdom harness is not the real-app harness: nothing here reads
    // `window.__claudeuiVerifier`, and tests reach the store directly.
    verifierHooks: false,

    // The sync transport is installed by bootTestApp itself, so there is no port
    // to acquire (mirrors the web adapter).
    acquireSyncPort: () => {},

    // Mirrors preload: step-up is remote-only, but attach/detach are real on the
    // desktop transport too (the terminal pool means a tab can resolve to a pty
    // this surface never spawned, and attach is what replays its scrollback).
    terminalStepUp: async () => ({ ok: true }),
    terminalStepUpPasskey: async () => ({ ok: true }),
    onTerminalDetached: () => () => {},

    // Passkeys — mirrors the preload split: the four management verbs are real
    // desktop channels, the two ceremony verbs are not registered there at all.
    webauthnRegisterOptions: async () => {
      throw new Error('Passkey enrollment runs in a browser')
    },
    webauthnRegisterVerify: async () => {
      throw new Error('Passkey enrollment runs in a browser')
    },

    voiceAudio: (routingId, dataB64) => ipcRenderer.send('voice:audio', routingId, dataB64),

    logError: (source, message) => {
      ipcRenderer.send('log:error', source, message)
    },
    logRelay: (level, source, message) => ipcRenderer.send('log:relay', level, source, message),

    getMockupPreviewUrl: (cwd, directory) => `mockup-asset://test.m/${cwd}/${directory}`
  }

  // Inert stand-ins for channels the harness has no handler behind: they replace the table's
  // pass-through of the same name.
  const stubs: Partial<ClaudeAPI> = {
    setUsageAccountFilter: async () => {},
    refreshPrices: async () => ({ count: 0, refreshedAt: Date.now() }),
    vendorAuthProbe: async () => ({}),
    vendorAuthListOptions: async () => ({}),
    vendorAuthListKeys: async () => ({}),
    vendorAuthSetKey: async () => {},
    vendorAuthOauthAuthorize: async () => {
      throw new Error('Vendor auth not available in tests')
    },
    vendorAuthDeviceCodeStart: async () => {
      throw new Error('Vendor auth not available in tests')
    },
    vendorAuthDeviceCodeStatus: async () => {
      throw new Error('Vendor auth not available in tests')
    },
    vendorAuthOauthCallback: async () => {
      throw new Error('Vendor auth not available in tests')
    },
    vendorAuthRemove: async () => {},
    vendorAuthOauthCancel: async () => {},
    readOpencodeNativeRaw: async () => ({ config: {}, path: '' }),
    patchOpencodeNative: async () => {},
    setOpencodeToolDisabled: async () => {},
    readPiNativeRaw: async () => ({ config: {}, path: '', text: '' }),
    patchPiNative: async () => {},
    writePiNativeText: async () => {},
    readPiModelsRaw: async () => ({ config: {}, path: '', text: '', managedProviderIds: [] }),
    patchPiModels: async () => {},
    listOpencodeAgents: async () => [],
    listAgentTypes: async () => [],
    readOpencodeAgent: async () => null,
    saveOpencodeAgent: async () => {},
    deleteOpencodeAgent: async () => {},
    setOpencodeAgentDisabled: async () => {},
    generateOpencodeAgent: async () => ({ identifier: '', whenToUse: '', systemPrompt: '' })
  }

  const api: ClaudeAPI = {
    ...buildInvokeApi(API_INVOKES, transport),
    ...buildInvokeApi(DESKTOP_INVOKES, transport),
    ...buildEventApi(API_EVENTS, transport),
    ...buildEventApi(DESKTOP_EVENTS, transport),
    ...own,
    ...stubs
  }
  // `openPath` / `showInFolder` are OPTIONAL on ClaudeAPI (the web client has neither) and this
  // harness has never carried them: a component test sets a mock to assert their presence and
  // relies on the default to assert their absence (SentFilesWidget), so they stay out.
  delete api.openPath
  delete api.showInFolder
  return api
}

export interface TestApp {
  bridge: TestIpcBridge
  api: ClaudeAPI
  /**
   * Deliver one event from main to the renderer.
   *
   * Routes by channel CLASS, exactly as the production delivery adapter does
   * (`services/sync-host.ts`) — which is what makes this a seam rather than a
   * parallel universe:
   *
   *  - `host-local` → `bridge.webContents.send`, the targeted lane the preload's
   *    surviving `onEvent` listeners read;
   *  - replicated / volatile → the harness's real {@link SyncClient}, with an
   *    auto-incrementing seq, through the same `receiveEvent` path the MessagePort
   *    and WebSocket transports use.
   *
   * The signature is unchanged from before SyncCore phase 4c, so existing
   * `app.emit('session:message', rid, msg)` call sites keep working — only the
   * plumbing underneath moved.
   */
  emit: (channel: string, ...args: any[]) => void
  /** The seq the next {@link TestApp.emit} of a ringed channel will carry. */
  nextSeq: () => number
  /**
   * Subscribe to a replicated / volatile channel, the way the renderer does.
   *
   * Tests that hand-wire handlers (the e2e flows mirror `useClaudeEvents`) use
   * this instead of `bridge.ipcRenderer.on`: those channels no longer travel on
   * the bridge at all.
   *
   * Overloaded: a literal channel name gets the typed `SyncEventMap` callback; a
   * `string` channel (an e2e harness building its own handler table in a loop)
   * falls through to the loose form.
   */
  onSync: {
    <K extends keyof SyncEventMap>(channel: K, cb: SyncEventMap[K]): () => void
    (channel: string, cb: (...args: any[]) => void): () => void
  }
  /** Hydrate the renderer from a full snapshot, as a `sync-full` frame would. */
  syncFull: (state: FullStateSnapshot, epoch?: string) => void
  /** The harness's sync client — installed in the shared registry at boot. */
  syncClient: SyncClient
  /** Cleanup — call in afterEach() */
  teardown: () => void
}

/**
 * Boot the test app. Sets up TestIpcBridge, wires it to electron shim,
 * and builds window.api.
 *
 * NOTE: The caller must set up vi.mock('electron') and vi.mock('@anthropic-ai/claude-agent-sdk')
 * BEFORE calling this function, since module mocks must be hoisted.
 */
export async function bootTestApp(): Promise<TestApp> {
  /** Re-broadcast a config save as its `config:*-changed` echo (assigned below). */
  let echo: (channel: string, args: unknown[]) => void = () => {}

  // 1. Create bridge and wire to electron shim
  const bridge = new TestIpcBridge()
  setIpcBridge(bridge)

  // 2. Register stub IPC handlers for channels the store uses internally.
  // These prevent "no handler registered" errors when store actions
  // call window.api.saveSessionConfig(), etc.
  //
  // The two config SAVES are not inert stubs: production echoes the saved payload
  // back as `config:sessions-changed` / `config:settings-changed`, and since
  // SyncCore phase 4c that echo reaches the client that saved (it is what makes
  // an optimistic registry write correctable). A harness that swallowed the echo
  // would let a regression in the echo path pass every test.
  const stubChannels = [
    'config:load-settings',
    'config:load-sessions',
    'config:save-slash-commands',
    'config:load-slash-commands',
    'config:load-engine-config',
    'config:save-engine-config',
    'config:load-vendor-config',
    'config:save-vendor-config',
    'config:save-shared-automode',
    'usage:fetch',
    'usage:fetch-block',
    'plugin:views',
    'log-viewer:open',
    'app:version-info'
  ]
  for (const channel of stubChannels) {
    bridge.ipcMain.handle(channel, async () => null)
  }
  // The shared trust lists answer an OBJECT, not the `null` the inert stubs
  // return: `TrustListsSection` renders its three list rows from it, and a null
  // would leave every settings-page test parked in the loading row.
  bridge.ipcMain.handle('config:load-shared-automode', async () => ({}))
  bridge.ipcMain.handle('config:save-sessions', async (_e: unknown, config: unknown) => {
    echo('config:sessions-changed', [config])
    return null
  })
  bridge.ipcMain.handle('config:save-settings', async (_e: unknown, settings: unknown) => {
    echo('config:settings-changed', [settings])
    return null
  })

  // 3. Build window.api backed by bridge
  const api = buildTestApi(bridge)

  // Assign to globalThis.window.api for hooks/components that read it
  ;(globalThis as any).window.api = api

  // 4. Install the sync transport seam (SyncCore phase 4c).
  //
  // A REAL SyncClient, not a stub: cursor discipline, gap detection and the
  // readiness gate are the properties phase 0 exists to guarantee, and a harness
  // that faked them would let a regression in any of the three pass every test.
  // The gate is opened immediately — a test asserting on state after `emit()`
  // cannot wait for a React effect to call `markSyncReady()`, and the ordering
  // that gate protects (listeners before ready) is covered by the sync-client
  // unit tests instead.
  resetSyncClientForTests()
  const syncClient = new SyncClient({
    // A gap in a test means the test emitted out of order; asking the harness for
    // a resync it cannot answer would hide that, so leave it loud-by-absence.
    requestResync: () => {}
  })
  // ONE seq counter for the harness and for `replica-seed`'s direct emitters: two
  // would manufacture gaps and trip the client's resync detection.
  installSyncSeam(syncClient)
  echo = emitSync

  // 5. Install the REPLICA (SyncCore phase 4c). The store's replicated slices are
  // the shared reducer's output now, so a harness that skipped this would show an
  // empty transcript for every `emit`. Reset first: the module holds a canonical
  // mirror for the page's lifetime and a test must not inherit the previous one.
  resetReplicaForTests()
  startReplica()
  let hasHydrated = false
  syncClient.setFullStateHandler((state) => {
    const isResync = hasHydrated
    hasHydrated = true
    // Same follow-up the real entry points run (renderer main.tsx, web main.tsx).
    finishHydrate(hydrateReplica(state, isResync))
  })

  return {
    bridge,
    api,
    syncClient,
    nextSeq,
    emit: (channel: string, ...args: any[]) => {
      if (channelSpec(channel)?.cls === 'host-local') {
        bridge.webContents.send(channel, ...args)
        return
      }
      emitSync(channel, args)
    },
    onSync: ((channel: string, cb: (...args: any[]) => void) =>
      onSyncEvent(channel as keyof SyncEventMap, cb as never)) as TestApp['onSync'],
    syncFull: (state: FullStateSnapshot, epoch = 'test-epoch') => {
      // Keep the seam's cursor at or past the snapshot watermark, or the next
      // `emit` would look like a replay and be dropped.
      advanceSeqTo(state.seq)
      syncClient.applyFullState(state, epoch, state.seq)
    },
    teardown: () => {
      bridge.reset()
      resetSyncClientForTests()
      resetReplicaForTests()
      resetSyncSeam()
      delete (globalThis as any).window.api
    }
  }
}
