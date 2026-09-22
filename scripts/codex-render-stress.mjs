// Render-loss stress loop: drive N real Codex turns through the REAL app against
// the localhost fixture provider and check, after every turn, that what the
// store renders is what canonical holds.
//
// Why it exists: two of twenty real-turn desktop drives on 2026-09-12 rendered
// only the user bubble and a spinner while core's canonical held every message,
// and only under concurrent load. A real provider cannot be hammered twenty
// times per run (cost, rate limits, non-determinism), so this points the app at
// `scripts/codex-fixture-provider.mjs` — the same fixture the real-binary
// integration suite uses — and spends nothing.
//
// Usage:
//   node scripts/codex-render-stress.mjs [--iterations 20] [--load]
//        [--home <dir>] [--out <png>] [--iteration-timeout 120000]
//        [--prompt <text>] [--load-workers <n>] [--accounts <n>]
//        [--keep] [--headed] [--dry-run]
//
// --dry-run       validate the arguments and print the plan; launch nothing.
// --load          run a CPU + IO burner for the whole loop (the loss only ever
//                 appeared under concurrent load).
// --home <dir>    the isolated profile root. Default: a fresh directory under
//                 the OS temp dir. NEVER the real profile — see below.
// --accounts <n>  run the loop under an INJECTED ChatGPT identity: the fixture
//                 is started with `--chatgpt --vault-home <home> --accounts <n>`,
//                 which fabricates n vault accounts in the scratch home and
//                 serves `chatgpt_base_url` from the fixture. Default 0 — no
//                 vault file, so the identity resolves to `native`.
// --keep          leave the app running at the end (implies --headed).
//
// ISOLATION. The app is launched with Electron's own `-r <shim>` where the shim
// patches `os.homedir()` to `CLAUDEUI_TEST_HOME`, which is the only recipe that
// works here: Electron ignores `NODE_OPTIONS --require`, and rewriting
// `USERPROFILE` breaks its crashpad launch. This script WRITES that shim itself
// into the scratch home, so it depends on nothing gitignored. It also sets
// `CODEX_HOME` (inherited by the Codex child, which `CodexAppServerClient`
// spawns with `process.env`) and `CLAUDE_UI_LOG_DIR`, so the main-process log —
// where a `ProjectionAudit` warning would land — is under the scratch home too.
// The isolation covers the main process and the engines it spawns; it is not a
// sandbox.
//
// Output: one row per iteration (store vs canonical message counts, whether the
// transcript ends on the user, the replica's resync count), then any
// `ProjectionAudit` lines the run logged. Exit codes: 0 clean, 1 harness
// failure, 2 bad arguments, 3 at least one iteration mismatched.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The four-line isolation shim, written fresh into every scratch home. */
const HOME_SHIM = `// Electron preload (-r): the ONLY isolation hook that survives Electron's
// startup. Everything reading os.homedir() in the main process lands in the
// scratch home; child processes still inherit the real USERPROFILE.
const os = require('node:os')
const home = process.env.CLAUDEUI_TEST_HOME
if (home) os.homedir = () => home
`

/** A CPU + IO burner. One per worker; they run for the whole loop. */
const LOAD_WORKER = `
const { workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(workerData.dir, 'burn-' + workerData.id + '.tmp')
const blob = 'x'.repeat(256 * 1024)
let n = 0
function burn() {
  const until = Date.now() + 120
  while (Date.now() < until) n = (n + Math.sqrt(n + 1)) % 1e9
  try {
    fs.writeFileSync(file, blob)
    fs.readFileSync(file)
    fs.rmSync(file, { force: true })
  } catch {
    /* the scratch dir may vanish under us at teardown */
  }
  setTimeout(burn, 15)
}
burn()
`

