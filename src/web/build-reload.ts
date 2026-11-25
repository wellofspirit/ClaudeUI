/**
 * Reload the web client when the host comes back on another build (relaunch
 * arc, design §5). The page's JavaScript was served by the old build; after a
 * restart onto a new one it would talk to a host whose wire it no longer
 * matches. The authenticated handshake carries the host's `buildId`
 * (`WsAuthResponse.buildId`, absent for a dev host): the connection remembers
 * the first one it sees, and a reconnect that reports a different, known one
 * stashes the open session and unsent drafts in sessionStorage and reloads.
 * The fresh page applies the stash once after its first sync.
 */

import { parseRestoreRecord, type RestoreRecord } from '../shared/relaunch'

export const RESTORE_STASH_KEY = 'claudeui:restore-after-reload'

/** The first build id seen, and a single change notice after it. Absent ids are ignored. */
export function createBuildIdWatcher(onChange: (from: string, to: string) => void): {
  observe(id: unknown): void
} {
  let first: string | null = null
  let fired = false
  return {
    observe(id) {
      if (typeof id !== 'string' || id === '') return
      if (first === null) {
        first = id
        return
      }
      if (id !== first && !fired) {
        fired = true
        onChange(first, id)
      }
    }
  }
}

/** `window.sessionStorage`, or undefined where reading it throws (blocked site data). */
export function pageSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/** Never throws: a blocked or full sessionStorage loses the stash, not the reload. */
export function stashRestore(storage: Storage | undefined, record: RestoreRecord): void {
  try {
    storage?.setItem(RESTORE_STASH_KEY, JSON.stringify(record))
  } catch {
    /* storage unavailable */
  }
}

/** The stash, once: it is removed whether or not it parses. */
export function takeStashedRestore(storage: Storage | undefined): RestoreRecord | null {
  try {
    const raw = storage?.getItem(RESTORE_STASH_KEY)
    storage?.removeItem(RESTORE_STASH_KEY)
    return raw ? parseRestoreRecord(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/** The change handler the page installs: collect, stash, reload. */
export function reloadOnBuildChange(deps: {
  collect: () => Promise<RestoreRecord> | RestoreRecord
  storage: Storage | undefined
  reload: () => void
  log?: (message: string) => void
}): (from: string, to: string) => void {
  return (from, to) => {
    deps.log?.(`host build changed (${from} → ${to}); reloading`)
    void (async () => {
      try {
        stashRestore(deps.storage, await deps.collect())
      } catch {
        /* reload anyway: old code against a new host is the worse outcome */
      }
      deps.reload()
    })()
  }
}
