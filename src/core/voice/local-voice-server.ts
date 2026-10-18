/**
 * The host's handle on the voice worker — ADR-101 §3–4, local-voice-spec S2.
 *
 * ONE worker process per host serves every on-device capture (opencode, pi and
 * Codex sessions; the desktop window and every remote browser). This module owns
 * its life: spawned lazily by the first {@link LocalVoiceServer.acquire}, shared
 * by concurrent acquires, respawned by the next acquire after any exit, killed by
 * {@link LocalVoiceServer.stop}. What it hands back is the loopback `port` and the
 * per-spawn `token` the capture must present in `voice_start`
 * (`startFields`), so `BaseSession.voiceStartServer()` is one line.
 *
 * ## How the worker is launched
 *
 * The command is NOT decided here. A desktop worker is Electron run as Node on the
 * `voice-worker` main entry; a headless one is the server's own executable with a
 * `voice-worker` subcommand — different programs, same arguments. So each
 * entrypoint installs a {@link VoiceWorkerLauncher} (the `setSqliteDriver`
 * pattern) and there is deliberately no default: an uninstalled launcher throws a
 * message naming the fix instead of guessing a `node` that may not exist on the
 * machine (ADR-101 §4: no system Node).
 *
 * ## The process contract (`core/voice/worker/main.ts`)
 *
 *  - stdin is a PIPE this module keeps open for the worker's whole life: a stdin
 *    that ends reads as "parent gone" and the worker exits 0. Nothing is ever
 *    written to it.
 *  - Exactly the FIRST stdout line matters — `{"type":"listening","port":N}` or
 *    `{"type":"fatal","message":…}`. Later stdout is drained and ignored.
 *  - stderr is diagnostics; each line goes to the host log. The worker writes no
 *    audio, no transcript and no token anywhere, and neither does this module:
 *    the token lives in the child's env (argv is readable by every local user)
 *    and in memory, and is never logged.
 *  - The worker idle-exits ten minutes after its last authenticated connection,
 *    which races a start: {@link LocalVoiceServer.acquire} can hand out the port
 *    of a worker that is exiting. The caller retries once — see
 *    `VoiceStreamClient`'s `reacquire` hook.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { voicePackPlatformKey, voicePlatformUnsupportedMessage } from '../../shared/voice-pack'
import { logger } from '../services/logger'
import { resolveVoicePack, type ResolvedVoicePack } from './pack-store'
import { VOICE_TOKEN_ENV } from './worker/protocol'

const LOG_SOURCE = 'LocalVoice'

/**
 * How long a spawn may take to print its `listening` line. The model loads in
 * about 1.5 s; the ceiling is under the 30 s a remote client's `voice:start`
 * invoke waits, so a stuck worker is reported by us rather than as that timeout.
 */
export const VOICE_WORKER_START_TIMEOUT_MS = 20_000

/** How long {@link LocalVoiceServer.stop} waits for the exit before a hard kill. */
const STOP_GRACE_MS = 3_000

/**
 * Before its protocol line the worker's stdout may carry noise (a module-level
 * log in a large import graph). It is skipped, within these bounds, then the
 * start fails. Counted in characters of the decoded stream.
 */
const MAX_PRELUDE_LINES = 20
const MAX_PRELUDE_CHARS = 64 * 1024

/** A stderr line with no newline is dropped past this many characters. */
const MAX_STDERR_LINE_CHARS = 64 * 1024

/** Characters of stderr kept for the LOG of a worker that dies. Never in an Error. */
const STDERR_TAIL_CHARS = 2_000

/** The longest worker-supplied `fatal` message that reaches an Error (and so the pill). */
const MAX_FATAL_MESSAGE_CHARS = 300

/** Said to every `acquire()` while a {@link LocalVoiceServer.suspend} hold is on. */
export const VOICE_SERVER_HELD_MESSAGE = 'The speech model is being updated — try again in a moment'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The speech pack is not installed (or not usable) — the caller offers the download. */
export class VoicePackMissingError extends Error {
  readonly code = 'needs-voice-pack'
  constructor() {
    super('The on-device speech model is not installed')
    this.name = 'VoicePackMissingError'
  }
}

