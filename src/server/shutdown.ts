/**
 * The headless server's signal handler. Pure: everything comes in as deps, and it
 * imports nothing from the service graph (that graph loads after the host adapters).
 *
 * Order: `prepareStop` (services alive, bounded — the desktop's quit coordinator
 * bounds the same step at 4 s), then the synchronous `stop`, then a delayed exit.
 *
 * The exit code is the first caller's: a stop signal exits 0; a restart requested
 * from a client (a relaunch or an update under the monitor) exits with
 * `RESTART_EXIT_CODE`, which tells the monitor to start a worker again. A later
 * call changes nothing, so a signal that arrives during a restart's shutdown still
 * ends in the restart's code (the monitor, stopping too, then exits with it).
 */

export interface ShutdownDeps {
  prepareStop: () => Promise<void>
  stop: () => void
  exit: (code: number) => void
  log: (message: string) => void
  /** Default 4000, the quit coordinator's bound. */
  prepareTimeoutMs?: number
  /** Default 500: lets the listener close, but never hangs on it. */
  exitDelayMs?: number
}

/** Start the shutdown (idempotent): `reason` is logged, `exitCode` defaults to 0. */
export type Shutdown = (reason: string, exitCode?: number) => void

export function createShutdown(deps: ShutdownDeps): Shutdown {
  const prepareTimeoutMs = deps.prepareTimeoutMs ?? 4000
  const exitDelayMs = deps.exitDelayMs ?? 500
  let stopping = false
  return (reason, exitCode = 0) => {
    if (stopping) return
    stopping = true
    deps.log(`${reason} — shutting down${exitCode === 0 ? '' : ` (exit code ${exitCode})`}`)
    void (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, prepareTimeoutMs)
        })
        try {
          await Promise.race([deps.prepareStop(), bound])
        } catch (err) {
          deps.log(`prepareStop failed: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          clearTimeout(timer)
        }
        deps.stop()
      } catch (err) {
        deps.log(`stop failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        // Unref'd for exit 0, so a process with nothing left open ends at once
        // (with 0, the same answer). A non-zero code must not be lost to that
        // natural exit, so its timer holds the process until `exit` runs.
        const timer = setTimeout(() => deps.exit(exitCode), exitDelayMs)
        if (exitCode === 0) timer.unref()
      }
    })()
  }
}
