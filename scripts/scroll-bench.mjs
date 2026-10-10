// Chat-scroll measurement bench: launches a BUILT ClaudeUI under Playwright, opens large
// transcripts through the real sidebar, synthesizes scroll input over CDP and records smoothness
// (rAF frame sampler, Long Animation Frames, CDP Performance metrics, CDP Tracing frame verdicts)
// and correctness (per-frame scroller geometry, TypingIndicator visibility, follow state).
// Design: docs/chat-scroll-spec.md. It measures; it changes nothing in the app.
//
// Usage:
//   bun run build   # the bench drives <app>/out; rebuild after any renderer edit
//   node scripts/scroll-bench.mjs [--app <checkout>] [--sessions <list>] [--scenarios <list>]
//        [--scales <list>] [--chat-scale <ui>:<chat> | --no-chat-scale] [--repeat <n>]
//        [--profile <name>] [--headed] [--home <dir>] [--keep-home] [--out <dir>] [--no-trace]
//        [--find-term <word>] [--turns <n>] [--steps <n>] [--warmup-turns <n>] [--s6-scales <list>]
//        [--no-smooth-scrolling]
//   node scripts/scroll-bench.mjs --live --live-cwd <new or empty dir> [--live-turns <n>]
//        [--live-prompts varied|long] [--live-compact-every <n>] [--ack-second-instance]
//        [--keep-live-sessions] [--scales ...]
//
// --app         the checkout whose built app is launched (its out/main/index.js and vendor/);
//               default: this repo. Its HEAD, a digest of its `git status --porcelain` and its
//               out/ build are recorded in the run's env block.
// --sessions    comma list of transcript sources (default synthetic:200,synthetic:1000,synthetic:3000):
//                 synthetic:<n>   a seeded generated transcript of n chat messages
//                 copy:<path>     a COPY of a real .jsonl placed in the isolated home (local only)
//                 fake            the scripted local Anthropic endpoint (S4/S6/S7 streaming)
// --scenarios   S1 scroll-to-bottom from top, S2 wheel/gesture/touch, S3 jumps + find-in-chat,
//               S4 streaming auto-scroll, S5 mobile S1+S2 (touch), S6 scroll-up while streaming,
//               S7 subagent detail panel following its stream, H placeholder-height probe,
//               E height-estimate calibration (data-est-h, or the 100 px placeholder, vs the
//               real height of every message) (default S1,S2,S3,H; S4/S6/S7 need --sessions fake)
// --scales      uiFontScale list, applied IN MEMORY (default 1,1.1,1.15,1.5); chatFontScale = ui
// --chat-scale  one extra run with chatFontScale != uiFontScale (default 1.1:1.25)
// --repeat      repetitions per scenario x scale (default 3; S6 is capped at 3 and S7 at 2 —
//               each of their repeats streams for minutes)
// --profile     device profile for S5 (default s25-ultra-edge)
// --headed      show the window (default: off-screen "headless" window, which still gets real
//               vsync-paced frames — the measured refresh interval is recorded either way)
// --home        isolated profile root (default: a fresh <tmp>/scroll-bench-* dir, deleted at the end
//               unless --keep-home; never the real profile)
// --no-trace    skip CDP Tracing (compositor frame verdicts)
// --no-smooth-scrolling  do NOT pass Chromium's --enable-smooth-scrolling. By default the bench
//               forces smooth scrolling on (Chromium follows the OS animation setting and a Remote
//               Desktop session disables it) and ABORTS if it then does not animate.
// --turns       S4 measured turns per scale on the fake endpoint (default 2); --steps steps/turn
//               (default 24); --warmup-turns unreported turns that grow the session first (4)
// --s6-scales   uiFontScale list for S6/S7 (default 1,1.15)
// --find-term   S3 search term (default: the synthetic marker word, or "error" for real copies)
// --live        real-profile live turns, Haiku 4.5 only (see lib/scroll-bench/live.mjs for the
//               safety rails); --live-cwd must not exist or be empty; refuses to run next to another
//               ClaudeUI instance unless --ack-second-instance; removes only its own sessions
//               afterwards unless --keep-live-sessions
//
// Output: .cache/scroll-bench/<timestamp>/{results.jsonl, raw.json, summary.md, *.png}; an --out
// directory that already holds results.jsonl is refused (no appending to an old run).
// Exit codes: 0 ok, 1 harness failure or any errored scenario row, 2 bad arguments or build missing.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSummary } from './lib/scroll-bench/report.mjs'
import { runIsolated } from './lib/scroll-bench/isolated.mjs'
import { liveCwdProblems, runLive } from './lib/scroll-bench/live.mjs'
import { log } from './lib/scroll-bench/app-helpers.mjs'
import { LIVE_PIDS, killPid } from './lib/scroll-bench/launch.mjs'
import { REQUIRED_TEST_IDS } from './lib/scroll-bench/common.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP_PREFIX = 'scroll-bench-'

