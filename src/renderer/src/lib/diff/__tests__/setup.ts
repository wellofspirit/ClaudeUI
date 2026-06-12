import '@testing-library/jest-dom/vitest'

// Node 25+ ships a native `localStorage` getter that shadows jsdom's mock
// when `--localstorage-file` isn't configured. Override it with a simple
// in-memory implementation so jsdom-based tests work correctly.
if (
  typeof globalThis.localStorage === 'object' &&
  typeof globalThis.localStorage?.getItem !== 'function'
) {
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
