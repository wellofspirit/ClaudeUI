/**
 * The relaunch job: every parameter the helper acts on, written once by the
 * main process before the helper starts. The helper scripts are fixed text
 * (`helper-scripts.ts`); everything that varies is here, so nothing a client
 * sends ever reaches a command line (design review ruling 9).
 *
 * Two renderings of one object, from one function each: `<t>.job.json` for
 * PowerShell (`ConvertFrom-Json`) and `<t>.job.sh` for bash (`source`), the
 * latter as POSIX single-quoted `KEY='value'` lines so no path can break out.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { isShortCommit, type RelaunchMode } from '../../../shared/relaunch'
import type { RelaunchPlatform } from './paths'

export interface RelaunchTimeouts {
  /** Wait for the old process to exit. Timeout: `aborted`, nothing touched. */
  waitPidSec: number
  /** Windows: wait for processes running from the install to exit on their own. */
  lockWaitSec: number
  /** After stopping processes by pid, wait this long for them to go. */
  killWaitSec: number
  /** After a launch, if nothing runs from the install by then, launch once more. */
  launchCheckSec: number
  /** Wait for a health record newer than the job. */
  healthSec: number
}

export const DEFAULT_TIMEOUTS: RelaunchTimeouts = {
  waitPidSec: 120,
  lockWaitSec: 20,
  killWaitSec: 10,
  launchCheckSec: 15,
  healthSec: 90
}

/** `{app}` in a launch argument stands for the folder to launch (the install, or a backup). */
export const LAUNCH_APP_PLACEHOLDER = '{app}'

export interface RelaunchJob {
  schema: 1
  token: string
  /** The process that must exit before anything is touched. */
  pid: number
  platform: RelaunchPlatform
  mode: RelaunchMode
  installPath: string
  installKey: string
  /** The state dir the helper writes its ready/result/log/lock files in. */
  stateDir: string
  /** `swap` only. */
  stagedPath: string
  backupPath: string
  failedPath: string
  fromVersion: string
  toVersion: string
  /** Epoch ms. A health record must be newer than this. */
  startedAt: number
  /** The launch argv; `{app}` is replaced by the folder being launched. */
  launch: string[]
  timeouts: RelaunchTimeouts
  /**
   * For the app only (the helper scripts never read them): the short commits
   * of the running build and of the one asked for, from the install markers'
   * build ids, and where a swap's build came from. `lastResultFor` merges them
   * into the result the helper writes, so the notice can name the builds when
   * the two versions are equal.
   */
  fromBuild?: string
  toBuild?: string
  source?: 'release' | 'rebuild'
}

/**
 * The variables a macOS relaunch carries over with `open --env`. What `open -n`
 * hands the new app differs by macOS version: recent ones (verified on 27.2)
 * pass the caller's whole environment, older ones start the app with the login
 * session's. This allowlist is what guarantees, on every version, that a
 * ClaudeUI started with another profile (HOME, CLAUDE_CONFIG_DIR), a mode
 * switch or a proxy comes back with it. An allowlist, because the job files sit
 * on disk: nothing credential-shaped beyond what a proxy URL itself carries.
 * Windows needs none (`Start-Process` inherits the helper's environment, which
 * is the app's).
 */
export const RELAUNCH_ENV_KEYS: readonly string[] = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDEUI_HARNESS_STORE',
  'CLAUDEUI_ALLOW_MULTIPLE_INSTANCES',
  'CLAUDEUI_DISABLE_REMOTE',
  'CLAUDEUI_HEADLESS',
  'CLAUDEUI_NO_WINDOW',
  'CLAUDEUI_VERIFIER_HOOKS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
]

/**
 * The arguments this process was started with, to start the next one the same
 * way: `argv` minus the executable, an earlier relaunch token and macOS's
 * `-psn_…` process serial number.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('--relaunch-token=') && !a.startsWith('-psn_'))
}

/** The argv that starts an installed ClaudeUI; never client-supplied. */
export function defaultLaunch(
  platform: RelaunchPlatform,
  exeName: string,
  token: string,
  carry: { args?: readonly string[]; env?: Readonly<Record<string, string | undefined>> } = {}
): string[] {
  const args = [...(carry.args ?? []), `--relaunch-token=${token}`]
  if (platform !== 'darwin') return [`${LAUNCH_APP_PLACEHOLDER}\\${exeName}`, ...args]
  const env = carry.env ?? {}
  const envFlags = RELAUNCH_ENV_KEYS.flatMap((k) => {
    const v = env[k]
    return v === undefined ? [] : ['--env', `${k}=${v}`]
  })
  return ['open', '-n', ...envFlags, LAUNCH_APP_PLACEHOLDER, '--args', ...args]
}

