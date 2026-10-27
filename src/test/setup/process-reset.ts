/**
 * Process-level setup shared by every Node-hosted test project. It is the FIRST import of
 * `node.setup.ts` and `jsdom.setup.ts` and owns everything that is about the PROCESS rather than
 * the test environment.
 *
 * Why it exists: the unit, unit-node, component and e2e projects run on `vmForks`. A worker is one
 * process that runs many test files, each in its own vm context. A vm context isolates module state
 * and globals; it does NOT isolate the process: `process.env`, the cwd, process listeners, open
 * handles, native addons and the built-in modules (`fs`, `os`, ...) are the worker's, shared by every
 * file it runs. The plain `forks` pool (projects `git`, `integration`, `unit-forks`) starts a fresh
 * process per file, where all of this is a no-op. What each guard covers:
 *   - env + cwd:          restored at the start of every file
 *   - the home directory: a fresh throwaway home per FILE, with a tripwire
 *   - `exit` listeners:   removed (logger.ts adds one per file)
 *   - error listeners and handles a file leaves behind: the file fails (vm pools only)
 *   - native addons:      `process.dlopen` throws, and the file fails even if it swallows the throw
 *     (vm pools only; they cannot be loaded twice)
 *   - `instanceof Error`: Node's own errors (fs, fetch, AbortSignal) are accepted by the context's
 *     `Error` again (vm pools only; see below)
 *   - built-in module state (e.g. a patched `fs`) and the filesystem outside the per-file home:
 *     not guarded; a file that needs real isolation from those is a FORKS_ONLY candidate
 *
 * The snapshot lives on `process`, never in module scope: every file gets a fresh module registry,
 * so a module-scope snapshot would be re-taken (and the restore would restore nothing) per file.
 */

