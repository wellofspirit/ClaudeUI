import type {
  AppUpdateApplyResult,
  AppUpdateApplySource,
  AppUpdateTree,
  AppUpdateView
} from '../app-update'

/**
 * ClaudeUI's own updates (`core/ipc/app-update-commands.ts`). The state read is
 * `config`; every write, and the tree list, is `admin`, so a base remote
 * connection is refused them. Changes arrive as the payload-free
 * `app-update:changed` sync event; the client re-reads the state.
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
  /**
   * Restart into the staged release (`source` `release`, the default) or the
   * built rebuild (`rebuild`). Throws unless that build is staged.
   */
  applyAppUpdate(options?: { source?: AppUpdateApplySource }): Promise<AppUpdateApplyResult>
  /** The ClaudeUI checkouts the host can rebuild (no paths). Empty where rebuilds are unavailable. */
  appUpdateTrees(): Promise<AppUpdateTree[]>
  /**
   * Rebuild ClaudeUI from the tree `treeId` names (an id from `appUpdateTrees`);
   * resolves with the view once the build started. Throws with the reason a
   * pre-check refused it.
   */
  rebuildApp(treeId: string): Promise<AppUpdateView>
  /** Stop a running rebuild (nothing is staged). Resolves with the view. */
  cancelAppRebuild(): Promise<AppUpdateView>
}
