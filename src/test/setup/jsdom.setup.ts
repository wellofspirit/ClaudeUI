/**
 * jsdom test setup — loaded by unit, component, and e2e test projects.
 * Extends the existing setup with window.api stub support.
 */

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
