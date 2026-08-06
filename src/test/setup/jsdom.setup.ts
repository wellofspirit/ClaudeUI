/**
 * jsdom test setup — loaded by unit, component, and e2e test projects.
 * Extends the existing setup with window.api stub support.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect logger.ts's file output before anything in the test module graph
// can import it — otherwise every test run appends fixture noise to the real
// ~/.claude/ui/logs. `??=` lets an outer invocation still redirect explicitly.
process.env.CLAUDE_UI_LOG_DIR ??= join(tmpdir(), 'claudeui-vitest-logs')

import '@testing-library/jest-dom/vitest'

// Do not probe Node 25+'s native localStorage getter: without
// --localstorage-file, merely reading it emits an ExperimentalWarning in every
// worker. Tests need isolated storage anyway, so always install a fresh in-memory
// implementation for each jsdom environment.
const localStorageValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  enumerable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, String(value)),
    removeItem: (key: string) => localStorageValues.delete(key),
    clear: () => localStorageValues.clear(),
    get length() {
      return localStorageValues.size
    },
    key: (index: number) => [...localStorageValues.keys()][index] ?? null
  }
})

// jsdom ships no matchMedia, so any component reaching for a media query
// (useIsMobile, and everything that mounts it) would throw on mount. Install a
// never-matching stub: viewport-derived hooks then fall back to
// window.innerWidth (1024 in jsdom → desktop), and tests that need mobile mock
// the hook or override this stub themselves.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
  })
}

// Provide a minimal Notification stub for tests
if (!('Notification' in globalThis)) {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class Notification {
      static permission = 'denied'
      static requestPermission = async () => 'denied' as NotificationPermission
      constructor(_title: string, _options?: NotificationOptions) {}
    }
  })
}
