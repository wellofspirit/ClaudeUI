import { defineConfig } from 'vitest/config'
import { availableParallelism, homedir, tmpdir } from 'os'
import { getHeapStatistics } from 'v8'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { MOBILE_PROFILES } from './scripts/lib/mobile-profiles.mjs'
import { createTestHomeRoot, pruneTestHomes } from './scripts/lib/test-home-root.mjs'

/**
 * The developer's real home, captured ONCE. Vitest re-resolves this config in the same process
 * (watch mode, the IDE's test runner), by which time the redirect below has already moved HOME, so
 * the first evaluation's answer is kept in the environment and every later one reads it back.
 */
const realHome = (process.env.CLAUDEUI_REAL_HOME ??= homedir())

/**
 * ClaudeUI's real managed harness store (ADR-082 §8: opencode, pi and Codex
 * install there, only Claude Code is vendored). The test home is a throwaway
 * directory, so the store is named here, from the developer's real home. An
 * explicit CLAUDEUI_HARNESS_STORE wins. Kept in the environment like the real home:
 * CLAUDEUI_HARNESS_STORE itself is dropped below, and a re-evaluation must find the answer.
 */
const realHarnessStore = (process.env.CLAUDEUI_REAL_HARNESS_STORE ??=
  process.env.CLAUDEUI_HARNESS_STORE ?? resolve(realHome, '.claude', 'ui', 'harnesses'))

/**
 * The main process's home, moved BEFORE Vitest starts a single worker. The setup files give every
 * test FILE its own home, but only a process-level move protects what they cannot: worker threads
 * (their `process.env` writes never reach `os.homedir()`), config and plugin code, and anything that
 * runs before a setup file. Workers inherit the environment, so even a pool that never runs a setup
 * file first cannot resolve the real home. `CLAUDEUI_TEST_RUN_ID` is set once and inherited, which is
 * also what makes a re-evaluation of this config a no-op.
 *
 * Playwright looks for browsers under the home on macOS and Linux (Windows uses LOCALAPPDATA, which
 * is untouched), so that default is pinned to the real location first.
 */
const TEST_HOME_ROOT = join(tmpdir(), 'claudeui-test-home')
const ownsRun = process.env.CLAUDEUI_TEST_RUN_ID === undefined
if (process.platform === 'darwin') {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(realHome, 'Library', 'Caches', 'ms-playwright')
} else if (process.platform !== 'win32') {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(
    process.env.XDG_CACHE_HOME || join(realHome, '.cache'),
    'ms-playwright'
  )
}
const testRunId = (process.env.CLAUDEUI_TEST_RUN_ID ??= `${process.pid}-${Date.now()}`)
const mainTestHome = join(TEST_HOME_ROOT, testRunId, 'main')
createTestHomeRoot(TEST_HOME_ROOT)
mkdirSync(mainTestHome, { recursive: true })
process.env.USERPROFILE = mainTestHome
process.env.HOME = mainTestHome

/**
 * Variables that move a directory the code would otherwise derive from the home. Left in place,
 * a developer's `CODEX_HOME` (or `XDG_CONFIG_HOME`, ...) sends services and spawned engines to
 * their REAL directories, home redirect or not. Dropped for the whole run: every worker inherits
 * this process's environment, and process-reset.ts snapshots it. A test that wants one sets it
 * itself; the integration project re-adds CLAUDEUI_HARNESS_STORE below. `os.userInfo().homedir`
 * still reports the real home and is not redirected.
 */
for (const name of [
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_TEST_HOME',
  'PI_CODING_AGENT_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_UI_LOG_DIR',
  'CLAUDEUI_HARNESS_STORE'
]) {
  delete process.env[name]
}

/**
 * Test homes are never cleaned up by the run that made them (a write after teardown is what they
 * exist to expose), so each run drops the run directories older than a week. Best effort: a run
 * directory another process holds open, or any other error, is simply left for next time. Nothing
 * is removed when the root itself is a link or another user's (scripts/lib/test-home-root.mjs).
 */
if (ownsRun) pruneTestHomes(TEST_HOME_ROOT, Date.now() - 7 * 24 * 60 * 60 * 1000)

