import type {
  RelaunchAccepted,
  RelaunchAvailability,
  RelaunchResult,
  RestartImpact,
  RestoreRecord
} from '../../relaunch'

/** Restarting the host and picking up where the client left off (`src/shared/relaunch.ts`). */
export interface AppAPI {
  /**
   * Relaunch the host (`admin`): it quits and a detached helper starts it again.
   * Resolves once the quit is under way; rejects with the reason when refused.
   */
  relaunchApp(): Promise<RelaunchAccepted>
  /** Whether the host can relaunch itself now, and why not (`config`). */
  relaunchAvailability(): Promise<RelaunchAvailability>
  /** What a restart would interrupt: working sessions, terminals, remote clients (`config`). */
  restartImpact(): Promise<RestartImpact>
  /** The newest relaunch result for this install, or null (`config`). */
  lastRelaunch(): Promise<RelaunchResult | null>
  /**
   * The restore record a relaunch left for this window (one-shot, 10 minutes).
   * Desktop only; null on the web client, which keeps its own in sessionStorage.
   */
  takeRestore(): Promise<RestoreRecord | null>
  /** Answer the host's `app:collect-restore` request. Desktop only; a no-op on the web client. */
  restoreState(record: RestoreRecord): Promise<void>
  /** The host asks for this window's restore record before a relaunch. Desktop only. */
  onCollectRestore(cb: () => void): () => void
  /** The app menu's "Relaunch ClaudeUI" was chosen: run the confirm flow. Desktop only. */
  onRelaunchRequested(cb: () => void): () => void
  /** The app menu's "Check for Updates…" was chosen: open the Updates panel. Desktop only. */
  onCheckUpdatesRequested(cb: () => void): () => void
}
