/**
 * The `claudeui-server` monitor (auto-update design §7, design review ruling 8).
 *
 * `serve` without `--worker` / `--no-monitor` runs THIS, a small parent that opens
 * no database, boots no service and wires no host adapter. It runs the real server
 * as a child (`serve --worker` plus the user's flags), and restarts it when the
 * worker asks (exit code {@link RESTART_EXIT_CODE}): a relaunch, or an update to a
 * release staged under `versions/` (layout: `server-layout.ts`).
 *
 * ## What it runs
 *
 * Compiled: `<root>/current` names the version, used only when it is a release
 * version, `versions/<v>` is a valid server folder of `<v>`, and `<v>` is newer than
 * the monitor's own build (a reinstall over the root must not be shadowed by an
 * older staged worker). Otherwise `current` is removed and the flat install (the
 * monitor's own executable) runs. From source: always the same source, no versions.
 *
 * ## Exits
 *
 * - After SIGINT/SIGTERM (`stopping`): exit with the worker's code, never restart
 *   (even on 75). POSIX forwards the signal; Windows does not (libuv's `kill` there
 *   is TerminateProcess, which would skip the worker's graceful stop): the worker
 *   gets its own console event, and is ended by pid after 8 s.
 * - The worker killed by a signal: the monitor re-raises it on itself.
 * - 75: restart (below). More than 3 within 60 s, none of whose workers reported
 *   healthy in between: exit 1.
 * - Any other code: exit with it (the user's supervisor decides) — unless an
 *   update's health window is open, which makes it a failed update: rollback.
 *
 * ## Restart, update, rollback
 *
 * On 75, `<root>/pending` (`{ token, from, to }`) asks for an update: `current = to`
 * is written and the new worker started under a 90 s health window. Its health
 * record (`server-records.ts`, written once its listener is bound) ends the window:
 * result `updated`, `pending` removed, old versions swept through the deletion gate
 * (`server-versions.ts`). No record in time, or the worker exits first: it is
 * stopped by pid, `current` goes back to what ran before (removed for the flat
 * install), that worker starts again, result `rolled-back`. Without `pending` the
 * same worker restarts (result `ok` once healthy, `no-health` if not). A monitor
 * that stops during a window leaves `current` and `pending` as they are; the next
 * start sees them and opens the window again. So does a rollback that cannot
 * restore `current` (a file held open on Windows): `pending` stays, so the next
 * start rolls back again, and this run never applies that request a second time.
 *
 * `--disable-auth` reaches the first worker that starts only: the policy it sets is
 * persisted, and a later restart must not undo a change made in Settings since.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { readBuildInfo } from '../core/services/build-info'
import { comparisonVersion } from '../shared/build-info'
import type { RelaunchMode, RelaunchResult, RelaunchStatus } from '../shared/relaunch'
import { isReleaseVersion } from '../shared/update-manifest'
import {
  MONITOR_ENV,
  MONITOR_PROTOCOL,
  MONITOR_ROOT_ENV,
  RESTART_EXIT_CODE,
  isNewer,
  isValidVersionDir,
  readCurrent,
  readPending,
  removeCurrent,
  removePending,
  sameName,
  serverExeName,
  versionDir,
  writeCurrent,
  type PendingUpdate
} from './server-layout'
import {
  installKeyFor,
  pruneResults,
  readHealth,
  serverStateDir,
  writeResult
} from './server-records'
import { gcServerVersions } from './server-versions'
import { isCompiledBunEntry } from './voice-worker-launcher'

export { RESTART_EXIT_CODE } from './server-layout'

export const HEALTH_WINDOW_MS = 90_000
export const HEALTH_POLL_MS = 500
/** Windows: how long a stopping worker gets to exit on its own console event. */
export const WINDOWS_STOP_GRACE_MS = 8_000
/** POSIX: SIGTERM, then SIGKILL after this, when the monitor itself stops a worker. */
export const KILL_GRACE_MS = 10_000
export const CRASH_LOOP = { max: 3, windowMs: 60_000 }