import { homedir, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { types } from 'node:util'
import { afterAll } from 'vitest'

/** The real clock, captured before the test file can install fake timers (they fake `performance`). */
const realNow = performance.now.bind(performance)

const KEY = Symbol.for('claudeui.processReset')

const ERROR_EVENTS = ['uncaughtException', 'unhandledRejection'] as const
// Handle types a test file must close (or unref) itself.
const LEAKY_RESOURCES = ['FSEventWrap', 'StatWatcher', 'TCPServerWrap', 'ProcessWrap'] as const

interface ProcessResetState {
  env: Record<string, string | undefined>
  cwd: string
  exitListeners: Set<(...args: never[]) => void>
  runId: string
  /** Counter of files this process has started: makes each file's home unique. */
  seq: number
  /** The test file being set up; read by the `dlopen` guard, which outlives the file's realm. */
  file: string
  dlopenGuarded: boolean
  /** Addons the current file tried to load; a swallowed throw must still fail the file. */
  dlopenAttempts: string[]
}

const holder = process as unknown as Record<symbol, ProcessResetState | undefined>
const state: ProcessResetState = (holder[KEY] ??= {
  env: { ...process.env },
  cwd: process.cwd(),
  exitListeners: new Set(process.listeners('exit') as never[]),
  runId: process.env.CLAUDEUI_TEST_RUN_ID ?? `${process.pid}-${Date.now()}`,
  seq: 0,
  file: 'the test file',
  dlopenGuarded: false,
  dlopenAttempts: []
})

// Vitest's own per-worker variables (VITEST_POOL_ID, VITEST_VM_POOL, ...) are set after the snapshot
// by the runner and must survive.
const isRunnerKey = (key: string): boolean => key.startsWith('VITEST') || key.startsWith('__VITEST')
// Windows env keys are case-insensitive: `Path` and `PATH` are one variable.
const envKey = (key: string): string => (process.platform === 'win32' ? key.toUpperCase() : key)

function restoreProcess(): void {
  const known = new Set(Object.keys(state.env).map(envKey))
  for (const key of Object.keys(process.env)) {
    if (!isRunnerKey(key) && !known.has(envKey(key))) delete process.env[key]
  }
  for (const [key, value] of Object.entries(state.env)) {
    if (!isRunnerKey(key) && value !== undefined && process.env[key] !== value) {
      process.env[key] = value
    }
  }
  if (process.cwd() !== state.cwd) process.chdir(state.cwd)
  for (const listener of process.listeners('exit')) {
    if (!state.exitListeners.has(listener)) process.removeListener('exit', listener as never)
  }
}

restoreProcess()

/**
 * Every FILE gets a throwaway home, before anything else in the setup.
 *
 * `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere AT CALL TIME, so redirecting
 * both here moves every `homedir()` in the process, and with it every `~/.claude` path a service
 * builds at import time. This is not tidiness: on 2026-09-21 a suite ran `UsageFetcher`'s
 * single-account path against the developer's REAL home and appended a wrong-account record to
 * `~/.claude/ui/usage/account-log.jsonl`, which re-attributed 61 turns by time. A test may not be
 * able to reach the real home to get that wrong.
 *
 * `vitest.config.ts` has already moved the main process's home (workers and their threads inherit
 * it); this is the per-file layer. The path is exported as CLAUDEUI_TEST_HOME for helpers.
 *
 * Deliberately never cleaned up per file: a write that lands after teardown is exactly what this
 * exists to catch, and it can only be seen if the directory survives. `vitest.config.ts` prunes
 * run directories older than a week.
 */
const testHome = join(tmpdir(), 'claudeui-test-home', state.runId, `${process.pid}-${state.seq++}`)
mkdirSync(testHome, { recursive: true })
process.env.USERPROFILE = testHome
process.env.HOME = testHome
process.env.CLAUDEUI_TEST_HOME = testHome

// The tripwire: a test file that would resolve the developer's real home must never run.
if (homedir() !== testHome) {
  throw new Error(
    "this file's test home is not in effect: homedir() is not the per-file test home. " +
      'Refusing to run a test file that could reach the real ~/.claude.'
  )
}

const isVmPool = process.env.VITEST_VM_POOL === '1'

if (isVmPool) {
  const filepath = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__
    ?.filepath
  // Repo-relative with forward slashes: the form FORKS_ONLY uses. Relative to the config's `root`
  // (not the cwd, which `vitest --root` from elsewhere leaves somewhere else).
  const root = (globalThis as { __vitest_worker__?: { config?: { root?: string } } })
    .__vitest_worker__?.config?.root
  if (filepath) state.file = relative(root ?? state.cwd, filepath).replaceAll('\\', '/')
  state.dlopenAttempts = []

  // Built-in modules are the worker's, not the context's, so an error that `fs` or `fetch` throws
  // is an instance of the HOST realm's `Error` and fails the context's own `instanceof Error`. That
  // would send production code down a branch it never takes in the app. Accept Node's own errors
  // again. Only the base class: `this === ContextError` keeps `RangeError` from matching a
  // `TypeError` check, which means subclass checks (`instanceof TypeError`) still differ from
  // production for host-realm errors.
  const ContextError = Error
  Object.defineProperty(ContextError, Symbol.hasInstance, {
    configurable: true,
    writable: true,
    value(this: unknown, value: unknown): boolean {
      return (
        Function.prototype[Symbol.hasInstance].call(this, value) ||
        (this === ContextError && types.isNativeError(value))
      )
    }
  })

  // A native addon is loaded once per process and cannot be loaded into a second vm context, so
  // it fails in confusing ways (or crashes) for the second file that needs it. Fail loudly instead.
  if (!state.dlopenGuarded) {
    state.dlopenGuarded = true
    process.dlopen = (_module: unknown, filename?: unknown): never => {
      const message = `native addon ${basename(String(filename))} loaded under vmForks: add ${state.file} to FORKS_ONLY in vitest.config.ts`
      state.dlopenAttempts.push(message)
      // Also printed: a loader that tries several paths (node-pty) keeps only the last error.
      console.error(message)
      throw new Error(message)
    }
  }

  // Leak guard. One file that leaves an error listener behind silences Vitest's unhandled-error
  // reporting for the rest of the worker; a leaked watcher, server or child keeps the worker busy
  // and is attributed to whatever file runs next.
  const countListeners = (): number[] => ERROR_EVENTS.map((event) => process.listenerCount(event))
  const countResources = (): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const name of process.getActiveResourcesInfo()) {
      if ((LEAKY_RESOURCES as readonly string[]).includes(name))
        counts[name] = (counts[name] ?? 0) + 1
    }
    return counts
  }
  const listenersAtStart = countListeners()
  const resourcesAtStart = countResources()
  const leakedResources = (): string[] => {
    const resources = countResources()
    return LEAKY_RESOURCES.flatMap((name) => {
      const leaked = (resources[name] ?? 0) - (resourcesAtStart[name] ?? 0)
      return leaked > 0
        ? [`${leaked} ${name} handle(s) left open: close the watcher/server/child process`]
        : []
    })
  }

  afterAll(async () => {
    const problems: string[] = []
    // A file that try/catches a native `require` (to skip when the addon will not load) would
    // otherwise turn the guard above into a silent skip.
    if (state.dlopenAttempts.length > 0) {
      problems.push(`${state.dlopenAttempts[0]} (the file caught the error)`)
    }
    const now = countListeners()
    ERROR_EVENTS.forEach((event, i) => {
      // Any change: removing Vitest's own listener silences error reporting just as a leak does.
      if (now[i] !== listenersAtStart[i]) {
        problems.push(
          `'${event}' listeners changed on process (${listenersAtStart[i]} -> ${now[i]}): restore them in afterEach/afterAll`
        )
      }
    })
    // A handle that `close()`/`kill()` was just called on stays listed until the loop has turned
    // once. Each threadpool round trip below is at least one turn. It is NOT a timer: some files
    // leave fake timers installed, and awaiting one would hang here. Bounded by wall time, so a
    // slow runner gets the same second as a fast one: `realNow` was taken before the file ran,
    // because fake timers also freeze `performance.now()`. The turn cap is the backstop.
    const settleUntil = realNow() + 1000
    for (let turn = 0; turn < 5000 && leakedResources().length > 0; turn++) {
      if (realNow() >= settleUntil) break
      await stat(testHome)
    }
    problems.push(...leakedResources())
    if (problems.length > 0)
      throw new Error(`Test file leaks process state:\n  ${problems.join('\n  ')}`)
  })
}
