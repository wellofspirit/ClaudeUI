/**
 * ClaudeUI's own updates (auto-update design §3), declared ONCE and served by
 * both transports: the Updates panel reads and drives these from the desktop
 * and from a phone alike.
 *
 * ## Capabilities
 *
 * - `app-update:state` declares `config`, a `query`: every device may see that
 *   an update exists (like `harness:state`). The view carries no local path.
 * - The writes declare `admin`, as `harness:install` does: sending the host to
 *   GitHub, downloading a build onto it, hiding a release from its operator,
 *   restarting it into a new build, and building ClaudeUI from a source tree on
 *   it (`app-update:rebuild` runs that tree's build scripts with the user's
 *   rights) are close to remote code execution. A base remote connection never
 *   holds `admin`; a passkey or break-glass one does, and at the `strong` tier a
 *   write also needs the mutation window. Every write is pinned in
 *   `PINNED_CAPABILITIES`.
 * - `app-update:trees` is an `admin` query (pinned too): the checkouts on the
 *   host, their branches and commits are the operator's business, and the list
 *   is only ever read to pick a rebuild. It carries no path; a rebuild takes an
 *   id the host recomputes from its own list, never a path from a client.
 *
 * ## Results
 *
 * The view (`AppUpdateView`), `{ accepted: true }` for apply, the tree list for
 * trees; never an `ok` key (the preload and web `unwrap` would take it for their
 * envelope). A refusal (nothing to download, nothing staged, a malformed
 * version, a rebuild pre-check) throws.
 *
 * ## Events (`startAppUpdateEvents`)
 *
 * `app-update:changed`, payload-free, on every change of the view (download
 * progress at most once a second): a replicated nudge; the client re-reads
 * `app-update:state`.
 */
import type { EmitEvent } from '../shared/sync/events'
import type {
  AppUpdateApplyResult,
  AppUpdateApplySource,
  AppUpdateTree,
  AppUpdateView
} from '../../shared/types/app-update'
import { appUpdater, type AppUpdater } from '../services/app-update'
import type { CommandRegistration } from './command-registry'

/** The channels declared here; `registerSessionIpc` unbinds them before re-registering. */
export const APP_UPDATE_CHANNELS = [
  'app-update:state',
  'app-update:check',
  'app-update:download',
  'app-update:skip',
  'app-update:apply',
  'app-update:trees',
  'app-update:rebuild',
  'app-update:cancel-rebuild'
] as const

export interface AppUpdateCommandDeps {
  updater?: AppUpdater
}

function fieldOf(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined
}

function versionArg(payload: unknown): string {
  const version = fieldOf(payload, 'version')
  if (typeof version !== 'string') throw new Error('A version is required')
  return version
}

/** `{ source }` of an apply; absent (or a JSON null payload) is the release. */
function sourceArg(payload: unknown): AppUpdateApplySource {
  const source = fieldOf(payload, 'source')
  if (source === undefined || source === null) return 'release'
  if (source !== 'release' && source !== 'rebuild')
    throw new Error('The update source is "release" or "rebuild"')
  return source
}

function treeIdArg(payload: unknown): string {
  const treeId = fieldOf(payload, 'treeId')
  if (typeof treeId !== 'string' || treeId === '') throw new Error('A tree id is required')
  return treeId
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
      handler: async (payload?: unknown): Promise<AppUpdateApplyResult> => {
        await updater.apply(sourceArg(payload))
        return { accepted: true }
      }
    },
    {
      channel: 'app-update:trees',
      capability: 'admin',
      kind: 'query',
      handler: async (): Promise<AppUpdateTree[]> => updater.trees()
    },
    {
      // Starts the build and answers at once; progress rides `app-update:changed`.
      channel: 'app-update:rebuild',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<AppUpdateView> => {
        await updater.rebuild(treeIdArg(payload))
        return updater.view()
      }
    },
    {
      channel: 'app-update:cancel-rebuild',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<AppUpdateView> => {
        await updater.cancelRebuild()
        return updater.view()
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