/** This host has no speech runtime (ADR-101 §8) — not fixable by installing. */
export class VoicePlatformUnsupportedError extends Error {
  readonly code = 'voice-platform-unsupported'
  constructor() {
    super(voicePlatformUnsupportedMessage())
    this.name = 'VoicePlatformUnsupportedError'
  }
}

/** Matches by `code`, so a copy of the class from another bundle still reads as one. */
export function isVoicePackMissing(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'needs-voice-pack'
}

// ---------------------------------------------------------------------------
// The launcher seam
// ---------------------------------------------------------------------------

/** A command line for one worker process. */
export interface VoiceWorkerLaunch {
  command: string
  args: string[]
  /** Added to the worker's environment (e.g. `ELECTRON_RUN_AS_NODE`). */
  env?: Record<string, string>
}

/**
 * Turn the worker's own arguments (`--addon <dir> --model <dir>`) into the full
 * command line of the entrypoint that is hosting this module.
 */
export type VoiceWorkerLauncher = (workerArgs: string[]) => VoiceWorkerLaunch

let installedLauncher: VoiceWorkerLauncher | null = null

/** Install (or clear, with `null`) this entrypoint's launcher. */
export function setVoiceWorkerLauncher(launcher: VoiceWorkerLauncher | null): void {
  installedLauncher = launcher
}

const NO_LAUNCHER_MESSAGE =
  'No voice worker launcher installed. The entrypoint must call setVoiceWorkerLauncher() ' +
  'before a voice capture can start (src/main/index.ts and src/server/main.ts do).'

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** What a capture needs to reach the worker. */
export interface LocalVoiceEndpoint {
  port: number
  /** Merged into `voice_start` (never logged). */
  startFields: { token: string }
}

export interface LocalVoiceServerDeps {
  getLauncher?: () => VoiceWorkerLauncher | null
  resolvePack?: () => ResolvedVoicePack | null
  platformKey?: () => string | null
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  startTimeoutMs?: number
}

interface Running {
  child: ChildProcess
  endpoint: LocalVoiceEndpoint
}

export class LocalVoiceServer {
  private running: Running | null = null
  private starting: Promise<LocalVoiceEndpoint> | null = null
  /** The child of the spawn in flight or running, so `stop()` can end either. */
  private current: ChildProcess | null = null
  private readonly exited = new WeakMap<ChildProcess, Promise<void>>()
  /** Children this module ended on purpose, so their exit is not logged as a crash. */
  private readonly ended = new WeakSet<ChildProcess>()
  /** The reason of the {@link LocalVoiceServer.suspend} hold in force, if any. */
  private hold: string | null = null

  constructor(private readonly deps: LocalVoiceServerDeps = {}) {}

  /** Is a worker up and listening? Diagnostics + tests. */
  isRunning(): boolean {
    return this.running !== null
  }

  /**
   * The worker's endpoint, spawning it when there is none. Concurrent calls share
   * one spawn. Throws {@link VoicePlatformUnsupportedError},
   * {@link VoicePackMissingError}, or an `Error` for a worker that would not start.
   */
  acquire(): Promise<LocalVoiceEndpoint> {
    if (this.hold !== null) return Promise.reject(new Error(VOICE_SERVER_HELD_MESSAGE))
    // A worker that has exited but whose `close` has not been seen yet is gone:
    // handing out its port is exactly the refused connect the caller retries on.
    const live = this.running
    if (live && live.child.exitCode === null && live.child.signalCode === null) {
      return Promise.resolve(live.endpoint)
    }
    if (this.starting) return this.starting

    const launcher = (this.deps.getLauncher ?? (() => installedLauncher))()
    if (!launcher) return Promise.reject(new Error(NO_LAUNCHER_MESSAGE))
    if (((this.deps.platformKey ?? voicePackPlatformKey)() ?? null) === null) {
      return Promise.reject(new VoicePlatformUnsupportedError())
    }
    const pack = (this.deps.resolvePack ?? resolveVoicePack)()
    if (!pack) return Promise.reject(new VoicePackMissingError())

    const starting = this.spawnWorker(launcher, pack).finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  /**
   * Kill the worker (if any) and wait for it to be gone — Windows keeps the DLLs
   * of a live process locked, so a pack removal must not start before this
   * resolves. A start in flight rejects its callers.
   */
  async stop(): Promise<void> {
    const child = this.current
    if (!child) return
    this.ended.add(child)
    const gone = this.exited.get(child) ?? Promise.resolve()
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    child.kill()
    let hardKill: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<void>((resolve) => {
      hardKill = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, STOP_GRACE_MS)
    })
    await Promise.race([gone, grace])
    clearTimeout(hardKill)
  }

