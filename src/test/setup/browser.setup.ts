/**
 * Browser-project setup (Layer 2b layout tests) — real Chromium, real CSS.
 *
 * Deliberately NOT jsdom.setup.ts: no throwaway home, no SQLite driver, no
 * node:fs. A layout test mounts a renderer component; all it needs from the host
 * is the stylesheet and a `window.api` that does not throw.
 */
// The node project has no DOM/Vite ambient types; this file is the one place a
// bare CSS import needs them.
/// <reference types="vite/client" />
import '../../renderer/src/assets/main.css'

/**
 * `window.api` where every member is a function resolving `{ success: true }`.
 * Layout tests never assert on it; the stub only has to survive being called
 * (and not look thenable, or an `await api` would hang on `then`).
 */
const api = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined
      return (): Promise<{ success: true }> => Promise.resolve({ success: true })
    }
  }
)

Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true })
