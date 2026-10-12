/**
 * The voice worker's entry point — ADR-101 §3–4, local-voice-spec C3.
 *
 * One process per host loads the speech model once and serves every capture
 * (the desktop window's and remote browsers') through `server.ts`. Keeping it out
 * of the host process isolates a native fault from the app and keeps ~1 s
 * decodes off Electron's main thread. The host starts it as the `voice-worker`
 * server subcommand or as the desktop's own main-process entry run with
 * `ELECTRON_RUN_AS_NODE=1`; both end up here.
 *
 *   --addon <dir>    the installed `sherpa-onnx-node` directory (`resolveVoicePack().addonDir`)
 *   --model <dir>    the Parakeet model directory
 *   --threads <n>    CPU threads (default {@link defaultThreads})
 *   CLAUDEUI_VOICE_TOKEN   the per-spawn secret; env, never argv — argv is
 *                          readable by every local user
 *
 * ## The contract with the host
 *
 * stdout carries exactly ONE line: `{"type":"listening","port":N}` once the model
 * is loaded and the server listens on `127.0.0.1`, or `{"type":"fatal","message"}`
 * followed by exit 1. A failure after `listening` is written to stderr only.
 * Diagnostics go to stderr. Audio, transcripts and the token
 * are written nowhere.
 *
 * The worker exits 0 when stdin ends (the parent is gone — the same lifetime tie
 * opencode's and pi's servers use) and 0 after ten minutes without a connection
 * (freeing ~0.8 GB); it exits 1 on an uncaught error, and the host respawns it on
 * the next capture. So the host must give it a stdin PIPE and keep it open: a
 * stdin that is closed or ignored reads as "parent gone" immediately.
 *
 * Everything the process touches is injectable, so the tests run the whole
 * lifecycle in-process against a fake recognizer.
 */

import * as os from 'node:os'
import * as util from 'node:util'
import { VOICE_TOKEN_ENV } from './protocol'
import { loadSherpaRecognizer, type Recognizer } from './recognizer'
import { createVoiceServer, realClock, type Clock } from './server'

// Defined in `protocol.ts` (import-free, shared with the host); re-exported here.
export { VOICE_TOKEN_ENV }

/** Half the cores, at least 2, at most 8: past that the int8 encoder stops scaling. */
export function defaultThreads(parallelism: number = os.availableParallelism()): number {
  return Math.min(8, Math.max(2, Math.floor(parallelism / 2)))
}

/**
 * Send `console.log` / `info` / `debug` to stderr. In the worker's real process
 * stdout carries exactly one protocol line, and a stray log from any module
 * (the server entry imports a large graph before this runs) must never become
 * that line. `warn` and `error` already go to stderr.
 */
export function routeConsoleToStderr(
  target: Pick<Console, 'log' | 'info' | 'debug'> = console,
  stderr: { write(chunk: string): unknown } = process.stderr
): void {
  const toStderr = (...args: unknown[]): void => void stderr.write(util.format(...args) + '\n')
  target.log = toStderr
  target.info = toStderr
  target.debug = toStderr
}

export interface VoiceWorkerOptions {
  /** Arguments after the subcommand. */
  argv?: string[]
  env?: NodeJS.ProcessEnv
  stdin?: { on(event: 'end' | 'close', listener: () => void): unknown; resume(): unknown }
  stdout?: { write(chunk: string, cb?: () => void): unknown }
  stderr?: { write(chunk: string): unknown }
  /** Leave the process. */
  exit?: (code: number) => void
  /**
   * Where `uncaughtException` / `unhandledRejection` are listened for. Defaults
   * to the real process, unless `exit` is injected (a test must not hook the
   * runner's process); a test of the crash path supplies an emitter.
   */
  processEvents?: {
    on(event: 'uncaughtException' | 'unhandledRejection', fn: (e: unknown) => void): unknown
  }
  loadRecognizer?: (addonDir: string, modelDir: string, threads: number) => Promise<Recognizer>
  clock?: Clock
  idleExitMs?: number
  parallelism?: number
}