  /**
   * Stop the worker AND keep it stopped: every `acquire()` rejects with
   * {@link VOICE_SERVER_HELD_MESSAGE} until the returned `release()` is called.
   * What a pack removal or reinstall needs — on Windows a live worker locks the
   * runtime's DLLs, and without the hold a voice press during the removal would
   * respawn it. A start in flight when the hold begins is rejected with the same
   * message.
   *
   * Holds do not nest: a second `suspend()` while one is in force throws (two
   * owners of one hold could release each other's). `release()` is idempotent and
   * only ever lifts its own hold.
   */
  async suspend(reason: string): Promise<() => void> {
    if (this.hold !== null) {
      throw new Error(`The speech model is already being updated (${this.hold})`)
    }
    this.hold = reason
    logger.info(LOG_SOURCE, `Voice worker held: ${reason}`)
    // Set BEFORE the stop, so nothing can respawn during it and the start being
    // killed reports the hold rather than "exited".
    try {
      await this.stop()
    } catch (err) {
      this.hold = null
      throw err
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.hold = null
      logger.info(LOG_SOURCE, `Voice worker hold released: ${reason}`)
    }
  }

  private spawnWorker(
    launcher: VoiceWorkerLauncher,
    pack: ResolvedVoicePack
  ): Promise<LocalVoiceEndpoint> {
    // 32 bytes of CSPRNG per spawn: another local user must not be able to drive
    // the worker (ADR-101 §2), and a respawn invalidates the old token.
    const token = randomBytes(32).toString('hex')
    const launch = launcher(['--addon', pack.addonDir, '--model', pack.modelDir])
    const spawn = this.deps.spawn ?? nodeSpawn
    const timeoutMs = this.deps.startTimeoutMs ?? VOICE_WORKER_START_TIMEOUT_MS

    return new Promise<LocalVoiceEndpoint>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(launch.command, launch.args, {
          env: { ...process.env, ...launch.env, [VOICE_TOKEN_ENV]: token },
          // stdin: the lifetime tie — kept open, never written (see the header).
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (err) {
        reject(new Error(`Could not start the voice worker: ${errMessage(err)}`))
        return
      }
      this.current = child
      logger.info(LOG_SOURCE, `Voice worker spawned (pid ${child.pid ?? '?'})`)

      let settled = false
      // Armed before anything can settle; `fail` is only ever called after it ran.
      const timer = setTimeout(() => {
        logger.warn(LOG_SOURCE, `Voice worker did not report ready in ${timeoutMs} ms — killing it`)
        fail(`The voice worker did not become ready within ${Math.round(timeoutMs / 1000)} s`, true)
      }, timeoutMs)
      let stderrTail = ''
      let ready = false
      const fail = (message: string, kill: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (kill) child.kill()
        reject(new Error(message))
      }
      const succeed = (port: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ready = true
        const endpoint: LocalVoiceEndpoint = { port, startFields: { token } }
        this.running = { child, endpoint }
        logger.info(LOG_SOURCE, `Voice worker listening on 127.0.0.1:${port}`)
        resolve(endpoint)
      }

      this.exited.set(
        child,
        new Promise<void>((done) => {
          // `close`, not `exit`: it fires once stdout is drained, so a `fatal`
          // line written just before dying is read before the generic failure.
          child.once('close', (code, signal) => {
            const how = code !== null ? `code ${code}` : `signal ${signal}`
            logger.info(LOG_SOURCE, `Voice worker exited (${how})`)
            if (this.running?.child === child) this.running = null
            if (this.current === child) this.current = null
            const tail = stderrTail.trim()
            if (ready && !this.ended.has(child) && (code !== 0 || signal !== null)) {
              // A crash while serving: visible at the default log level, with the
              // worker's last words. The next acquire respawns it.
              logger.warn(LOG_SOURCE, `Voice worker crashed (${how})${tail ? `: ${tail}` : ''}`)
            } else if (!settled && !this.ended.has(child)) {
              logger.warn(
                LOG_SOURCE,
                `Voice worker exited before it was ready (${how})${tail ? `: ${tail}` : ''}`
              )
            }
            // The Error is short: it reaches the pill and a remote client's
            // rejection. The stderr tail stays in the log above.
            fail(
              this.hold !== null
                ? VOICE_SERVER_HELD_MESSAGE
                : `The voice worker exited before it was ready (${how})`,
              false
            )
            done()
          })
        })
      )
      child.on('error', (err) => {
        // `spawn` failures (ENOENT) arrive here, with no `exit` after them.
        if (this.current === child) this.current = null
        fail(`Could not start the voice worker: ${err.message}`, false)
      })

      // The protocol line is the first line that parses as `listening` / `fatal`.
      // Anything before it is noise to skip (bounded); everything after it is
      // drained and ignored so a chatty worker can never block on a full pipe.
      // Decoded as a stream, so a multi-byte character split across chunks — or
      // the line itself split across chunks — survives.
      child.stdout?.setEncoding('utf8')
      let protocolSeen = false
      let pending = ''
      let preludeLines = 0
      let preludeChars = 0
      const notReady = (): void =>
        fail('The voice worker wrote something other than its ready line', true)
      child.stdout?.on('data', (chunk: string) => {
        if (protocolSeen) return
        pending += chunk
        let newline: number
        while (!protocolSeen && (newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          preludeChars += newline + 1
          const message = parseProtocolLine(line)
          if (message?.type === 'listening') {
            protocolSeen = true
            succeed(message.port)
          } else if (message?.type === 'fatal') {
            protocolSeen = true
            logger.warn(LOG_SOURCE, `Voice worker fatal: ${message.message}`)
            fail(
              `The voice worker could not start: ${message.message.slice(0, MAX_FATAL_MESSAGE_CHARS)}`,
              true
            )
          } else {
            if (line) logger.debug(LOG_SOURCE, `stdout before ready: ${line.slice(0, 200)}`)
            if (++preludeLines >= MAX_PRELUDE_LINES) {
              protocolSeen = true
              notReady()
            }
          }
        }
        if (!protocolSeen && preludeChars + pending.length > MAX_PRELUDE_CHARS) {
          protocolSeen = true
          notReady()
        }
      })

      child.stderr?.setEncoding('utf8')
      let stderrLine = ''
      child.stderr?.on('data', (text: string) => {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS)
        stderrLine += text
        let newline: number
        while ((newline = stderrLine.indexOf('\n')) !== -1) {
          const line = stderrLine.slice(0, newline).trimEnd()
          stderrLine = stderrLine.slice(newline + 1)
          if (line) logger.debug(LOG_SOURCE, line)
        }
        // A line with no newline is not held back forever by a hostile writer.
        if (stderrLine.length > MAX_STDERR_LINE_CHARS) stderrLine = ''
      })
      // The pipes can break when the child dies; the `exit` handler owns that.
      child.stdin?.on('error', () => undefined)
      child.stdout?.on('error', () => undefined)
      child.stderr?.on('error', () => undefined)
    })
  }
}

type ProtocolLine = { type: 'listening'; port: number } | { type: 'fatal'; message: string }

function parseProtocolLine(line: string): ProtocolLine | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (
      parsed.type === 'listening' &&
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port < 65536
    ) {
      return { type: 'listening', port: parsed.port }
    }
    if (parsed.type === 'fatal') {
      return { type: 'fatal', message: typeof parsed.message === 'string' ? parsed.message : '' }
    }
  } catch {
    /* not JSON */
  }
  return null
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The one worker for this host. */
export const localVoiceServer = new LocalVoiceServer()