/** The node_modules Node resolves from here: this checkout's, or (in a worktree) the main checkout's. */
const nodeModulesRoot = (() => {
  for (let dir = __dirname; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'node_modules'))) return resolve(dir, 'node_modules')
    if (dirname(dir) === dir) return resolve(__dirname, 'node_modules')
  }
})()

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

/**
 * Unit-node files that run on the plain `forks` pool (one fresh process per file) instead of
 * `vmForks` (many files per worker process, each in its own vm context). Only the reasons below
 * justify an entry; a file is not added because it is slow or flaky. The process-reset setup throws
 * when a native addon loads under `vmForks`, naming the file to add here.
 */
const FORKS_ONLY: Record<string, string> = {
  // node-pty is a native addon: it is loaded once per process and cannot be loaded into a second
  // vm context.
  'src/main/services/__tests__/pty-manager.test.ts': 'node-pty native addon',
  'src/main/services/__tests__/pty-pool.test.ts': 'node-pty native addon',
  'src/main/services/__tests__/pty-multi-attach.test.ts': 'node-pty native addon',
  'src/main/ipc/__tests__/terminal.ipc.test.ts': 'node-pty native addon',
  'src/main/services/__tests__/remote-terminal.test.ts': 'node-pty native addon',
  'src/main/services/__tests__/remote-step-up-tiers.test.ts': 'node-pty native addon',
  // `module.registerHooks` installs a hook on the process-wide module loader; it would stay
  // registered for every later file in the worker.
  'src/main/__tests__/electron-build-config.test.ts': 'module.registerHooks is process-global',
  // Asserts wall-clock CPU budgets (performance.now() around a parse); a worker shared with other
  // files' GC and vm-context overhead makes those measurements noisy.
  'src/core/automode/__tests__/ground-truth.test.ts': 'wall-clock CPU budget assertion',
  'src/core/permissions/__tests__/shell-rules.test.ts': 'wall-clock CPU budget assertion',
  // Loads the real better-sqlite3 addon (N-API prebuilts load under plain Node); under vmForks the
  // guard refuses it and the suite's native arm would be skipped.
  'src/core/services/__tests__/sqlite-driver.test.ts': 'better-sqlite3 native addon'
}
const FORKS_ONLY_FILES = Object.keys(FORKS_ONLY)

/**
 * `unit-node`'s `include` globs: a FORKS_ONLY entry must be one of those files, or it would be
 * excluded from nothing and run nowhere. Checked at config time, so a rename or a deleted test
 * breaks the run instead of silently dropping a test.
 */
const matchesUnitNode = (file: string): boolean =>
  NODE_UNIT_DIRS.some((dir) => file.startsWith(dir.replace('**', ''))) &&
  file.includes('/__tests__/') &&
  /\.test\.tsx?$/.test(file) &&
  !/\.(component|browser)\.test\.tsx?$/.test(file) &&
  !/\/(git-service[^/]*|worktree|worktree-git-[^/]*)\.test\.ts$/.test(file)
for (const file of FORKS_ONLY_FILES) {
  if (!existsSync(resolve(__dirname, file)) || !matchesUnitNode(file)) {
    throw new Error(`vitest.config.ts: FORKS_ONLY entry ${file} is not an existing unit-node test`)
  }
}

/**
 * The vm pool recycles a worker once its heap passes this. The default (total memory divided by
 * the worker count) is above V8's own heap limit, so a worker would never be recycled and the vm
 * contexts' retained memory (a few MB per file) would pile up until it ran out.
 */
const vmMemoryLimit = Math.floor(getHeapStatistics().heap_size_limit / 2)

