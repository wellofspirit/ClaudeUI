/**
 * Wait for a Zustand store state to match a predicate.
 * Polls the store at short intervals until the predicate returns true or timeout.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function waitForStore<S>(
  store: { getState: () => S; subscribe: (listener: (state: S) => void) => () => void },
  predicate: (state: S) => boolean,
  timeoutMs = 5000,
  intervalMs = 10
): Promise<S> {
  // Check immediately
  const current = store.getState()
  if (predicate(current)) return current

  return new Promise<S>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`waitForStore timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const unsubscribe = store.subscribe((state) => {
      if (predicate(state)) {
        clearTimeout(timeout)
        unsubscribe()
        resolve(state)
      }
    })

    // Also poll in case subscriptions don't fire synchronously
    const poll = setInterval(() => {
      const s = store.getState()
      if (predicate(s)) {
        clearTimeout(timeout)
        clearInterval(poll)
        unsubscribe()
        resolve(s)
      }
    }, intervalMs)

    // Clear poll on timeout too
    setTimeout(() => {
      clearInterval(poll)
    }, timeoutMs + 10)
  })
}
