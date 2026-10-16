#!/usr/bin/env node
/**
 * Boot probe: does the rebundled `bun-claude` still START?
 *
 * `rebundle-cli` re-injects patched JS into a Bun executable and only
 * syntax-checks the changed chunks, so a patch that parses but throws at
 * module-evaluation time (a bad rename, a missing binding) ships a binary that
 * dies before its first message. This runs the binary once, offline, and
 * checks that it got as far as a `system/init` line and a final `result` line.
 * `ensure-cli` ends with it, so a crash-at-boot patch fails the pipeline in
 * seconds instead of in the first real session.
 *
 *   node scripts/boot-probe.mjs                    # vendor/claude-cli/bun-claude[.exe]
 *   node scripts/boot-probe.mjs --bin <path>       # another binary
 *   node scripts/boot-probe.mjs --timeout <ms>     # default 30000, then killed
 *   node scripts/boot-probe.mjs --quiet            # drop the terminal_reason line
 *   node scripts/boot-probe.mjs --warn-only        # report a failure, exit 0
 *
 * Offline and hermetic: an isolated temp home, an env ALLOWLIST (nothing of
 * the parent's CLAUDE_CODE_* / tokens leaks in), a dummy API key, and
 * ANTHROPIC_BASE_URL pointing at a local server that resets every connection.
 * The turn therefore ends in an `api_error` result, which is the healthy
 * outcome — we are testing startup, not the API. Zero retries keep it fast.
 *
 * Skips (exit 0, one line): the default binary is absent on linux (rebundle
 * has no ELF writer, so there is none), or the file is not the host's
 * container (a cross-built PE/Mach-O cannot run here).
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { detectFormat, isForeignFormat } from './lib/binary-format.mjs'
import { cliVendorDir } from './lib/cli-paths.mjs'

const DEFAULT_TIMEOUT_MS = 30_000

/** Parent env passed through (case-insensitively: Windows has `Path` / `PATH`). */
const ENV_ALLOWLIST = new Set(
  [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG'
  ].map((k) => k.toLowerCase())
)

/** A thrown JS error at startup — what a bad patch looks like on stderr. */
const CRASH_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/

export function defaultBin(platform = process.platform) {
  return join(cliVendorDir(), `bun-claude${platform === 'win32' ? '.exe' : ''}`)
}

export function parseBootProbeArgs(argv) {
  const args = { bin: null, timeoutMs: DEFAULT_TIMEOUT_MS, quiet: false, warnOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quiet') args.quiet = true
    else if (a === '--warn-only') args.warnOnly = true
    else if (a === '--bin' || a === '--timeout') {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      if (a === '--bin') args.bin = resolve(v)
      else {
        const n = Number(v)
        if (!Number.isInteger(n) || n <= 0) throw new Error('--timeout must be a positive integer')
        args.timeoutMs = n
      }
    } else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

/** The JSON objects among `text`'s lines; anything that isn't JSON is ignored. */
function jsonLines(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* partial / non-JSON line */
    }
  }
  return out
}

/**
 * Decide from a finished run whether the binary booted. Healthy means: not
 * killed on timeout, an init line, a result line (of ANY kind — `api_error`
 * is what the offline run yields), and no thrown JS error on stderr. The exit
 * code is deliberately ignored: the offline turn exits 1 by design.
 *
 * @returns {{ ok: boolean, reason: string, terminalReason: string | null, version: string | null }}
 */
export function classifyBootProbe({
  code,
  stdout,
  stderr,
  timedOut,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const lines = jsonLines(stdout)
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init')
  const result = [...lines].reverse().find((l) => l.type === 'result')
  const terminalReason = typeof result?.terminal_reason === 'string' ? result.terminal_reason : null
  const version = typeof init?.claude_code_version === 'string' ? init.claude_code_version : null
  const fail = (reason) => ({ ok: false, reason, terminalReason, version })

  if (timedOut) return fail(`timed out after ${timeoutMs} ms`)
  const crash = stderr.split(/\r?\n/).find((l) => CRASH_RE.test(l))
  if (crash) return fail(`crashed: ${crash.trim().slice(0, 200)}`)
  if (!init) return fail(`no init line (exit ${code})`)
  if (!result) return fail(`no result line (exit ${code})`)
  return { ok: true, reason: 'booted', terminalReason, version }
}

/** The first 4 bytes of `path`, enough for `detectFormat` (zero-padded if shorter). */
function readMagic(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    readSync(fd, buf, 0, 4, 0)
    return buf
  } finally {
    closeSync(fd)
  }
}

