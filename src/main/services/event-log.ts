import type { FullStateSnapshot } from '../../shared/remote-protocol'
import type { BrowserWindow } from 'electron'

/**
 * The renderer-snapshot path — all that is left of the old `EventLog`.
 *
 * SyncCore phase 4a moved the ring itself into `main/sync/event-ring.ts` (and
 * the emission funnel that feeds it into `main/sync/sync-core.ts`), because a
 * ring appended from two places cannot hold the "one emission ⇒ one entry"
 * invariant. What stays here is the one thing that genuinely needs Electron and
 * is genuinely still authoritative in 4a: pulling the full state snapshot out of
 * the desktop renderer's Zustand store.
 *
 * That privilege is what phase 4b deletes (`SyncCore.getSnapshot()` becomes the
 * state of record and this class goes away). Until then core's canonical state
 * runs in SHADOW and this remains the `sync-full` source, unchanged.
 */
export class EventLog {
  private win: BrowserWindow | null = null

  /**
   * Reads the CURRENT ring seq. Injected rather than owned: the seq must be the
   * one the funnel is assigning, otherwise the watermark below would describe a
   * different event stream than the client is replaying.
   */
  constructor(private readonly seqReader: { currentSeq(): number }) {}

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  /**
   * Get a full state snapshot from the renderer's Zustand store.
   * Uses executeJavaScript to pull the authoritative state.
   *
   * The watermark is captured BEFORE the renderer round-trip, not after. An
   * event appended while `executeJavaScript` is in flight is not in the state
   * we get back, so stamping the post-round-trip seq claims coverage the
   * snapshot does not have, and the client — which starts its cursor at that
   * seq — never sees that event again (docs/architecture/remote.md defect 3).
   *
   * Under-claiming in the other direction is safe by construction: the client
   * catchup-replays `seqAtStart + 1..now` straight on top, and session events
   * are built for replay (messages upsert by id, status/permission-mode
   * replace), so re-applying the few the snapshot already reflects converges.
   *
   * `SyncCore.getSnapshot()` needs none of this ceremony — it captures seq and
   * serializes in the same synchronous tick — which is the structural reason 4b
   * can delete this method rather than keep patching it.
   */
  async getFullState(): Promise<FullStateSnapshot> {
    const seqAtStart = this.seqReader.currentSeq()
    const empty = (): FullStateSnapshot => ({
      seq: seqAtStart,
      sessions: {},
      directories: [],
      activeSessionId: null,
      settings: {},
      recentSessionIds: [],
      pinnedSessionIds: [],
      customTitles: {},
      worktreeInfoMap: {}
    })

    if (!this.win || this.win.isDestroyed()) return empty()

    try {
      const state = await this.win.webContents.executeJavaScript(
        'window.__getRemoteState ? window.__getRemoteState() : null'
      )
      if (state) {
        return { ...state, seq: seqAtStart }
      }
    } catch {
      // Renderer not ready or errored
    }

    return empty()
  }
}