/** Where the monitor installed from, and its own build. */
export interface MonitorLayout {
  compiled: boolean
  root: string
  /** The flat worker: this executable (plus the script, from source). */
  flat: { command: string; prefixArgs: string[] }
  /** The monitor's build version, for logs and results. */
  ownVersion: string
  /** What a staged version must be newer than (null: unknown, so none is run). */
  ownComparison: string | null
}

export function resolveMonitorLayout(execPath: string, entry: string | undefined): MonitorLayout {
  if (isCompiledBunEntry(entry)) {
    const root = path.dirname(execPath)
    const info = readBuildInfo(root, true)
    return {
      compiled: true,
      root,
      flat: { command: execPath, prefixArgs: [] },
      ownVersion: info.kind === 'dev' ? 'unknown' : info.version,
      ownComparison: comparisonVersion(info)
    }
  }
  const script = entry === undefined ? null : path.resolve(entry)
  return {
    compiled: false,
    root: script ? path.dirname(script) : process.cwd(),
    flat: { command: execPath, prefixArgs: script ? [script] : [] },
    ownVersion: 'dev',
    ownComparison: null
  }
}

/** One way to start a worker. */
export interface WorkerTarget {
  /** The `versions/` folder; null for the flat install (or a source run). */
  version: string | null
  command: string
  prefixArgs: string[]
  /** How logs and results name it. */
  label: string
}

export function flatTarget(layout: MonitorLayout): WorkerTarget {
  return { version: null, ...layout.flat, label: layout.ownVersion }
}

export function versionTarget(
  layout: MonitorLayout,
  version: string,
  platform: string
): WorkerTarget {
  return {
    version,
    command: path.join(versionDir(layout.root, version), serverExeName(platform)),
    prefixArgs: [],
    label: version
  }
}

/** Why `versions/<v>` must not run, or null when it may. */
export function stagedVersionProblem(
  layout: MonitorLayout,
  version: string,
  platform: string
): string | null {
  if (!isReleaseVersion(version)) return 'it names no release version'
  if (!isValidVersionDir(layout.root, version, platform))
    return `versions/${version} is missing or not a valid server folder`
  if (layout.ownComparison === null) return "this install's own version is unknown"
  if (!isNewer(version, layout.ownComparison))
    return `it is not newer than this install (${layout.ownVersion})`
  return null
}

/** What to run at start: `current`'s version when usable, else the flat install (and `current` goes). */
export function chooseWorker(
  layout: MonitorLayout,
  platform: string,
  log: (message: string) => void
): WorkerTarget {
  const flat = flatTarget(layout)
  if (!layout.compiled) return flat
  const current = readCurrent(layout.root)
  if (current === null) return flat
  const problem = stagedVersionProblem(layout, current, platform)
  if (problem === null) return versionTarget(layout, current, platform)
  log(`ignoring current (${JSON.stringify(current)}): ${problem}; running the flat install`)
  const removed = removeCurrent(layout.root, platform)
  if (!removed.removed && removed.reason) log(`could not remove current: ${removed.reason}`)
  return flat
}

/** The user's arguments for every worker: everything after an explicit `serve`. */
export function workerArgsFrom(argv: readonly string[]): string[] {
  return argv[0] === 'serve' ? argv.slice(1) : [...argv]
}

/** The part of a `ChildProcess` the monitor uses. */
export interface ChildLike {
  readonly pid?: number
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  readonly stdin?: { on(event: 'error', listener: (err: Error) => void): unknown } | null
}

export type StopSignal = 'SIGINT' | 'SIGTERM'

export interface MonitorDeps {
  layout: MonitorLayout
  platform: string
  /**
   * The user's flags, passed after `serve --worker`: all of them to the first
   * worker that starts, then without `--disable-auth` (see the header).
   */
  workerArgs: readonly string[]
  env: NodeJS.ProcessEnv
  /** The relaunch state dir (health records, results). */
  stateDir: string
  /** Start a worker: stdin a pipe (the lifetime tie), stdout/stderr inherited, hidden window. */
  spawn: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildLike
  log: (message: string) => void
  exit: (code: number) => void
  /** Re-raise a fatal signal on this process (the monitor's handlers are already gone). */
  raise: (signal: NodeJS.Signals) => void
  /** Install a handler; returns its remover. */
  onSignal: (signal: StopSignal, handler: () => void) => () => void
  newToken?: () => string
  now?: () => number
  healthPollMs?: number
  healthWindowMs?: number
  windowsStopGraceMs?: number
  killGraceMs?: number
  crashLoop?: { max: number; windowMs: number }
}