/** The child's complete env: allowlisted parent vars + isolated home + offline config. */
export function probeEnv(home, port) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ENV_ALLOWLIST.has(k.toLowerCase())) env[k] = v
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-ant-boot-probe-not-a-real-key',
    CLAUDE_CODE_MAX_RETRIES: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  }
}

/**
 * A listening server that resets every connection. A listener we hold for the
 * whole run (rather than a "closed" port number) cannot be grabbed by another
 * process mid-probe, and the reset is deterministic.
 */
async function listenAndReset() {
  const server = createServer((socket) => socket.destroy())
  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', res)
  })
  return { server, port: server.address().port }
}

function runBinary(bin, env, cwd, timeoutMs) {
  return new Promise((resolveRun) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ stdout, stderr, timedOut, ...r })
    }
    let child
    try {
      child = spawn(
        bin,
        ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
    } catch (err) {
      // Windows throws EFTYPE synchronously for a file that isn't an executable.
      return resolveRun({ stdout, stderr, timedOut, code: null, spawnError: err.message })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => done({ code: null, spawnError: err.message }))
    child.on('close', (code) => done({ code }))
  })
}

/**
 * Probe `bin`. Resolves to `{ status: 'skipped', message }` when the file is not
 * the host's container, else `{ status: 'ok' | 'failed', reason, terminalReason,
 * version, ms, stdout, stderr }`.
 */
export async function runBootProbe({
  bin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform
}) {
  const format = detectFormat(readMagic(bin))
  if (isForeignFormat(format, platform)) {
    return { status: 'skipped', message: `${format} binary on ${platform}` }
  }

  const home = mkdtempSync(join(tmpdir(), 'claudeui-boot-probe-'))
  const { server, port } = await listenAndReset()
  try {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const t0 = Date.now()
    const run = await runBinary(bin, probeEnv(home, port), home, timeoutMs)
    const ms = Date.now() - t0
    const verdict = run.spawnError
      ? {
          ok: false,
          reason: `could not start: ${run.spawnError}`,
          terminalReason: null,
          version: null
        }
      : classifyBootProbe({ ...run, timeoutMs })
    return {
      status: verdict.ok ? 'ok' : 'failed',
      ...verdict,
      ms,
      stdout: run.stdout,
      stderr: run.stderr
    }
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const tail = (text, n) => text.trimEnd().split(/\r?\n/).slice(-n).join('\n')

async function main() {
  let args
  try {
    args = parseBootProbeArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`boot-probe: ${err.message}`)
    process.exit(2)
  }

  const bin = args.bin ?? defaultBin()
  if (!existsSync(bin)) {
    if (!args.bin && process.platform === 'linux') {
      console.log(
        `boot-probe: skipped — no bun-claude on ${process.platform} (ELF rebundle not implemented)`
      )
      return
    }
    console.error(`boot-probe: ${bin} does not exist — run 'bun run ensure-cli' first`)
    process.exitCode = 1
    return
  }

  const res = await runBootProbe({ bin, timeoutMs: args.timeoutMs })
  if (res.status === 'skipped') {
    console.log(`boot-probe: skipped — ${res.message}`)
    return
  }
  if (res.status === 'ok') {
    console.log(`boot-probe: ok (${res.ms} ms, ${res.version ?? 'version unknown'})`)
    if (!args.quiet) console.log(`boot-probe: terminal_reason=${res.terminalReason ?? 'none'}`)
    return
  }

  console.error(`boot-probe: FAILED — ${res.reason}`)
  if (res.stderr.trim()) console.error(`--- last 30 lines of stderr ---\n${tail(res.stderr, 30)}`)
  if (res.stdout.trim()) console.error(`--- last 30 lines of stdout ---\n${tail(res.stdout, 30)}`)
  if (args.warnOnly) console.error('boot-probe: WARNING (not failing: --warn-only)')
  else process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`boot-probe: ${err.stack ?? err.message}`)
    process.exit(1)
  })
}