/** What `unit` and `unit-node` share; they differ only in environment and folders. */
const unitTest = {
  // Read-only, for the few unit tests that run a real installed binary
  // (rules-sync's execpolicy parser) and skip without it. Deliberately
  // not CLAUDEUI_HARNESS_STORE: unit tests that install or collect keep
  // writing to the throwaway home.
  env: { CLAUDEUI_TEST_HARNESS_STORE: realHarnessStore },
  include: [
    'src/**/__tests__/**/*.test.{ts,tsx}',
    'src/**/__tests__/**/*.unit.test.{ts,tsx}',
    'scripts/judge-eval/match.test.ts',
    'scripts/judge-eval/extract-real.test.ts',
    'scripts/judge-eval/replay-scope.test.ts',
    'scripts/judge-eval/fs-facts.test.ts',
    'scripts/judge-eval/run-route.test.ts',
    'scripts/judge-eval/request-guard.test.ts'
  ],
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
    // to the `component` project alone, or every one runs twice. Same for
    // `*.browser.test.*` and the `browser` project (real Chromium, not jsdom).
    '**/*.component.test.{ts,tsx}',
    '**/*.browser.test.{ts,tsx}',
    'src/main/services/__tests__/git-service*.test.ts',
    'src/main/services/__tests__/worktree.test.ts',
    'src/main/services/__tests__/worktree-git-*.test.ts'
  ],
  testTimeout: 5000
}

export default defineConfig({
  resolve: { alias: sharedAlias },
  // A git worktree under .claude/worktrees has no node_modules of its own and resolves the main
  // checkout's: the browser project's Vite server must serve from there too (fonts, CSS), or every
  // browser suite fails with a NetworkError. `allow` alone is not honoured when several projects run
  // together, hence `strict: false` — a headless, localhost-only test server.
  server: { fs: { allow: [__dirname, nodeModulesRoot], strict: false } },
  test: {
    // Capped at 16: on a 32-thread host the full suite takes 158 s at 8 workers, 109 s at 16 and
    // 105 s at 24, where timing-sensitive tests start to flake (Chromium runs alongside the Node
    // workers). Low-core CI keeps Vitest's usual availableParallelism() - 1.
    maxWorkers: Math.max(1, Math.min(16, availableParallelism() - 1)),
    // Keep setup project-local: Vitest 5 merges root setupFiles into every project.
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit',
          environment: 'jsdom',
          pool: 'vmForks',
          vmMemoryLimit,
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
          pool: 'vmForks',
          vmMemoryLimit,
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          ...unitTest,
          include: NODE_UNIT_DIRS.flatMap((dir) =>
            unitTest.include
              .filter((glob) => glob.startsWith('src/**'))
              .map((glob) => glob.replace('src/**', dir))
          ),
          exclude: [...unitTest.exclude, ...FORKS_ONLY_FILES]
        }
      },
      {
        // unit-node's opt-out: one fresh process per file, for the files in FORKS_ONLY.
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit-forks',
          environment: 'node',
          pool: 'forks',
          globals: true,
          setupFiles: ['./src/test/setup/node.setup.ts'],
          ...unitTest,
          include: FORKS_ONLY_FILES
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
            'src/main/services/__tests__/worktree.test.ts',
            'src/main/services/__tests__/worktree-git-*.test.ts'
          ],
          testTimeout: 30000
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'component',
          environment: 'jsdom',
          pool: 'vmForks',
          vmMemoryLimit,
          globals: true,
          setupFiles: ['./src/test/setup/jsdom.setup.ts'],
          include: ['src/**/__tests__/**/*.component.test.{ts,tsx}'],
          testTimeout: 10000
        }
      },
      {
        // Layout tests (docs/testing-strategy.md, Layer 2b): real Chromium at the
        // owner's phone size, real Tailwind CSS. jsdom evaluates no layout, so
        // anything that is a claim about geometry lives here. NOT the jsdom/sqlite
        // setup: this project has its own.
        resolve: { alias: sharedAlias },
        plugins: [react(), tailwindcss()],
        test: {
          name: 'browser',
          globals: true,
          setupFiles: ['./src/test/setup/browser.setup.ts'],
          include: ['src/**/__tests__/**/*.browser.test.{ts,tsx}'],
          testTimeout: 10000,
          // Failure screenshots and attachments would otherwise land in the
          // source tree (`__screenshots__`, `.vitest-attachments`).
          attachmentsDir: '.cache/vitest-attachments',
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright(),
            instances: [
              {
                browser: 'chromium',
                viewport: {
                  width: MOBILE_PROFILES['s25-ultra-edge'].width,
                  height: MOBILE_PROFILES['s25-ultra-edge'].height
                }
              }
            ]
          }
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'e2e',
          environment: 'jsdom',
          pool: 'vmForks',
          vmMemoryLimit,
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
