/**
 * ClaudeUI's own updates (auto-update design §3), declared ONCE and served by
 * both transports: the Updates panel reads and drives these from the desktop
 * and from a phone alike.
 *
 * ## Capabilities
 *
 * - `app-update:state` declares `config`, a `query`: every device may see that
 *   an update exists (like `harness:state`). The view carries no local path.
 * - The four writes declare `admin`, as `harness:install` does: sending the
 *   host to GitHub, downloading a build onto it, hiding a release from its
 *   operator, and restarting it into a new build are close to remote code
 *   execution. A base remote connection never holds `admin`; a passkey or
 *   break-glass one does, and at the `strong` tier a write also needs the
 *   mutation window. The four are pinned in `PINNED_CAPABILITIES`.
 *
 * ## Results
 *
 * The view (`AppUpdateView`), or `{ accepted: true }` for apply; never an `ok`
 * key (the preload and web `unwrap` would take it for their envelope). A
 * refusal (nothing to download, nothing staged, a malformed version) throws.
 *
 * ## Events (`startAppUpdateEvents`)
 *
 * `app-update:changed`, payload-free, on every change of the view (download
 * progress at most once a second): a replicated nudge; the client re-reads
 * `app-update:state`.
 */
import type { EmitEvent } from '../shared/sync/events'
import type { AppUpdateApplyResult, AppUpdateView } from '../../shared/types/app-update'
import { appUpdater, type AppUpdater } from '../services/app-update'
import type { CommandRegistration } from './command-registry'

/** The channels declared here; `registerSessionIpc` unbinds them before re-registering. */
export const APP_UPDATE_CHANNELS = [
  'app-update:state',
  'app-update:check',
  'app-update:download',
  'app-update:skip',
  'app-update:apply'
] as const

export interface AppUpdateCommandDeps {
  updater?: AppUpdater
}

function versionArg(payload: unknown): string {
  const version =
    typeof payload === 'object' && payload !== null
      ? (payload as { version?: unknown }).version
      : undefined
  if (typeof version !== 'string') throw new Error('A version is required')
  return version
}

export function appUpdateCommands(
  deps: AppUpdateCommandDeps = {}
): Array<Omit<CommandRegistration, 'transport'>> {
  const updater = deps.updater ?? appUpdater
  return [
    {
      channel: 'app-update:state',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<AppUpdateView> => updater.state()
    },
    {
      channel: 'app-update:check',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<AppUpdateView> => {
        await updater.check('user')
        return updater.view()
      }
    },
    {
      // Starts the download and answers at once; progress rides `app-update:changed`.
      channel: 'app-update:download',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<AppUpdateView> => {
        await updater.download()
        return updater.view()
      }
    },
    {
      channel: 'app-update:skip',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<AppUpdateView> => {
        await updater.skip(versionArg(payload))
        return updater.view()
      }
    },
    {
      channel: 'app-update:apply',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<AppUpdateApplyResult> => {
        await updater.apply()
        return { accepted: true }
      }
    }
  ]
}

// ── Events ────────────────────────────────────────────────────────────────────

let stopEvents: (() => void) | null = null

/**
 * Forward the updater's changes to the sync funnel (`emitEvent`), from
 * `startCoreServices`. A second call replaces the first (a test that boots core
 * twice), so each event goes out once. Returns the unsubscribe function.
 */
export function startAppUpdateEvents(
  emit: EmitEvent,
  updater: AppUpdater = appUpdater
): () => void {
  stopEvents?.()
  const off = updater.onChanged(() => {
    try {
      emit('app-update:changed', [])
    } catch {
      // No subscriber can take it (shutdown): the next app-update:state read is the truth.
    }
  })
  const stop = (): void => {
    off()
    if (stopEvents === stop) stopEvents = null
  }
  stopEvents = stop
  return stop
}