export function parseOptions(argv) {
  const errors = []
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      errors.push(`--${name} needs a value`)
      return fallback
    }
    return v
  }
  const has = (name) => argv.includes(`--${name}`)
  const list = (s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  const scaleList = (s, name) =>
    list(s).map((x) => {
      const n = Number(x)
      if (!(n >= 1 && n <= 1.5)) errors.push(`--${name}: ${x} is not a number in 1..1.5`)
      return n
    })
  const int = (name, fallback, min) => {
    const raw = arg(name, String(fallback))
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) errors.push(`--${name} must be an integer >= ${min}`)
    return n
  }
  const live = has('live')
  const o = {
    live,
    app: resolve(arg('app', root)),
    sessions: list(arg('sessions', live ? '' : 'synthetic:200,synthetic:1000,synthetic:3000')),
    scenarios: list(arg('scenarios', live ? 'S4' : 'S1,S2,S3,H')).map((s) => s.toUpperCase()),
    scales: scaleList(arg('scales', '1,1.1,1.15,1.5'), 'scales'),
    s6Scales: scaleList(arg('s6-scales', '1,1.15'), 's6-scales'),
    chatScale: has('no-chat-scale') ? null : arg('chat-scale', '1.1:1.25'),
    repeat: int('repeat', 3, 1),
    profile: arg('profile', 's25-ultra-edge'),
    headed: has('headed'),
    home: arg('home', ''),
    keepHome: has('keep-home'),
    out: resolve(
      arg(
        'out',
        join(root, '.cache', 'scroll-bench', new Date().toISOString().replace(/[:.]/g, '-'))
      )
    ),
    trace: !has('no-trace'),
    findTerm: arg('find-term', ''),
    turns: int('turns', 2, 1),
    warmupTurns: int('warmup-turns', 4, 0),
    steps: int('steps', 24, 2),
    liveCwd: arg('live-cwd', ''),
    liveTurns: int('live-turns', 6, 0),
    keepLive: has('keep-live-sessions'),
    ackSecondInstance: has('ack-second-instance'),
    smoothScrolling: !has('no-smooth-scrolling'),
    livePrompts: arg('live-prompts', 'varied'),
    liveCompactEvery: int('live-compact-every', 0, 0)
  }
  if (o.chatScale) {
    const [ui, chat] = o.chatScale.split(':').map(Number)
    if (!(ui >= 1 && ui <= 1.5 && chat >= 0.8 && chat <= 2))
      errors.push('--chat-scale must be <ui>:<chat> (ui 1..1.5, chat 0.8..2)')
    o.chatScale = { ui, chat }
  }
  if (!['varied', 'long'].includes(o.livePrompts)) errors.push('--live-prompts must be varied|long')
  if (o.home) {
    const h = resolve(o.home)
    const real = resolve(homedir())
    const rel = relative(h, real)
    if (h === real || (!rel.startsWith('..') && !isAbsolute(rel)))
      errors.push('--home must not be the real profile or an ancestor of it')
    o.home = h
  }
  if (live && !o.liveCwd) errors.push('--live needs --live-cwd <new or empty dir>')
  if (live && o.liveCwd) errors.push(...liveCwdProblems(o.liveCwd, o.app))
  for (const s of o.sessions)
    if (!/^(synthetic:\d+|copy:.+|fake)$/.test(s)) errors.push(`unknown session source ${s}`)
  for (const s of o.scenarios)
    if (!['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'H', 'E'].includes(s))
      errors.push(`unknown scenario ${s}`)
  if (existsSync(join(o.out, 'results.jsonl')))
    errors.push(`${o.out} already holds results.jsonl — pick a fresh --out`)
  const buildMissing = !existsSync(join(o.app, 'out', 'main', 'index.js'))
  return { options: o, errors, buildMissing }
}

class Results {
  constructor(out) {
    this.out = out
    this.rows = []
    mkdirSync(out, { recursive: true })
    this.file = join(out, 'results.jsonl')
    writeFileSync(this.file, '', { flag: 'wx' }) // a fresh file per run: never append to an old one
  }
  add(row) {
    this.rows.push(row)
    appendFileSync(this.file, JSON.stringify(row) + '\n')
  }
}

// ── provenance ─────────────────────────────────────────────────────────────────────────────

const git = (app, args) => {
  try {
    return execFileSync('git', ['-C', app, ...args], { encoding: 'utf8' })
  } catch {
    return null
  }
}
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16)