export function parseOptions(argv) {
  const errors = []
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      errors.push(`--${name} needs a value`)
      return fallback
    }
    return value
  }
  const has = (name) => argv.includes(`--${name}`)
  const integer = (name, fallback, min) => {
    const raw = arg(name, String(fallback))
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min) {
      errors.push(`--${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`)
      return fallback
    }
    return value
  }
  const known = new Set([
    'iterations',
    'load',
    'load-workers',
    'home',
    'out',
    'iteration-timeout',
    'prompt',
    'accounts',
    'keep',
    'headed',
    'dry-run'
  ])
  for (const token of argv)
    if (token.startsWith('--') && !known.has(token.slice(2)))
      errors.push(`unknown flag ${token} (known: ${[...known].map((k) => `--${k}`).join(' ')})`)

  const options = {
    iterations: integer('iterations', 20, 1),
    iterationTimeout: integer('iteration-timeout', 120000, 5000),
    loadWorkers: integer('load-workers', Math.max(2, Math.min(4, cpus().length - 2)), 1),
    // 0 = no vault at all (the identity resolves to `native`), n = n fabricated
    // ChatGPT accounts in the scratch home and a fixture serving the backend.
    accounts: integer('accounts', 0, 0),
    load: has('load'),
    keep: has('keep'),
    headed: has('headed') || has('keep'),
    dryRun: has('dry-run'),
    home: arg('home', ''),
    out: arg('out', join(root, '.cache', 'screenshots', 'codex-render-stress.png')),
    prompt: arg('prompt', 'Reply with one short sentence. Do not run any command.')
  }
  // The app must be BUILT: this drives `out/main`, not the dev server. A
  // precondition of LAUNCHING, so `--dry-run` — which launches nothing — is
  // exempt; CI runs the dry-run test before any build exists.
  if (!options.dryRun && !existsSync(join(root, 'out', 'main', 'index.js')))
    errors.push('out/main/index.js is missing — run `bun run build` first')
  if (options.home) {
    const home = resolve(options.home)
    if (home === resolve(process.env.USERPROFILE ?? process.env.HOME ?? '~'))
      errors.push('--home must not be the real user profile')
    options.home = home
  }
  return { options, errors }
}

/** What the page reports for the session living at `cwd`. Runs in the renderer. */
const READ_SESSION = ({ cwd }) => {
  const norm = (value) =>
    String(value ?? '')
      .replace(/\\/g, '/')
      .toLowerCase()
  const handle = window.__claudeuiVerifier
  if (!handle) return { hooks: false }
  const snapshot = handle.snapshot()
  const store = handle.sessionStore.getState()
  const canonical = handle.canonical()
  const entry = Object.entries(store.sessions).find(([, s]) => norm(s.cwd) === norm(cwd))
  const base = {
    hooks: true,
    // F4 adds `resyncCount` to the snapshot; null means this build predates it.
    resyncCount: typeof snapshot.resyncCount === 'number' ? snapshot.resyncCount : null,
    storeSessions: Object.keys(store.sessions).length,
    canonicalSessions: Object.keys(canonical.sessions ?? {}).length
  }
  if (!entry) return { ...base, found: false }
  const [id, session] = entry
  const messages = session.messages ?? []
  const roles = {}
  for (const message of messages) roles[message.role] = (roles[message.role] ?? 0) + 1
  const canonicalSession = (canonical.sessions ?? {})[id]
  const line = (snapshot.sessions ?? []).find((s) => s.id === id)
  return {
    ...base,
    found: true,
    id,
    state: session.status?.state ?? null,
    error: session.status?.error ?? null,
    storeCount: messages.length,
    roles,
    canonicalCount: canonicalSession ? canonicalSession.messages.length : null,
    // The store's `messages` is a BY-REFERENCE projection of canonical's; a
    // different object after a commit is a projection bug, not a race.
    sameReference: !!canonicalSession && canonicalSession.messages === messages,
    endsWithUser:
      line && typeof line.endsWithUser === 'boolean'
        ? line.endsWithUser
        : messages.length > 0 && messages[messages.length - 1].role === 'user',
    endsWithUserFromSnapshot: !!(line && typeof line.endsWithUser === 'boolean')
  }
}

/** Create a session the way the welcome screen does, on the Codex engine. */
const BEGIN_SESSION = ({ routingId, cwd }) => {
  const handle = window.__claudeuiVerifier
  if (!handle) return { ok: false, error: 'verifier hooks absent' }
  const store = handle.sessionStore.getState()
  // Exactly what `WelcomeState.startSession` does after the directory click.
  store.createNewSession(routingId, cwd, true)
  const afterCreate = handle.sessionStore.getState()
  if (afterCreate.sessions[routingId]?.selectedEngineId !== 'codex')
    afterCreate.setSelectedEngine('codex')
  const session = handle.sessionStore.getState().sessions[routingId]
  return {
    ok: !!session,
    engine: session?.selectedEngineId ?? null,
    model: session?.selectedModel ?? null,
    cwd: session?.cwd ?? null,
    codexModels: (afterCreate.availableModels ?? []).filter((m) => m.engineId === 'codex').length
  }
}

function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

