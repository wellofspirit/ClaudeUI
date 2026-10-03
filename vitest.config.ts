import { defineConfig } from 'vitest/config'
import { homedir } from 'os'
import { resolve } from 'path'

/**
 * ClaudeUI's real managed harness store (ADR-082 §8: opencode, pi and Codex
 * install there, only Claude Code is vendored). The setup files move HOME to a
 * throwaway directory, so it is named here, where homedir() is still the
 * developer's. An explicit CLAUDEUI_HARNESS_STORE wins.
 */
const realHarnessStore =
  process.env.CLAUDEUI_HARNESS_STORE ?? resolve(homedir(), '.claude', 'ui', 'harnesses')

const sharedAlias = {
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@test': resolve(__dirname, 'src/test'),
  // Redirect better-sqlite3 to a node:sqlite-backed shim so vitest (plain Node)
  // never loads the Electron-ABI native .node binary (ERR_DLOPEN_FAILED).
  'better-sqlite3': resolve(__dirname, 'src/test/stubs/better-sqlite3-stub.ts')
}

/**
 * Unit tests of non-renderer code run in plain Node: building a jsdom window
 * per file was the single largest cost of the suite (~85 s of CPU over these
 * ~430 files) and none of them touches the DOM. Renderer, web and anything
 * else stay on jsdom in `unit`.
 */
const NODE_UNIT_DIRS = [
  'src/main/**',
  'src/core/**',
  'src/shared/**',
  'src/server/**',
  'src/preload/**'
]

/** What `unit` and `unit-node` share; they differ only in environment and folders. */
const unitTest = {
  // Read-only, for the few unit tests that run a real installed binary
  // (rules-sync's execpolicy parser) and skip without it. Deliberately
  // not CLAUDEUI_HARNESS_STORE: unit tests that install or collect keep
  // writing to the throwaway home.
  env: { CLAUDEUI_TEST_HARNESS_STORE: realHarnessStore },
  include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.unit.test.{ts,tsx}'],
  // Git-backed filesystem tests are slow (real simple-git subprocess
  // calls on Windows cost ~150-200ms each). They live in their own
  // `git` project so the default `bun run test` can stay snappy; they
  // still run in CI and on-demand via `bun run test:git` /
  // `bun run test:git:changed`.
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.{idea,git,cache,output,temp}/**',
    // `*.test.*` above also matches `*.component.test.*`; those belong
    // to the `component` project alone, or every one runs twice.
    '**/*.component.test.{ts,tsx}',
    'src/main/services/__tests__/git-service*.test.ts',
    'src/main/services/__tests__/worktree.test.ts'
  ],
  testTimeout: 5000
}

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    // Global defaults
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup/jsdom.setup.ts'],

    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          ...unitTest,
          exclude: [...unitTest.exclude, ...NODE_UNIT_DIRS]
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit-node',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          ...unitTest,
          include: NODE_UNIT_DIRS.flatMap((dir) =>
            unitTest.include.map((glob) => glob.replace('src/**', dir))
          )
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'git',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          include: [
            'src/main/services/__tests__/git-service*.test.ts',
            'src/main/services/__tests__/worktree.test.ts'
          ],
          testTimeout: 30000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'component',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/**/__tests__/**/*.component.test.{ts,tsx}'],
          testTimeout: 10000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'e2e',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/e2e/**/*.e2e.test.{ts,tsx}'],
          testTimeout: 30000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          // The suites run the opencode, pi and Codex installed in the real
          // store, and skip without them.
          env: { CLAUDEUI_HARNESS_STORE: realHarnessStore },
          include: ['src/integration/**/*.integration.test.ts'],
          testTimeout: 60000
        }
      }
    ]
  }
})
