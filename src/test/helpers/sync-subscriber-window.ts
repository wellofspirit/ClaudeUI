/**
 * Make a fake `BrowserWindow` behave like a CLIENT — SyncCore phase 4c.
 *
 * Engine tests observe what a session emits by handing it a stub window and
 * reading `win.webContents.send.mock.calls`. That worked because the desktop
 * window WAS the delivery target for replicated events, which is precisely the
 * privilege 4c deleted: a session emission now goes to every registered
 * subscriber and to no window at all.
 *
 * Rather than rewrite several hundred assertions, this registers the stub as a
 * subscriber and replays each delivery into the same `send(channel, ...args)`
 * shape. The test keeps asserting on the events a client receives — which is what
 * it was always really asserting on — and the stub stops pretending to be a
 * privileged window.
 *
 * Leaking a subscription across tests is harmless (each test reads its OWN mock),
 * but `clearSyncSubscribersForTests()` in an `afterEach` keeps a long file from
 * fanning every event out to hundreds of dead stubs.
 */

import { addSyncSubscriber } from '../../main/services/sync-host'

interface WindowLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}

/** Subscribe `win` to the funnel's fan-out. Returns the unsubscribe. */
export function subscribeWindowToSync(win: WindowLike): () => void {
  return addSyncSubscriber((_seq, channel, args) => {
    win.webContents.send(channel, ...args)
  })
}