export type VoiceWorkerResult =
  | { status: 'listening'; port: number; stop: () => Promise<void> }
  | { status: 'failed'; message: string }

interface ParsedArgs {
  addon: string
  model: string
  threads: number | null
}

/**
 * The subcommand name the server launches this under. Stripped when present, so
 * the same parse serves `bun src/server/main.ts voice-worker …` (argv after the
 * script still starts with it) and a compiled binary, and the desktop entry,
 * where it is absent.
 */
const SUBCOMMAND = 'voice-worker'

function parseArgs(rawArgv: string[]): ParsedArgs | string {
  const argv = rawArgv[0] === SUBCOMMAND ? rawArgv.slice(1) : rawArgv
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag !== '--addon' && flag !== '--model' && flag !== '--threads') {
      return `unknown argument: ${flag}`
    }
    if (value === undefined) return `${flag} needs a value`
    values.set(flag, value)
  }
  const addon = values.get('--addon')
  const model = values.get('--model')
  if (!addon) return '--addon <dir> is required'
  if (!model) return '--model <dir> is required'
  const rawThreads = values.get('--threads')
  if (rawThreads === undefined) return { addon, model, threads: null }
  const threads = Number(rawThreads)
  if (!Number.isInteger(threads) || threads < 1) return `--threads must be a positive integer`
  return { addon, model, threads }
}

export async function runVoiceWorker(options: VoiceWorkerOptions = {}): Promise<VoiceWorkerResult> {
  // First thing, before anything can log. Only in the real process: an injected
  // stdout means a test, which must not rewrite the runner's console.
  if (options.stdout === undefined) routeConsoleToStderr()
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const env = options.env ?? process.env

  // Once `listening` is out, stdout has said its one line and the host has read
  // it: a later death goes to stderr only, so "exactly one line" holds and the
  // host's log carries the reason.
  let listening = false
  const fatal = (message: string): VoiceWorkerResult => {
    if (listening) {
      stderr.write(`[voice-worker] fatal: ${message}\n`)
      exit(1)
    } else {
      stdout.write(JSON.stringify({ type: 'fatal', message }) + '\n', () => exit(1))
    }
    return { status: 'failed', message }
  }

  const events = options.processEvents ?? (options.exit === undefined ? process : null)
  if (events) {
    // Node would exit 1 on these anyway; the handlers add the host-readable line.
    // `message` only — a stack can embed argument values.
    const crash = (err: unknown): void => {
      fatal(err instanceof Error ? err.message : 'uncaught error')
    }
    events.on('uncaughtException', crash)
    events.on('unhandledRejection', crash)
  }

  // Parent lifetime first: a parent that dies during the multi-second model load
  // must not leave an orphan holding 0.8 GB.
  const stdin = options.stdin ?? process.stdin
  stdin.on('end', () => exit(0))
  stdin.on('close', () => exit(0))
  stdin.resume()

  const args = parseArgs(options.argv ?? process.argv.slice(2))
  if (typeof args === 'string') return fatal(args)
  const token = env[VOICE_TOKEN_ENV]
  if (!token) return fatal(`${VOICE_TOKEN_ENV} is not set`)
  const threads = args.threads ?? defaultThreads(options.parallelism)

  let recognizer: Recognizer
  try {
    recognizer = await (options.loadRecognizer ?? loadSherpaRecognizer)(
      args.addon,
      args.model,
      threads
    )
  } catch (err) {
    return fatal(`could not load the speech model: ${err instanceof Error ? err.message : err}`)
  }

  const server = createVoiceServer({
    recognizer,
    token,
    clock: options.clock ?? realClock,
    idleExitMs: options.idleExitMs,
    onIdleExit: () => exit(0),
    log: (message) => void stderr.write(`[voice-worker] ${message}\n`)
  })

  let port: number
  try {
    port = await server.listen()
  } catch (err) {
    return fatal(`could not listen: ${err instanceof Error ? err.message : err}`)
  }

  stdout.write(JSON.stringify({ type: 'listening', port }) + '\n')
  listening = true
  return { status: 'listening', port, stop: () => server.close() }
}
