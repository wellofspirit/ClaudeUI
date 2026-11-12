/**
 * The headless server's signal handler. Pure: everything comes in as deps, and it
 * imports nothing from the service graph (that graph loads after the host adapters).
 *
 * Order: `prepareStop` (services alive, bounded — the desktop's quit coordinator
 * bounds the same step at 4 s), then the synchronous `stop`, then a delayed exit.
 */

export interface ShutdownDeps {
  prepareStop: () => Promise<void>
  stop: () => void
  exit: () => void
  log: (message: string) => void
  /** Default 4000, the quit coordinator's bound. */
  prepareTimeoutMs?: number
  /** Default 500: lets the listener close, but never hangs on it. */
  exitDelayMs?: number
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const prepareTimeoutMs = deps.prepareTimeoutMs ?? 4000
  const exitDelayMs = deps.exitDelayMs ?? 500
  let stopping = false
  return (signal) => {
    if (stopping) return
    stopping = true
    deps.log(`${signal} received — shutting down`)
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
        setTimeout(deps.exit, exitDelayMs).unref()
      }
    })()
  }
}
