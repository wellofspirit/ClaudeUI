/**
 * The desktop's relaunch wiring: the `HostRelaunch` seam core's `app:*`
 * commands call (set in `boot-core.ts`), the service behind it (configured by
 * `index.ts` once the quit coordinator exists), the detached spawn, and the
 * restore-record request to the window.
 */

import { spawn } from 'node:child_process'
import type { HostRelaunch } from '../../../core/host'
import { parseRestoreRecord, type RestoreRecord } from '../../../shared/relaunch'
import { helperEnv, type HelperCommand } from './helper-scripts'
import type { RelaunchService, SpawnedHelper } from './relaunch-service'

let service: RelaunchService | null = null

/** Install (or clear) the service behind {@link desktopHostRelaunch}. */
export function configureRelaunch(next: RelaunchService | null): void {
  service = next
}

export function relaunchService(): RelaunchService | null {
  return service
}

/** The desktop's `HostRelaunch`. Before `configureRelaunch` it is unavailable, not absent. */
export const desktopHostRelaunch: HostRelaunch = {
  availability: () =>
    service ? service.availability() : { available: false, reason: 'ClaudeUI is still starting' },
  relaunch: async () => {
    if (!service) throw new Error('ClaudeUI is still starting; try again in a moment')
    await service.requestRelaunch({ mode: 'relaunch' })
  },
  lastResult: () => service?.lastResult() ?? null
}

/**
 * Spawn the helper detached from this process: its own process group/session,
 * no stdio, cwd = the state dir (never the install: on Windows an open cwd
 * handle would block every rename), unref'd so it outlives the quit.
 */
export function spawnDetachedHelper(command: HelperCommand, cwd: string): SpawnedHelper {
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd,
    env: helperEnv(process.env, command)
  })
  const failed = new Promise<Error>((resolve) => child.once('error', resolve))
  child.unref()
  return { pid: child.pid, failed }
}

/**
 * The restore-record request: main asks the window (`app:collect-restore`) and
 * the renderer answers through `app:restore-state`. `send` returns false when
 * there is no window to ask. The caller bounds the wait.
 */
export function createRestoreCollector(send: () => boolean): {
  collect(): Promise<RestoreRecord | null>
  deliver(raw: unknown): void
} {
  let pending: ((record: RestoreRecord | null) => void) | null = null
  return {
    collect() {
      pending?.(null)
      return new Promise((resolve) => {
        pending = resolve
        if (!send()) {
          pending = null
          resolve(null)
        }
      })
    },
    deliver(raw) {
      const resolve = pending
      pending = null
      resolve?.(parseRestoreRecord(raw))
    }
  }
}
