/**
 * Timeout wrapper for IPC calls from the renderer process.
 *
 * Races the given promise against a timeout. If the IPC call does not resolve
 * within `ms` milliseconds, the returned promise rejects with a descriptive error.
 *
 * Usage example:
 *   const dirs = await withTimeout(window.api.listDirectories(), 10_000, 'listDirectories')
 *
 * This utility is intentionally opt-in — apply it to critical IPC calls where
 * hanging would leave the UI in a bad state. Fire-and-forget calls (e.g.
 * session:send) stream results via events and should NOT be wrapped.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IPC timeout: ${label} (${ms}ms)`)), ms)
    )
  ])
}
