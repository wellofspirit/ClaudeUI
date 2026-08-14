/**
 * bootIpcHarness — wires a `registerXxxIpc()` function against a TestIpcBridge
 * so tests can invoke IPC channels and observe envelope behavior.
 *
 * Usage:
 *   vi.mock('electron', () => import('../../test/stubs/electron-shim'))
 *   ...
 *   const { bridge, win, call } = await bootIpcHarness()
 *   registerTerminalIpc()
 *   // `win` is for the surfaces that still take one; the register* functions are
 *   // window-free since SyncCore phase 4d (they run in a windowless boot), so a
 *   // host window is published with `setHostWindow(win)` when a test needs one.
 *   const id = await call('terminal:create', '/tmp')
 *
 * For safeHandler-wrapped channels, use callSafe() which unwraps `{ ok, data, error }`.
 * For unwrapped channels, use call().
 */

import { TestIpcBridge } from '../bridges/test-ipc-bridge'
import { setIpcBridge } from '../stubs/electron-shim'
import { addSyncSubscriber, clearSyncSubscribersForTests } from '../../main/services/sync-host'
import { channelSpec } from '../../shared/sync/channels'

export interface IpcHarness {
  bridge: TestIpcBridge
  /** Fake BrowserWindow to pass to `registerXxxIpc(win)` */
  win: any
  /** Raw invoke — returns whatever the handler returned (including envelope) */
  call: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  /**
   * Invoke a safeHandler-wrapped channel and unwrap `{ ok, data, error }`.
   * Throws with the error message if `ok: false`.
   */
  callSafe: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  /**
   * Listen for one emitted event, on whichever lane it actually travels.
   *
   * Routes by channel CLASS since SyncCore phase 4c, mirroring the production
   * delivery adapter: `host-local` off `win.webContents.send`, everything else
   * off the funnel's subscriber registry. Keeping ONE method means every existing
   * call site is unchanged even though half of them moved lane.
   */
  onEvent: (channel: string, handler: (...args: unknown[]) => void) => () => void
  /** Observe the next emission of a channel as a promise. Resolves with args array. */
  waitForEvent: (channel: string, timeoutMs?: number) => Promise<unknown[]>
  /** Tear down; call in afterEach */
  teardown: () => void
}

export function bootIpcHarness(): IpcHarness {
  const bridge = new TestIpcBridge()
  setIpcBridge(bridge)
  const win = bridge.createBrowserWindow()

  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    return (await bridge.ipcRenderer.invoke(channel, ...args)) as T
  }
  const callSafe = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const res = await bridge.ipcRenderer.invoke(channel, ...args)
    if (res && typeof res === 'object' && 'ok' in res) {
      if (!(res as any).ok) {
        const err = (res as any).error
        throw new Error(typeof err === 'string' ? err : JSON.stringify(err))
      }
      return (res as any).data as T
    }
    return res as T
  }
  const onEvent = (channel: string, handler: (...args: unknown[]) => void): (() => void) => {
    if (channelSpec(channel)?.cls !== 'host-local') {
      return addSyncSubscriber((_seq, emitted, args) => {
        if (emitted === channel) handler(...args)
      })
    }
    const wrap = (_: unknown, ...args: unknown[]): void => handler(...args)
    bridge.ipcRenderer.on(channel, wrap)
    return () => bridge.ipcRenderer.removeListener(channel, wrap)
  }
  const waitForEvent = (channel: string, timeoutMs = 1000): Promise<unknown[]> => {
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timeout waiting for event "${channel}" after ${timeoutMs}ms`))
      }, timeoutMs)
      const off = onEvent(channel, (...args) => {
        clearTimeout(timer)
        off()
        resolve(args)
      })
    })
  }

  return {
    bridge,
    win,
    call,
    callSafe,
    onEvent,
    waitForEvent,
    teardown: () => {
      // Subscribers are a module singleton on the funnel; leaking one would fan
      // the next test's ring out into this test's closures.
      clearSyncSubscribersForTests()
      bridge.reset()
    }
  }
}