/** POSIX single-quote a value: `'` → `'\''`. Safe for any byte but NUL. */
export function shQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A job value cannot contain a NUL byte')
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `<t>.job.sh`: one `JOB_KEY='value'` line per field, `JOB_LAUNCH=( ... )` for the argv. */
export function jobShellText(job: RelaunchJob): string {
  const scalars: Array<[string, string | number]> = [
    ['JOB_SCHEMA', job.schema],
    ['JOB_TOKEN', job.token],
    ['JOB_PID', job.pid],
    ['JOB_PLATFORM', job.platform],
    ['JOB_MODE', job.mode],
    ['JOB_INSTALL', job.installPath],
    ['JOB_INSTALL_KEY', job.installKey],
    ['JOB_STATE_DIR', job.stateDir],
    ['JOB_STAGED', job.stagedPath],
    ['JOB_BACKUP', job.backupPath],
    ['JOB_FAILED', job.failedPath],
    ['JOB_FROM_VERSION', job.fromVersion],
    ['JOB_TO_VERSION', job.toVersion],
    ['JOB_STARTED_AT', job.startedAt],
    ['JOB_WAIT_PID_SEC', job.timeouts.waitPidSec],
    ['JOB_LOCK_WAIT_SEC', job.timeouts.lockWaitSec],
    ['JOB_KILL_WAIT_SEC', job.timeouts.killWaitSec],
    ['JOB_LAUNCH_CHECK_SEC', job.timeouts.launchCheckSec],
    ['JOB_HEALTH_SEC', job.timeouts.healthSec]
  ]
  const lines = scalars.map(([k, v]) => `${k}=${shQuote(String(v))}`)
  lines.push(`JOB_LAUNCH=(${job.launch.map(shQuote).join(' ')})`)
  return `# ClaudeUI relaunch job ${job.token} (parameters only)\n${lines.join('\n')}\n`
}

/** `<t>.job.json`. */
export function jobJsonText(job: RelaunchJob): string {
  return `${JSON.stringify(job, null, 2)}\n`
}

/** Write a file atomically (temp + rename), owner-only. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* the temp never landed */
    }
    throw err
  }
}

export interface RetryingWriteOptions {
  /** Retries happen on win32 only (default: this process's platform). */
  platform?: string
  /** Injectable for tests (default `fs.renameSync`). */
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  delayMs?: number
}

/** The rename errors Windows raises while another process holds the target open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * {@link writeAtomic} for files another process reads while we replace them (the
 * health record the Windows helper polls, results, the restore record). On
 * Windows a reader without delete sharing makes the replacing rename fail with
 * EPERM/EBUSY/EACCES for a moment, so it is retried (20 × 250 ms by default);
 * anywhere else, and for any other error, the first failure is final.
 */
export async function writeAtomicRetrying(
  file: string,
  text: string,
  options: RetryingWriteOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const rename = options.rename ?? fs.renameSync
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts = options.attempts ?? 20
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    for (let attempt = 1; ; attempt++) {
      try {
        rename(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (platform !== 'win32' || !TRANSIENT_RENAME_CODES.has(code) || attempt >= attempts)
          throw err
        await sleep(options.delayMs ?? 250)
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* the temp never landed, or was renamed */
    }
    throw err
  }
}

/** Write both renderings of the job. */
export function writeJobFiles(files: { json: string; sh: string }, job: RelaunchJob): void {
  fs.mkdirSync(path.dirname(files.json), { recursive: true })
  writeAtomic(files.json, jobJsonText(job))
  writeAtomic(files.sh, jobShellText(job))
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A job file read back (boot reconciliation), or null when it is not one. */
export function parseJob(raw: unknown): RelaunchJob | null {
  if (!isRecord(raw) || raw.schema !== 1) return null
  const str = (k: string): string | null => (typeof raw[k] === 'string' ? (raw[k] as string) : null)
  const token = str('token')
  if (!token || !/^[0-9a-f]{32}$/.test(token)) return null
  if (raw.platform !== 'darwin' && raw.platform !== 'win32') return null
  if (raw.mode !== 'relaunch' && raw.mode !== 'swap') return null
  const fields = [
    'installPath',
    'installKey',
    'stateDir',
    'stagedPath',
    'backupPath',
    'failedPath',
    'fromVersion',
    'toVersion'
  ]
  if (fields.some((k) => str(k) === null)) return null
  if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'number') return null
  if (!Array.isArray(raw.launch) || !raw.launch.every((a) => typeof a === 'string')) return null
  const t = raw.timeouts
  if (!isRecord(t)) return null
  const timeouts = { ...DEFAULT_TIMEOUTS }
  for (const k of Object.keys(DEFAULT_TIMEOUTS) as Array<keyof RelaunchTimeouts>) {
    if (typeof t[k] !== 'number') return null
    timeouts[k] = t[k] as number
  }
  const source: RelaunchJob['source'] =
    raw.source === 'release' || raw.source === 'rebuild' ? raw.source : undefined
  const facts: Pick<RelaunchJob, 'fromBuild' | 'toBuild' | 'source'> = {
    ...(isShortCommit(raw.fromBuild) ? { fromBuild: raw.fromBuild } : {}),
    ...(isShortCommit(raw.toBuild) ? { toBuild: raw.toBuild } : {}),
    ...(source ? { source } : {})
  }
  return {
    ...facts,
    schema: 1,
    token,
    pid: raw.pid,
    platform: raw.platform,
    mode: raw.mode,
    installPath: str('installPath')!,
    installKey: str('installKey')!,
    stateDir: str('stateDir')!,
    stagedPath: str('stagedPath')!,
    backupPath: str('backupPath')!,
    failedPath: str('failedPath')!,
    fromVersion: str('fromVersion')!,
    toVersion: str('toVersion')!,
    startedAt: raw.startedAt,
    launch: raw.launch as string[],
    timeouts
  }
}
