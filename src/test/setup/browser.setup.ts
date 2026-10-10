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
import '../../renderer/src/assets/app.css'
// One pinned UI font for every run (fontsource ships the files, no network).
// The app's stack is the SYSTEM font (`-apple-system, BlinkMacSystemFont,
// 'Segoe UI', 'Noto Sans', …`), so a geometry assertion measured whichever
// font the host had: Noto/Helvetica on Linux CI, SF Pro on the macOS release
// runner — and neither is the reference phone's Roboto (Android, see
// scripts/lib/mobile-profiles.mjs). The same test passed on one OS and failed
// on another. Roboto at the weights the components use (font-normal, -medium,
// -semibold, -bold) makes the measurement the same everywhere and the one the
// profile claims.
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/600.css'
import '@fontsource/roboto/700.css'
import { beforeAll } from 'vitest'

const pinned = document.createElement('style')
pinned.textContent = `
  :root { --font-sans: 'Roboto', sans-serif; }
  html, body { font-family: 'Roboto', sans-serif !important; }
`
document.head.appendChild(pinned)

// A layout measured before the face has loaded is measured in the fallback.
beforeAll(async () => {
  await Promise.all(
    ['400', '500', '600', '700'].map((weight) => document.fonts.load(`${weight} 13px Roboto`))
  )
  await document.fonts.ready
  if (!document.fonts.check('13px Roboto')) throw new Error('the pinned Roboto font did not load')
})

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
