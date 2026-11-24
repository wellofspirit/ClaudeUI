/**
 * The desktop's relaunch wiring: the `HostRelaunch` seam core's `app:*`
 * commands call (set in `boot-core.ts`), the service behind it (configured by
 * `index.ts` once the quit coordinator exists), the detached spawn, and the
 * restore-record request to the window.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import type { HostRelaunch } from '../../../core/host'
import { logger } from '../../../core/services/logger'
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
 * Start the helper so it outlives this process: no stdio, cwd = the state dir
 * (never the install: on Windows an open cwd handle would block every rename),
 * unref'd. macOS: the helper itself, detached (its own session). Windows: the
 * launcher, attached and hidden, never detached: a powershell.exe started
 * detached has no console and exits 0 without running anything. The launcher
 * starts the helper, which as our grandchild leaves libuv's kill-on-close job.
 * A launcher that exits non-zero fails the spawn with what it wrote.
 * `baseEnv`: the environment passed on (tests add their fakes' variables).
 */
export function spawnDetachedHelper(
  command: HelperCommand,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): SpawnedHelper {
  const { launcher } = command
  const child = spawn(command.file, command.args, {
    detached: !launcher,
    stdio: 'ignore',
    windowsHide: true,
    cwd,
    env: helperEnv(baseEnv, command)
  })
  const failed = new Promise<Error>((resolve) => {
    child.once('error', resolve)
    if (launcher)
      child.once('exit', (code, signal) => {
        if (code !== 0) resolve(new Error(launchFailure(launcher.errorFile, code, signal)))
      })
  })
  child.unref()
  if (!launcher) return { pid: child.pid, failed }
  // By its handle: a no-op once it exited, never a pid that may name another process.
  return { pid: child.pid, failed, stop: () => void child.kill() }
}

/**
 * The Windows launcher failed. What it wrote (PowerShell's error, which names
 * paths under the home) goes to the log only: the reason reaches every client.
 */
function launchFailure(errorFile: string, code: number | null, signal: string | null): string {
  try {
    const written = fs.readFileSync(errorFile, 'utf8').trim().slice(0, 2000)
    if (written) logger.warn('relaunch', `the helper launcher failed: ${written}`)
  } catch {
    /* it wrote nothing */
  }
  const exit = code !== null ? `exit code ${code}` : `signal ${signal}`
  return `the helper launcher failed (${exit}); the log says why`
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