/** Newest mtime of a BUILD input under `dir` (skipping node_modules, dot dirs and tests). */
function newestMtime(dir) {
  let newest = { ms: 0, file: null }
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.name === 'node_modules' || n.name === '__tests__' || n.name.startsWith('.')) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(n.name)) continue
      const p = join(d, n.name)
      if (n.isDirectory()) walk(p)
      else {
        const ms = statSync(p).mtimeMs
        if (ms > newest.ms) newest = { ms, file: p }
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

/** What exactly is being measured: the app checkout, its working tree and its build. */
function provenance(app) {
  const status = git(app, ['status', '--porcelain'])
  const index = join(app, 'out', 'renderer', 'index.html')
  const builtMs = statSync(join(app, 'out', 'main', 'index.js')).mtimeMs
  // Build inputs: src/** (tests excluded), package.json, electron.vite.config.*.
  const configs = readdirSync(app)
    .filter((n) => n === 'package.json' || /^electron\.vite\.config\./.test(n))
    .map((n) => ({ ms: statSync(join(app, n)).mtimeMs, file: join(app, n) }))
  const src = [newestMtime(join(app, 'src')), ...configs].reduce((a, b) => (b.ms > a.ms ? b : a))
  const p = {
    appDir: app === root ? '<this repo>' : basename(app),
    head: git(app, ['rev-parse', 'HEAD'])?.trim() ?? null,
    statusDigest: status === null ? null : sha(status),
    dirtyFiles: status === null ? null : status.split('\n').filter(Boolean).length,
    outMainMtime: new Date(builtMs).toISOString(),
    outRendererIndexHash: existsSync(index) ? sha(readFileSync(index)) : null,
    newestSrcMtime: src.ms ? new Date(src.ms).toISOString() : null,
    srcNewerThanBuild: src.ms > builtMs,
    testIds: testIdsInBuild(app)
  }
  if (p.srcNewerThanBuild)
    console.error(
      `WARNING ${relative(app, src.file)} is newer than out/main — the build may not match the source`
    )
  return p
}

/**
 * Which of the bench's required test ids the BUILT renderer carries (a static scan of
 * out/renderer/assets/*.js for the id string: an element that only mounts while a turn runs, like
 * the TypingIndicator, cannot be found in the DOM up front).
 */
function testIdsInBuild(app) {
  const dir = join(app, 'out', 'renderer', 'assets')
  const bundles = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith('.js'))
        .map((n) => readFileSync(join(dir, n), 'utf8'))
    : []
  return Object.fromEntries(
    REQUIRED_TEST_IDS.map((id) => [id, bundles.some((b) => b.includes(`"${id}"`))])
  )
}

