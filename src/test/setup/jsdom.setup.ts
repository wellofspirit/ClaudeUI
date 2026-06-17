/**
 * jsdom test setup — loaded by unit, component, and e2e test projects.
 * Extends the existing setup with window.api stub support.
 */

import '@testing-library/jest-dom/vitest'

// Provide an in-memory `localStorage` whenever the runtime doesn't give us a
// working one. Two cases this covers:
//   - Node 25+ ships a native `localStorage` getter that shadows jsdom's mock
//     (present as an object, but `getItem` isn't callable).
//   - Some bun versions expose no `localStorage` at all unless launched with
//     `--localstorage-file`, leaving it `undefined`.
// When the runtime DOES provide a working localStorage (e.g. CI), `getItem`
// is already a function and this block is skipped.
if (typeof globalThis.localStorage?.getItem !== 'function') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size
      },
      key: (index: number) => [...store.keys()][index] ?? null
    }
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
