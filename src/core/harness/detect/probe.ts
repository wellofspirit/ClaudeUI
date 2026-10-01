/**
 * Run a resolved harness's `--version` in isolation (ADR-082 §3; side effects
 * and recipes in the ADR-082 research, §3):
 *
 *   Claude Code  `--version` as the ONLY argument (anything else leaves its
 *                fast path), `CLAUDE_CONFIG_DIR` = a fresh directory, updates
 *                and non-essential traffic off
 *   opencode     the four XDG directories = a fresh directory (it creates its
 *                directories at import), autoupdate and models fetch off
 *   pi           `PI_CODING_AGENT_DIR` = a fresh directory, offline, no
 *                version check, no telemetry
 *   Codex        `CODEX_HOME` = a fresh directory (it loads `CODEX_HOME/.env`
 *                and creates alias directories there); stdout only
 *
 * Every probe starts from `minimalEnv` (never the whole parent environment),
 * has a 10 s timeout
 * (the process tree is killed), keeps at most 4 KB of stdout and discards
 * stderr. The fresh directory is created under `os.tmpdir()` and removed
 * afterwards. argv is composed with `withLaunch`, as at every spawn site.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HarnessId, HarnessLaunch } from '../../../shared/harness-types'
import { withLaunch } from '../launch'
import { HARNESS_VERSION_RE } from '../selection-store'
import { minimalEnv } from './probe-env'
import { makeRun, runCapture, type RunFn, type SpawnFn } from './run'

export const PROBE_TIMEOUT_MS = 10_000
export const PROBE_STDOUT_CAP = 4096

export type ProbeResult =
  | { status: 'ok'; version: string }
  /** It answered, but with something that is not a version (opencode's source build prints `local`). */
  | { status: 'not-a-version'; output: string }
  | { status: 'failed'; reason: string }

export interface ProbeDeps {
  /** Replaces the runner entirely (tests). */
  run?: RunFn
  /** The spawn the default runner uses (tests). */
  spawn?: SpawnFn
  /** The parent environment the allowlist is taken from (default `process.env`). */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Where the fresh directory is created (default `os.tmpdir()`). */
  tmpdir?: string
  timeoutMs?: number
}

/** The isolation variables for `id`, all pointing into `probeDir`. */
export function isolationEnv(id: HarnessId, probeDir: string): Record<string, string> {
  switch (id) {
    case 'claude':
      return {
        CLAUDE_CONFIG_DIR: probeDir,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      }
    case 'opencode':
      return {
        XDG_DATA_HOME: probeDir,
        XDG_CONFIG_HOME: probeDir,
        XDG_STATE_HOME: probeDir,
        XDG_CACHE_HOME: probeDir,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1'
      }
    case 'pi':
      return {
        PI_CODING_AGENT_DIR: probeDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0'
      }
    case 'codex':
      return { CODEX_HOME: probeDir }
  }
}

const CLAUDE_VERSION = /^(\d+\.\d+\.\d+\S*)\s+\(Claude Code\)/
const CODEX_VERSION = /^codex-cli (\S+)$/

/** The version in a `--version` answer, per harness (research §3). */
export function parseVersionOutput(id: HarnessId, stdout: string): ProbeResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    if (id === 'claude') {
      const m = CLAUDE_VERSION.exec(line)
      if (m) return { status: 'ok', version: m[1] }
    } else if (id === 'codex') {
      const m = CODEX_VERSION.exec(line)
      if (m) return { status: 'ok', version: m[1] }
    } else if (HARNESS_VERSION_RE.test(line)) {
      return { status: 'ok', version: line }
    }
  }
  // opencode and pi print a bare version; a lone other word (a source build's
  // `local`) is an answer, just not a version.
  if ((id === 'opencode' || id === 'pi') && lines.length === 1 && /^\S+$/.test(lines[0])) {
    return { status: 'not-a-version', output: lines[0].slice(0, 80) }
  }
  const first = lines[0]?.slice(0, 80)
  return {
    status: 'failed',
    reason: first ? `--version printed no version ("${first}")` : '--version printed nothing'
  }
}

/** Run `launch --version` isolated and parse the answer. Never rejects. */
export async function probeVersion(
  id: HarnessId,
  launch: HarnessLaunch,
  deps: ProbeDeps = {}
): Promise<ProbeResult> {
  const run = deps.run ?? (deps.spawn ? makeRun(deps.spawn) : runCapture)
  const platform = deps.platform ?? process.platform
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  let probeDir: string | null = null
  try {
    probeDir = fs.mkdtempSync(path.join(deps.tmpdir ?? os.tmpdir(), 'claudeui-probe-'))
    const siteEnv = {
      ...minimalEnv(deps.env ?? process.env, platform),
      ...isolationEnv(id, probeDir)
    }
    const composed = withLaunch(launch, ['--version'], siteEnv)
    const result = await run(composed.command, composed.args, {
      timeoutMs,
      env: composed.env,
      maxStdoutBytes: PROBE_STDOUT_CAP
    })
    if (result.timedOut) {
      return {
        status: 'failed',
        reason: `--version did not answer within ${timeoutMs / 1000} s`
      }
    }
    if (result.error !== undefined)
      return { status: 'failed', reason: `could not start: ${result.error}` }
    if (result.code !== 0)
      return { status: 'failed', reason: `--version exited with code ${result.code}` }
    return parseVersionOutput(id, result.stdout)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // A killed probe's children may still hold a file; the OS temp cleaner gets it.
      }
    }
  }
}
