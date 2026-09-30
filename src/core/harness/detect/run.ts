/**
 * Run a short-lived helper process and capture its stdout (ADR-082 §3):
 * `reg.exe`, the login shell, `node --version` and the harness `--version`
 * probes all go through here.
 *
 * - `shell: false`, `windowsHide`, stdin closed (a login shell's rc files may
 *   prompt), stderr discarded.
 * - stdout is capped; bytes past the cap are dropped.
 * - On timeout the whole process tree is killed (`killProcessTree`).
 * - Never rejects: a spawn error, a timeout or a non-zero exit is in the result.
 */
import { spawn as realSpawn } from 'node:child_process'
import { killProcessTree } from '../../services/process-tree'

export interface RunOptions {
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Stop collecting stdout after this many bytes (default 64 KB). */
  maxStdoutBytes?: number
}

export interface RunResult {
  stdout: string
  /** Exit code; null when the process was killed, timed out or never started. */
  code: number | null
  timedOut: boolean
  /** The spawn error's message, when the process could not be started. */
  error?: string
}

export type RunFn = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>

export type SpawnFn = typeof realSpawn

const DEFAULT_MAX_STDOUT = 64 * 1024

/** A `RunFn` over `spawnFn` (the real `child_process.spawn` by default). */
export function makeRun(spawnFn: SpawnFn = realSpawn): RunFn {
  return (command, args, options) =>
    new Promise<RunResult>((resolve) => {
      const max = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT
      const chunks: Buffer[] = []
      let size = 0
      let timedOut = false
      let settled = false
      let child: ReturnType<SpawnFn> | undefined

      const finish = (result: Omit<RunResult, 'stdout' | 'timedOut'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), timedOut, ...result })
      }

      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child) killProcessTree(child)
        } catch {
          // Already gone.
        }
        finish({ code: null })
      }, options.timeoutMs)

      try {
        child = spawnFn(command, [...args], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          ...(options.env ? { env: options.env } : {})
        })
      } catch (err) {
        finish({ code: null, error: err instanceof Error ? err.message : String(err) })
        return
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (size >= max) return
        const room = max - size
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        chunks.push(part)
        size += part.length
      })
      child.on('error', (err: Error) => finish({ code: null, error: err.message }))
      child.on('close', (code: number | null) => finish({ code: timedOut ? null : code }))
    })
}

/** The real runner. */
export const runCapture: RunFn = makeRun()
