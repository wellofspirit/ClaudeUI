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
 * - `app-update:set-source` (`admin`, pinned) is the one writer of the
 *   host-owned `appUpdateSourcePath`, the checkout those trees are listed from
 *   (`config:save-settings`, a base remote grant, keeps the host's value). It
 *   takes an absolute path to a ClaudeUI checkout (`claudeui-checkout.ts`, the
 *   rule the desktop's tree list uses), or `null` to clear it, and is refused
 *   where the host cannot rebuild. The view says only whether a source is set.
 * - `app-update:set-settings` (`admin`, pinned) is the one writer of the mode
 *   and the channel (`appUpdateMode`, `appUpdateChannel`): whether the host
 *   downloads releases by itself, and which it offers. Host-owned like the
 *   source (`HOST_OWNED_SETTINGS`): `config:save-settings` keeps the host's
 *   values. It saves through the same settings plane, then tells the updater.
 * - `app-update:skip` with `{ version: null }` takes a skip back.
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
  AppUpdateChannelSetting,
  AppUpdateMode,
  AppUpdateTree,
  AppUpdateView
} from '../../shared/types/app-update'
import { appUpdater, type AppUpdater } from '../services/app-update'
import type { HostOwnedSetting } from '../../shared/app-settings'
import { checkSourcePath, type SourcePathCheck } from '../services/claudeui-checkout'
import { saveHostOwnedSettings } from '../services/ui-config'
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
  'app-update:cancel-rebuild',
  'app-update:set-source',
  'app-update:set-settings'
] as const

export interface AppUpdateCommandDeps {
  updater?: AppUpdater
  /** Persist host-owned settings (`null` clears one); the settings plane by default. */
  saveSettings?: (patch: Partial<Record<HostOwnedSetting, string | null>>) => void
  /** Check a typed source path; `checkSourcePath` by default. */
  checkSource?: (raw: string) => SourcePathCheck
}

function fieldOf(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined
}

/** A version to skip, or an explicit `null` (`{ version: null }`) to take the skip back. */
function skipVersionArg(payload: unknown): string | null {
  const version = fieldOf(payload, 'version')
  if (version === null) return null
  if (typeof version !== 'string') throw new Error('A version is required')
  return version
}

const MODES: readonly AppUpdateMode[] = ['auto', 'ask', 'off']
const CHANNELS: readonly AppUpdateChannelSetting[] = ['auto', 'stable', 'pre-release']

/** `{ mode?, channel? }` of a set-settings: at least one, each a known value (null is absent). */
function updateSettingsArg(payload: unknown): {
  appUpdateMode?: AppUpdateMode
  appUpdateChannel?: AppUpdateChannelSetting
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw new Error('Update settings are { mode?, channel? }')
  const mode = fieldOf(payload, 'mode') ?? undefined
  const channel = fieldOf(payload, 'channel') ?? undefined
  if (mode === undefined && channel === undefined)
    throw new Error('Name a mode or a channel to save')
  if (mode !== undefined && !MODES.includes(mode as AppUpdateMode))
    throw new Error(`The update mode is ${MODES.map((m) => `"${m}"`).join(', ')}`)
  if (channel !== undefined && !CHANNELS.includes(channel as AppUpdateChannelSetting))
    throw new Error(`The update channel is ${CHANNELS.map((c) => `"${c}"`).join(', ')}`)
  return {
    ...(mode !== undefined ? { appUpdateMode: mode as AppUpdateMode } : {}),
    ...(channel !== undefined ? { appUpdateChannel: channel as AppUpdateChannelSetting } : {})
  }
}

/** `{ path }` of a set-source: a string, or an explicit `null` to clear the source. */
function sourcePathArg(payload: unknown): string | null {
  const sourcePath = fieldOf(payload, 'path')
  if (sourcePath === null) return null
  if (typeof sourcePath !== 'string') throw new Error('A path (or null to clear it) is required')
  return sourcePath
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
  // Read at call time: specs that mock the config plane wholesale never reach it.
  const saveSettings =
    deps.saveSettings ??
    ((patch: Partial<Record<HostOwnedSetting, string | null>>) => saveHostOwnedSettings(patch))
  const checkSource = deps.checkSource ?? ((raw: string) => checkSourcePath(raw))
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
        await updater.skip(skipVersionArg(payload))
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
    },
    {
      // The settings plane emits `config:settings-changed`; `applySettings` then
      // has the updater nudge `app-update:changed` (its `sourceConfigured` and
      // `rebuildAvailable` moved).
      channel: 'app-update:set-source',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<AppUpdateView> => {
        const raw = sourcePathArg(payload)
        if (raw === null) {
          saveSettings({ appUpdateSourcePath: null })
          return updater.view()
        }
        if (updater.view().rebuild === undefined)
          throw new Error('This build cannot rebuild ClaudeUI from source')
        const checked = checkSource(raw)
        if (!checked.ok) throw new Error(checked.reason)
        saveSettings({ appUpdateSourcePath: checked.path })
        return updater.view()
      }
    },
    {
      // The settings plane emits `config:settings-changed`, whose observer runs
      // `applySettings`; the call here makes the change land before the answer
      // (a second call with nothing moved is a no-op).
      channel: 'app-update:set-settings',
      capability: 'admin',
      kind: 'command',
      handler: async (payload?: unknown): Promise<AppUpdateView> => {
        saveSettings(updateSettingsArg(payload))
        updater.settingsChanged()
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