// ── scratch homes ──────────────────────────────────────────────────────────────────────────

/** Delete a scratch home the bench created: only a direct child of tmpdir() named scroll-bench-*. */
export function removeScratchHome(dir) {
  const real = realpathSync(dir)
  const tmp = realpathSync(tmpdir())
  if (dirname(real) !== tmp || !basename(real).startsWith(TEMP_PREFIX))
    throw new Error(
      `refusing to delete ${real}: not a ${TEMP_PREFIX}* directory under the OS temp dir`
    )
  rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

// ── main ───────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options: o, errors, buildMissing } = parseOptions(process.argv.slice(2))
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`)
    process.exit(2)
  }
  if (buildMissing) {
    console.error(
      `BUILD MISSING: ${join(o.app, 'out', 'main', 'index.js')} — run \`bun run build\` in ${o.app}`
    )
    process.exit(2)
  }
  const results = new Results(o.out)
  const app = provenance(o.app)
  o.buildTestIds = app.testIds
  for (const [id, ok] of Object.entries(app.testIds))
    if (!ok) console.error(`WARNING the build has no data-testid="${id}"`)
  const env = {
    startedAt: new Date().toISOString(),
    app,
    bench: { head: git(root, ['rev-parse', 'HEAD'])?.trim() ?? null },
    // Paths that would carry the user name are not written: only flags and counts.
    options: {
      ...o,
      app: undefined,
      out: undefined,
      home: o.home ? '<given>' : '<temp>',
      liveCwd: o.liveCwd ? '<scratch>' : '',
      // A real transcript is named by its size only, never by its path.
      sessions: o.sessions.map((src) =>
        src.startsWith('copy:')
          ? `real-${Math.round(statSync(resolve(src.slice(5))).size / 1048576)}MB`
          : src
      ),
      buildTestIds: undefined
    }
  }
  log(`OUT ${o.out}`)
  log(`APP ${JSON.stringify(env.app)}`)
  let code = 0
  let home = null
  let madeHome = false
  // Ctrl+C / kill: take down the Electron processes this run started and its scratch home.
  const onSignal = (sig) => {
    console.error(`
${sig}: stopping the launched app and removing the scratch home`)
    for (const pid of [...LIVE_PIDS]) killPid(pid)
    if (madeHome && !o.keepHome && home)
      try {
        removeScratchHome(home)
      } catch (err) {
        console.error(`could not remove the scratch home: ${err?.message}`)
      }
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    if (o.live) await runLive(o, results, env)
    else {
      madeHome = !o.home
      home = o.home || mkdtempSync(join(tmpdir(), TEMP_PREFIX))
      mkdirSync(home, { recursive: true })
      await runIsolated(o, results, env, home)
    }
  } catch (err) {
    console.error('scroll-bench failed:', err?.stack || err)
    env.fatal = String(err?.message ?? err)
    code = 1
  } finally {
    if (madeHome && !o.keepHome) {
      try {
        removeScratchHome(home)
      } catch (err) {
        console.error(`could not remove the scratch home: ${err?.message}`)
      }
    } else if (home) log('scratch home kept (--keep-home or --home)')
  }
  const errored = results.rows.filter((r) => r.error).length
  env.erroredRows = errored
  if (errored) {
    console.error(`${errored} scenario row(s) errored — see summary.md "Errors"`)
    code = 1
  }
  env.finishedAt = new Date().toISOString()
  writeFileSync(join(o.out, 'raw.json'), JSON.stringify({ env, rows: results.rows }, null, 1))
  writeFileSync(join(o.out, 'summary.md'), renderSummary({ env, rows: results.rows }))
  log(`SUMMARY ${join(o.out, 'summary.md')}`)
  process.exit(code)
}