async function run(options) {
  const { _electron: electron } = await import('playwright')
  const { Worker } = await import('node:worker_threads')
  const home = options.home || mkdtempSync(join(tmpdir(), 'codex-stress-'))
  const codexHome = join(home, '.codex')
  const logDir = join(home, '.claude', 'ui', 'logs')
  const work = join(home, 'work')
  const shim = join(home, 'home-shim.cjs')
  for (const dir of [codexHome, logDir, work, join(home, '.claude')])
    mkdirSync(dir, { recursive: true })
  writeFileSync(shim, HOME_SHIM)
  console.log(`HOME ${home}`)

  // 1. The fixture provider, and the config.toml/auth.json that point Codex at it.
  const fixture = spawn(
    process.platform === 'win32' ? 'bun.exe' : 'bun',
    [
      join(root, 'scripts', 'codex-fixture-provider.mjs'),
      '--codex-home',
      codexHome,
      // An injected identity needs BOTH: the fabricated vault the app reads
      // (through the home shim) and a fixture that serves `chatgpt_base_url`.
      // Passing one without the other is what kills the host.
      ...(options.accounts > 0
        ? ['--chatgpt', '--vault-home', home, '--accounts', String(options.accounts)]
        : []),
      '--exit-on-stdin-close'
    ],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let fixtureTurns = 0
  const fixtureErrors = []
  fixture.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('TURN ')) fixtureTurns = Number(line.slice(5)) || fixtureTurns
      else if (line.startsWith('REJECTED ')) fixtureErrors.push(line.slice(9))
    }
  })
  const port = await new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error('fixture provider never printed PORT')),
      30000
    )
    let buffered = ''
    fixture.stdout.on('data', (chunk) => {
      buffered += chunk
      const match = /^PORT (\d+)/m.exec(buffered)
      if (match) {
        clearTimeout(timer)
        resolvePort(Number(match[1]))
      }
    })
    fixture.on('exit', (code) => {
      clearTimeout(timer)
      rejectPort(new Error(`fixture provider exited early (${code})`))
    })
  })
  console.log(
    `FIXTURE 127.0.0.1:${port}${options.accounts > 0 ? ` chatgpt vault=${options.accounts}` : ''}`
  )

  // 2. The load, if asked for. Started BEFORE the app so the very first turn —
  //    the one that lost messages on 2026-09-12 — runs under it too.
  const workers = []
  if (options.load) {
    const burnDir = join(home, 'burn')
    mkdirSync(burnDir, { recursive: true })
    for (let i = 0; i < options.loadWorkers; i++)
      workers.push(new Worker(LOAD_WORKER, { eval: true, workerData: { dir: burnDir, id: i } }))
    console.log(`LOAD ${workers.length} workers`)
  }

  const rows = []
  let app
  let failures = 0
  try {
    app = await electron.launch({
      args: ['-r', shim, root],
      cwd: root,
      env: {
        ...process.env,
        CLAUDEUI_TEST_HOME: home,
        CODEX_HOME: codexHome,
        CLAUDE_UI_LOG_DIR: logDir,
        CLAUDEUI_DISABLE_REMOTE: '1',
        CLAUDEUI_VERIFIER_HOOKS: '1',
        ...(options.headed ? {} : { CLAUDEUI_HEADLESS: '1' })
      }
    })
    const win = await app.firstWindow()
    const consoleErrors = []
    win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
    win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(6000) // React mount + the first IPC round-trips + discovery

    for (let i = 1; i <= options.iterations; i++) {
      const cwd = join(work, `iter-${String(i).padStart(2, '0')}`)
      mkdirSync(cwd, { recursive: true })
      const routingId = randomUUID()
      const iterationStart = Date.now()
      const begin = await win.evaluate(BEGIN_SESSION, { routingId, cwd })
      if (!begin.ok) throw new Error(`iteration ${i}: ${begin.error ?? 'session not created'}`)
      if (i === 1) console.log(`SESSION ${JSON.stringify(begin)}`)
      await win.waitForSelector('[data-testid="InputBox.textarea"]', { timeout: 20000 })
      await win.click('[data-testid="InputBox.textarea"]')
      await win.keyboard.type(options.prompt)
      await win.click('[data-testid="InputBox.send"]')

      // TWO phases, because `idle` is also the state a session sits in BEFORE
      // its first turn: waiting for idle alone returns in 300 ms with an empty
      // transcript and calls it a pass. Phase A waits for the turn to be under
      // way (the app-server spawn alone costs seconds on the first prompt),
      // phase B for it to finish WITH a reply. A turn that goes idle having
      // rendered nothing is the render loss itself, so it is never accepted as
      // an ending — it burns the iteration timeout and is reported.
      const deadline = Date.now() + options.iterationTimeout
      const startedBy = Date.now() + Math.min(45000, options.iterationTimeout)
      const answered = (s) => (s.roles?.assistant ?? 0) > 0
      let sample = await win.evaluate(READ_SESSION, { cwd })
      let started = false
      while (Date.now() < startedBy) {
        sample = await win.evaluate(READ_SESSION, { cwd })
        if (
          sample.found &&
          (sample.state === 'running' || sample.state === 'error' || answered(sample))
        ) {
          started = true
          break
        }
        await win.waitForTimeout(250)
      }
      let finished = false
      while (Date.now() < deadline) {
        sample = await win.evaluate(READ_SESSION, { cwd })
        if (
          sample.found &&
          (sample.state === 'error' || (sample.state === 'idle' && answered(sample)))
        ) {
          finished = true
          break
        }
        await win.waitForTimeout(500)
      }
      const problems = []
      if (!sample.hooks) problems.push('no-hooks')
      if (!sample.found) problems.push('no-session')
      if (!started) problems.push('never-started')
      if (!finished) problems.push('timeout')
      if (sample.state === 'error') problems.push('error')
      if (sample.found && sample.storeCount !== sample.canonicalCount) problems.push('count-drift')
      if (sample.found && !sample.sameReference) problems.push('projection')
      if (sample.endsWithUser) problems.push('ends-with-user')
      if (sample.found && !answered(sample)) problems.push('no-assistant')
      if (problems.length) failures++
      rows.push({ i, ms: Date.now() - iterationStart, problems, ...sample })
      console.log(
        `ITER ${pad(i, 3)} ${pad(sample.state ?? '-', 7)} store=${pad(sample.storeCount ?? '-', 3)} canonical=${pad(
          sample.canonicalCount ?? '-',
          3
        )} roles=${pad(JSON.stringify(sample.roles ?? {}), 26)} endsWithUser=${pad(
          sample.endsWithUser,
          5
        )} resync=${pad(sample.resyncCount ?? 'n/a', 4)} ${
          Date.now() - iterationStart
        }ms ${problems.join(',') || 'ok'}`
      )
    }

    mkdirSync(dirname(options.out), { recursive: true })
    await win.screenshot({ path: options.out })
    if (consoleErrors.length) {
      console.log(`CONSOLE ERRORS ${consoleErrors.length}`)
      for (const error of consoleErrors.slice(0, 20)) console.log(`  ${error}`)
    }
  } finally {
    for (const worker of workers) await worker.terminate()
    if (app && !options.keep) await app.close().catch(() => {})
    fixture.stdin.end()
    fixture.kill()
  }

  // 3. The table, the fixture's own count, and whatever the audit logged.
  console.log('')
  console.log(
    `${pad('#', 4)}${pad('state', 8)}${pad('store', 7)}${pad('canon', 7)}${pad('ref', 6)}${pad(
      'endsUser',
      10
    )}${pad('resync', 8)}${pad('ms', 8)}findings`
  )
  for (const row of rows)
    console.log(
      `${pad(row.i, 4)}${pad(row.state ?? '-', 8)}${pad(row.storeCount ?? '-', 7)}${pad(
        row.canonicalCount ?? '-',
        7
      )}${pad(row.sameReference === undefined ? '-' : row.sameReference, 6)}${pad(
        row.endsWithUser,
        10
      )}${pad(row.resyncCount ?? 'n/a', 8)}${pad(row.ms, 8)}${row.problems.join(',') || 'ok'}`
    )
  console.log('')
  console.log(`FIXTURE TURNS ${fixtureTurns}`)
  for (const error of fixtureErrors) console.log(`FIXTURE REJECTED ${error}`)
  const audits = []
  for (const name of existsSync(logDir) ? readdirSync(logDir) : [])
    for (const line of readFileSync(join(logDir, name), 'utf8').split('\n'))
      if (line.includes('ProjectionAudit')) audits.push(line)
  console.log(`PROJECTION AUDIT LINES ${audits.length}`)
  for (const line of audits) console.log(`  ${line}`)
  console.log(
    `RESULT ${failures ? 'MISMATCH' : 'CLEAN'} ${rows.length - failures}/${rows.length} clean`
  )
  return failures ? 3 : 0
}

// Importable for tests (`parseOptions`), executable as a CLI. Without this
// guard, importing the module would parse the TEST RUNNER's argv and exit.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options, errors } = parseOptions(process.argv.slice(2))
  if (errors.length) {
    for (const error of errors) console.error(`ERROR ${error}`)
    process.exit(2)
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, plan: options }, null, 2))
    process.exit(0)
  }
  process.exit(await run(options))
}
