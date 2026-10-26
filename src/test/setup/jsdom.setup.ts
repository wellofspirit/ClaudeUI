/**
 * jsdom test setup — loaded by unit, component, and e2e test projects.
 * Extends the existing setup with window.api stub support.
 */

// Process-level setup (per-file home + tripwire, env/cwd/listener restore, leak and native-addon
// guards) lives in one module and must be the FIRST import: see its header.
import './process-reset'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No background harness detection (ADR-082 §3) in a test process: a boot
// test's `startCoreServices` would otherwise probe every Claude Code,
// opencode, pi and Codex on this machine's PATH a few seconds later. Tests of
// the scheduler build their own (`createDetectionScheduler`).
process.env.CLAUDEUI_DISABLE_HARNESS_DETECTION = '1'

// Redirect logger.ts's file output before anything in the test module graph
// can import it — otherwise every test run appends fixture noise to the real
// ~/.claude/ui/logs. `??=` lets an outer invocation still redirect explicitly.
process.env.CLAUDE_UI_LOG_DIR ??= join(tmpdir(), 'claudeui-vitest-logs')

// Install the SQLite driver for the test process (S3 stage 1). `db.ts` talks to
// a driver seam now and deliberately has no default, so every entrypoint —
// including this one — must name its engine.
//
// `betterSqlite3Driver` resolves through the long-standing `resolve.alias` to
// `src/test/stubs/better-sqlite3-stub.ts`, i.e. an in-memory `node:sqlite`. That
// is the SAME engine and the SAME isolation tests have always had, which is
// exactly the point: the seam must not change what the suite runs against.
import { setSqliteDriver } from '../../core/services/sqlite-driver'
import { betterSqlite3Driver } from '../../core/services/sqlite/better-sqlite3-driver'

setSqliteDriver(betterSqlite3Driver())

import { expect } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

expect.extend(matchers)

// Vitest 5 browser types shadow jest-dom's regex overload. This setup registers
// jest-dom at runtime; restore its synchronous overload without widening
// expect.element's asynchronous browser assertions.
declare module 'vitest' {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toHaveTextContent(text?: string | number, options?: { normalizeWhitespace: boolean }): R
    toHaveTextContent(
      this: Assertion<void, T>,
      text: RegExp,
      options?: { normalizeWhitespace: boolean }
    ): R
  }
}

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