export interface Monitor {
  start(): void
}

type Timer = ReturnType<typeof setTimeout>

interface WindowBase {
  token: string
  startedAt: number
  /** The worker the window waits on (set once it is spawned). */
  pid: number | undefined
  poll: ReturnType<typeof setInterval> | null
  deadline: Timer | null
}
interface RestartWindow extends WindowBase {
  kind: 'restart'
  fromLabel: string
}
interface UpdateWindow extends WindowBase {
  kind: 'update'
  /** What runs again on a rollback. */
  from: WorkerTarget
  to: string
}
type HealthWindow = RestartWindow | UpdateWindow

/** A health record's clock may trail the monitor's by this much (same machine). */
const CLOCK_SLACK_MS = 1_000

export function createMonitor(deps: MonitorDeps): Monitor {
  const { layout, platform, stateDir } = deps
  const root = layout.root
  const installKey = installKeyFor(root, platform)
  const now = deps.now ?? Date.now
  const newToken = deps.newToken ?? (() => randomBytes(16).toString('hex'))
  const pollMs = deps.healthPollMs ?? HEALTH_POLL_MS
  const windowMs = deps.healthWindowMs ?? HEALTH_WINDOW_MS
  const crashLoop = deps.crashLoop ?? CRASH_LOOP
  const log = deps.log

  let stopping = false
  let finished = false
  let child: ChildLike | null = null
  let running: WorkerTarget = flatTarget(layout)
  let window: HealthWindow | null = null
  let rollingBack: { window: UpdateWindow; reason: string } | null = null
  let stopTimer: Timer | null = null
  let killTimer: Timer | null = null
  /** Restart requests since a worker last reported healthy (the crash-loop guard). */
  const restarts: number[] = []
  const removers: Array<() => void> = []
  /** Rolled-back updates whose `current` could not be restored, by token: never applied again. */
  const unrestored = new Map<string, WorkerTarget>()
  const laterArgs = deps.workerArgs.filter((arg) => arg !== '--disable-auth')
  let started = false

  const describe = (target: WorkerTarget): string =>
    target.version !== null
      ? `versions/${target.version}`
      : layout.compiled
        ? `the flat install (${target.label})`
        : 'the server from source'

  function record(
    status: RelaunchStatus,
    mode: RelaunchMode,
    fromVersion: string,
    toVersion: string,
    token: string,
    reason?: string
  ): void {
    const result: RelaunchResult = {
      token,
      status,
      mode,
      fromVersion,
      toVersion,
      at: now(),
      ...(reason ? { reason } : {})
    }
    try {
      writeResult(stateDir, installKey, result, platform)
      pruneResults(stateDir, now())
    } catch (err) {
      log(`could not write the ${status} result: ${message(err)}`)
    }
  }

  function dropPending(): void {
    const removed = removePending(root, platform)
    if (!removed.removed && removed.reason) log(`could not remove pending: ${removed.reason}`)
  }

  /** Point `current` at `target` (remove it for the flat install); the error, or null. */
  function restoreCurrent(target: WorkerTarget): string | null {
    try {
      if (target.version !== null) writeCurrent(root, target.version, platform)
      else {
        const removed = removeCurrent(root, platform)
        if (!removed.removed && removed.reason) return removed.reason
      }
      return null
    } catch (err) {
      return message(err)
    }
  }

  // ── Windows ───────────────────────────────────────────────────────────────

  function openWindow(
    spec: Omit<RestartWindow, keyof WindowBase> | Omit<UpdateWindow, keyof WindowBase>,
    token: string
  ): void {
    const w = {
      ...spec,
      token,
      startedAt: now(),
      pid: undefined,
      poll: null,
      deadline: null
    } as HealthWindow
    w.poll = setInterval(() => checkHealth(w), pollMs)
    w.deadline = setTimeout(() => onWindowTimeout(w), windowMs)
    window = w
  }

  function closeWindow(): void {
    if (!window) return
    if (window.poll) clearInterval(window.poll)
    if (window.deadline) clearTimeout(window.deadline)
    window = null
  }

  function checkHealth(w: HealthWindow): void {
    if (window !== w || w.pid === undefined) return
    const health = readHealth(stateDir, installKey)
    if (!health || health.pid !== w.pid || health.at < w.startedAt - CLOCK_SLACK_MS) return
    closeWindow()
    // A worker that came up healthy ends any loop: only unhealthy restarts count.
    restarts.length = 0
    if (w.kind === 'update') {
      log(`${w.to} is healthy: updated from ${w.from.label}`)
      record('updated', 'swap', w.from.label, w.to, w.token)
      dropPending()
      const keep = [w.to, ...(w.from.version !== null ? [w.from.version] : [])]
      gcServerVersions(root, keep, { platform, log })
    } else {
      log('the restarted worker is healthy')
      record('ok', 'relaunch', w.fromLabel, health.version, w.token)
    }
  }

  function onWindowTimeout(w: HealthWindow): void {
    if (window !== w) return
    const seconds = Math.round(windowMs / 1000)
    if (w.kind === 'update') {
      startRollback(w, `${w.to} did not report healthy within ${seconds} s`)
      return
    }
    closeWindow()
    log(`the restarted worker did not report healthy within ${seconds} s; leaving it running`)
    record(
      'no-health',
      'relaunch',
      w.fromLabel,
      running.label,
      w.token,
      `no healthy start within ${seconds} s`
    )
  }

  // ── Workers ───────────────────────────────────────────────────────────────

  function launch(target: WorkerTarget): void {
    running = target
    const userArgs = started ? laterArgs : deps.workerArgs
    const args = [...target.prefixArgs, 'serve', '--worker', ...userArgs]
    const env: NodeJS.ProcessEnv = {
      ...deps.env,
      [MONITOR_ENV]: MONITOR_PROTOCOL,
      [MONITOR_ROOT_ENV]: root
    }
    log(`starting ${describe(target)}`)
    let c: ChildLike
    try {
      c = deps.spawn(target.command, args, env)
    } catch (err) {
      child = null
      const error = err instanceof Error ? err : new Error(String(err))
      queueMicrotask(() => afterExit(null, null, error))
      return
    }
    child = c
    if (c.pid !== undefined) started = true
    if (window) window.pid = c.pid
    let settled = false
    const done = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return
      settled = true
      if (child !== c) return
      child = null
      afterExit(code, signal, error)
    }
    c.on('exit', (code, signal) => done(code, signal))
    // After a successful spawn `exit` always follows; only a spawn failure ends here.
    c.on('error', (err) => {
      if (c.pid === undefined) done(null, null, err)
      else log(`worker: ${err.message}`)
    })
    // The pipe breaks when the worker exits; that is not the monitor's error.
    c.stdin?.on('error', () => undefined)
  }

  /**
   * Stop the worker the monitor started (by its pid, never by name) for a
   * rollback: SIGTERM, then SIGKILL (Windows: TerminateProcess at once). A worker
   * that still has not exited a while after that is abandoned (its exit is then
   * ignored), so the rollback never waits forever with nothing serving.
   */
  function stopChild(c: ChildLike): void {
    const grace = deps.killGraceMs ?? KILL_GRACE_MS
    const abandonLater = (): void => {
      killTimer = setTimeout(() => {
        if (child !== c) return
        log('the worker has not exited; going on without it')
        child = null
        afterExit(null, null)
      }, grace)
    }
    if (platform === 'win32') {
      c.kill()
      abandonLater()
      return
    }
    c.kill('SIGTERM')
    killTimer = setTimeout(() => {
      if (child !== c) return
      log(`the worker did not stop within ${Math.round(grace / 1000)} s; killing it`)
      c.kill('SIGKILL')
      abandonLater()
    }, grace)
  }

  function afterExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (finished) return
    if (killTimer) clearTimeout(killTimer)
    if (stopTimer) clearTimeout(stopTimer)
    killTimer = stopTimer = null
    const what = error
      ? `could not be started (${error.message})`
      : signal
        ? `was killed by ${signal}`
        : `exited with code ${code}`
    if (rollingBack) {
      finishRollback(code)
      return
    }
    const w = window
    closeWindow()

    if (stopping) {
      log(`the worker ${what}; stopping`)
      if (w?.kind === 'update')
        log(`${w.to} had not reported healthy; the next start checks it again`)
      if (signal) reraise(signal)
      else finish(code ?? 1)
      return
    }
    if (w?.kind === 'update') {
      startRollback(w, `${w.to} ${what} before it reported healthy`)
      return
    }
    if (w?.kind === 'restart')
      record(
        'no-health',
        'relaunch',
        w.fromLabel,
        running.label,
        w.token,
        `the server ${what} before it reported healthy`
      )
    if (error && running.version !== null) {
      log(`${describe(running)} ${what}; falling back to the flat install`)
      const removed = removeCurrent(root, platform)
      if (!removed.removed && removed.reason) log(`could not remove current: ${removed.reason}`)
      launch(flatTarget(layout))
      return
    }
    if (signal) {
      log(`the worker ${what}; the monitor ends the same way`)
      reraise(signal)
      return
    }
    if (code === RESTART_EXIT_CODE) {
      onRestartRequest()
      return
    }
    log(`the worker ${what}; exiting with its code`)
    finish(code ?? 1)
  }

  function updateProblem(pending: PendingUpdate): string | null {
    return stagedVersionProblem(layout, pending.to, platform)
  }

  function onRestartRequest(): void {
    const t = now()
    restarts.push(t)
    while (restarts.length > 0 && restarts[0] <= t - crashLoop.windowMs) restarts.shift()
    if (restarts.length > crashLoop.max) {
      log(
        `the worker asked for ${restarts.length} restarts within ${Math.round(crashLoop.windowMs / 1000)} s: ` +
          'giving up (exit 1) so a supervisor can see the loop'
      )
      finish(1)
      return
    }
    const from = running
    if (layout.compiled) {
      const pending = readPending(root)
      if (pending === 'invalid') {
        log('ignoring an unreadable pending update')
        dropPending()
      } else if (pending && unrestored.has(pending.token)) {
        // Already rolled back in this run; only `current` was left behind. Try again.
        const failure = restoreCurrent(unrestored.get(pending.token) as WorkerTarget)
        if (failure === null) {
          log('restored current after the earlier rollback')
          unrestored.delete(pending.token)
          dropPending()
        } else log(`still cannot restore current: ${failure}`)
      } else if (pending) {
        const problem = updateProblem(pending)
        if (problem === null) {
          startUpdate(pending, from)
          return
        }
        log(`not updating to ${pending.to}: ${problem}`)
        dropPending()
        record('failed', 'swap', from.label, pending.to, pending.token, problem)
      }
    }
    log(`restarting ${describe(from)}`)
    openWindow({ kind: 'restart', fromLabel: from.label }, newToken())
    launch(from)
  }

  function startUpdate(pending: PendingUpdate, from: WorkerTarget): void {
    try {
      writeCurrent(root, pending.to, platform)
    } catch (err) {
      const reason = `could not write current: ${message(err)}`
      log(`not updating to ${pending.to}: ${reason}`)
      dropPending()
      record('failed', 'swap', from.label, pending.to, pending.token, reason)
      openWindow({ kind: 'restart', fromLabel: from.label }, newToken())
      launch(from)
      return
    }
    log(`updating ${from.label} → ${pending.to}`)
    openWindow({ kind: 'update', from, to: pending.to }, pending.token)
    launch(versionTarget(layout, pending.to, platform))
  }

  function startRollback(w: UpdateWindow, reason: string): void {
    closeWindow()
    rollingBack = { window: w, reason }
    log(`rolling back to ${describe(w.from)}: ${reason}`)
    if (child) stopChild(child)
    else finishRollback(null)
  }

  function finishRollback(code: number | null): void {
    if (!rollingBack) return
    const { window: w, reason } = rollingBack
    rollingBack = null
    const failure = restoreCurrent(w.from)
    if (failure === null) {
      dropPending()
      record('rolled-back', 'swap', w.from.label, w.to, w.token, reason)
    } else {
      // `pending` stays: the next start sees `current` = `to` with it, reopens the
      // window and rolls back again. This run remembers the token instead.
      log(
        `could not restore current for ${describe(w.from)}: ${failure}; ` +
          'keeping pending so the next start rolls back again'
      )
      unrestored.set(w.token, w.from)
      record(
        'rolled-back',
        'swap',
        w.from.label,
        w.to,
        w.token,
        `${reason}; current could not be restored (${failure})`
      )
    }
    if (stopping) {
      log('stopping after the rollback')
      finish(code ?? 0)
      return
    }
    launch(w.from)
  }

  // ── Stopping ──────────────────────────────────────────────────────────────

  function onStopSignal(signal: StopSignal): void {
    if (finished) return
    const first = !stopping
    stopping = true
    if (first) log(`${signal} received; stopping the worker`)
    const c = child
    if (!c) {
      if (!rollingBack) finish(0)
      return
    }
    if (platform !== 'win32') {
      c.kill(signal)
      return
    }
    if (!first) return
    const grace = deps.windowsStopGraceMs ?? WINDOWS_STOP_GRACE_MS
    stopTimer = setTimeout(() => {
      if (child !== c) return
      log(`the worker did not stop within ${Math.round(grace / 1000)} s; ending it`)
      c.kill()
    }, grace)
  }

  function cleanup(): void {
    closeWindow()
    if (stopTimer) clearTimeout(stopTimer)
    if (killTimer) clearTimeout(killTimer)
    stopTimer = killTimer = null
    for (const remove of removers.splice(0)) remove()
  }

  function finish(code: number): void {
    if (finished) return
    finished = true
    cleanup()
    deps.exit(code)
  }

  function reraise(signal: NodeJS.Signals): void {
    if (finished) return
    finished = true
    cleanup()
    deps.raise(signal)
  }

  return {
    start(): void {
      removers.push(
        deps.onSignal('SIGINT', () => onStopSignal('SIGINT')),
        deps.onSignal('SIGTERM', () => onStopSignal('SIGTERM'))
      )
      const target = chooseWorker(layout, platform, log)
      const pending = layout.compiled ? readPending(root) : null
      if (
        pending &&
        pending !== 'invalid' &&
        target.version !== null &&
        sameName(target.version, pending.to, platform)
      ) {
        // The monitor stopped while this update's window was open: open it again.
        const from =
          pending.from !== null && stagedVersionProblem(layout, pending.from, platform) === null
            ? versionTarget(layout, pending.from, platform)
            : flatTarget(layout)
        log(`the update to ${pending.to} has not reported healthy yet; checking it again`)
        openWindow({ kind: 'update', from, to: pending.to }, pending.token)
        launch(target)
        return
      }
      if (pending !== null) {
        log('removing a pending update an earlier run left behind')
        dropPending()
      }
      launch(target)
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `claudeui-server [serve] [flags]` with no `--worker` / `--no-monitor`: run the monitor. */
export function runMonitor(argv: readonly string[]): void {
  const monitor = createMonitor({
    layout: resolveMonitorLayout(process.execPath, process.argv[1]),
    platform: process.platform,
    workerArgs: workerArgsFrom(argv),
    env: process.env,
    stateDir: serverStateDir(),
    spawn: (command, args, env) =>
      nodeSpawn(command, args, {
        env,
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true
      }),
    log: (line) => {
      process.stderr.write(`[monitor] ${line}\n`)
    },
    exit: (code) => process.exit(code),
    raise: (signal) => {
      process.kill(process.pid, signal)
      // A signal this runtime catches anyway must still end the monitor.
      setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), 1000)
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler)
      return () => {
        process.off(signal, handler)
      }
    }
  })
  monitor.start()
}
