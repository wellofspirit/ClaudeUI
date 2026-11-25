/**
 * Running a tool for the update host (`ditto`, `codesign`, `git`): argv only,
 * never a shell, so no path or requirement text is ever parsed by one. The
 * result carries the exit code instead of throwing, so a caller decides what a
 * non-zero exit means; tests inject their own.
 */

import { execFile } from 'node:child_process'

export interface ExecResult {
  /** The exit code; -1 when the tool could not start, was killed, or timed out. */
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
}

export type Exec = (
  file: string,
  args: readonly string[],
  opts?: ExecOptions
) => Promise<ExecResult>

/** The real one: `execFile`, 10 MB of output, two minutes unless told otherwise. */
export const execTool: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : typeof (err as { code?: unknown }).code === 'number'
              ? (err.code as number)
              : -1
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (err && code === -1 ? err.message : '')
        })
      }
    )
  })
