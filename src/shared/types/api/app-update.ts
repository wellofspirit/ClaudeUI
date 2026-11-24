import type { AppUpdateApplyResult, AppUpdateView } from '../app-update'

/**
 * ClaudeUI's own updates (`core/ipc/app-update-commands.ts`). The state read is
 * `config`; every write is `admin`, so a base remote connection is refused
 * them. Changes arrive as the payload-free `app-update:changed` sync event;
 * the client re-reads the state.
 */
export interface AppUpdateAPI {
  /** The update view. No network. */
  appUpdateState(): Promise<AppUpdateView>
  /** Ask GitHub for a newer release now; resolves with the view once the check ends. */
  checkAppUpdate(): Promise<AppUpdateView>
  /** Start downloading the available update; resolves at once with the view. Throws when none is available. */
  downloadAppUpdate(): Promise<AppUpdateView>
  /** Hide `version` until a newer one is released (persisted on the host). */
  skipAppUpdate(version: string): Promise<AppUpdateView>
  /** Restart into the staged update. Throws unless an update is staged. */
  applyAppUpdate(): Promise<AppUpdateApplyResult>
}
