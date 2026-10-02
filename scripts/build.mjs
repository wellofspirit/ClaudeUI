#!/usr/bin/env node
/**
 * Quiet-by-default build orchestrator.
 *
 *   node scripts/build.mjs <target>        # compact output; warnings/errors always shown
 *   node scripts/build.mjs <target> -v     # full logs from every stage
 *
 * Each stage pipes its stdout through untouched — the verbosity decision is
 * pushed into the tools themselves (our scripts take --quiet, vite-family
 * tools get --logLevel warn). stderr always passes through, so warnings and
 * errors survive quiet mode. On a failed stage the last lines of its output
 * are re-printed as context.
 *
 * A `{ parallel: [stage, ...] }` entry runs independent stages concurrently.
 * Their stdout and stderr are buffered per stage and flushed as each one
 * finishes, so logs never interleave. Every member runs to completion (no
 * fail-fast), so a failed build reports all broken stages at once.
 *
 * Targets mirror the package.json scripts: build, build:mac, build:win,
 * build:linux, build:unpack, build:web, ensure-cli, update-cli,
 * ensure-opencode, update-opencode, ensure-pi, update-pi, ensure-codex,
 * update-codex.
 */

import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const verbose = args.includes('-v') || args.includes('--verbose')
const target = args.find((a) => !a.startsWith('-'))

if (args.includes('-h') || args.includes('--help')) {
  console.log(
    'usage: node scripts/build.mjs <target> [-v]\n\n' +
      'targets: ' +
      [
        'build',
        'build:mac',
        'build:win',
        'build:linux',
        'build:unpack',
        'build:web',
        'ensure-cli',
        'update-cli',
        'ensure-opencode',
        'update-opencode',
        'ensure-pi',
        'update-pi',
        'ensure-codex',
        'update-codex'
      ].join(', ')
  )
  process.exit(0)
}
if (!target) {
  console.error(
    'usage: node scripts/build.mjs <target> [-v]\n       (run with -h for the target list)'
  )
  process.exit(2)
}

const quiet = !verbose
const Q = quiet ? ['--quiet'] : []
const LL = quiet ? ['--logLevel', 'warn'] : []

// Colour when we're on a real terminal, or when the caller forced it via
// FORCE_COLOR. Children get FORCE_COLOR so the tools themselves (vite,
// electron-builder, ...) keep their native ANSI output even though we pipe
// their stdout (piping makes isTTY false → they'd go plain). Redirects to a
// file set FORCE_COLOR=0 so log captures stay free of escape codes.
const forceColor = process.env.FORCE_COLOR
const useColor =
  !!process.stdout.isTTY ||
  (forceColor !== undefined && forceColor !== '0' && forceColor !== 'false')
const C = useColor
  ? {
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`
    }
  : { green: (s) => s, red: (s) => s, dim: (s) => s }
const CHILD_ENV = { ...process.env, FORCE_COLOR: useColor ? '1' : '0' }

// Stage step: [cmd, args, extra?] — extra can carry { env } for spawn().
// The two tsc projects are independent; calling the sub-scripts directly also
// skips the `npm run` hop of the aggregate `typecheck` script.
const typecheckStages = [
  { label: 'typecheck:node', steps: [['bun', ['run', '--silent', 'typecheck:node']]] },
  { label: 'typecheck:web', steps: [['bun', ['run', '--silent', 'typecheck:web']]] }
]
const typecheck = [{ parallel: typecheckStages }]
const electronViteBuild = [
  { label: 'electron-vite build', steps: [['bunx', ['electron-vite', 'build', ...LL]]] }
]
const webBuild = [
  {
    label: 'web build',
    steps: [
      ['bunx', ['vite', 'build', '--config', 'vite.web.config.ts', ...LL]],
      ['node', ['scripts/compress-web-assets.mjs', ...Q]]
    ]
  }
]

const ensureCli = (update) => [
  {
    label: 'ensure-cli',
    steps: [
      ['node', ['scripts/extract-cli.mjs', ...Q, ...(update ? ['--force'] : [])]],
      ['node', ['patch/apply-all.mjs', ...Q]],
      ['node', ['scripts/rebundle-cli.mjs', ...Q]]
    ]
  }
]
// opencode, pi and Codex install into ClaudeUI's managed store through the
// app's own installer (`scripts/ensure-harness.mjs`, ADR-082 §8), which is
// TypeScript: bun runs it. A host without a reviewed Codex release exits 0 with
// a skip line; real failures exit non-zero and stop the target. No build target
// runs these: packages no longer carry opencode, pi or Codex, and development
// gets them from `postinstall`.
const ensureHarness = (id, update) => [
  {
    label: `ensure-${id}`,
    steps: [['bun', [`scripts/ensure-${id}.mjs`, ...Q, ...(update ? ['--force'] : [])]]]
  }
]

const TARGETS = {
  // Nothing here depends on another stage's output: typecheck is --noEmit,
  // ensure-cli writes only vendor/claude-cli, and electron-vite reads neither.
  build: [{ parallel: [...typecheckStages, ...ensureCli(false), ...electronViteBuild] }],
  'build:mac': [
    ...ensureCli(false),
    ...electronViteBuild,
    ...webBuild,
    {
      label: 'electron-builder --mac --dir',
      steps: [
        [
          'bunx',
          ['electron-builder', '--mac', '--dir'],
          { env: { ...CHILD_ENV, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } }
        ]
      ]
    },
    {
      label: 'codesign',
      steps: [
        [
          'sh',
          [
            '-c',
            'codesign --force --deep --sign "${MAC_SIGN_IDENTITY:--}" dist/mac-arm64/ClaudeUI.app'
          ]
        ]
      ]
    },
    {
      label: 'xattr -cr',
      steps: [['sh', ['-c', 'xattr -cr dist/mac-arm64/ClaudeUI.app']]]
    }
  ],
  'build:win': [
    ...typecheck,
    ...ensureCli(false),
    ...electronViteBuild,
    ...webBuild,
    {
      label: 'electron-builder --win --dir',
      steps: [['bunx', ['electron-builder', '--win', '--dir']]]
    }
  ],
  'build:linux': [
    ...ensureCli(false),
    ...electronViteBuild,
    ...webBuild,
    {
      label: 'electron-builder --linux',
      steps: [['bunx', ['electron-builder', '--linux']]]
    }
  ],
  'build:unpack': [
    ...typecheck,
    ...ensureCli(false),
    ...electronViteBuild,
    ...webBuild,
    {
      label: 'electron-builder --dir',
      steps: [['bunx', ['electron-builder', '--dir']]]
    }
  ],
  'build:web': [...webBuild],
  'ensure-cli': [...ensureCli(false)],
  'update-cli': [...ensureCli(true)],
  'ensure-opencode': [...ensureHarness('opencode', false)],
  'update-opencode': [...ensureHarness('opencode', true)],
  'ensure-pi': [...ensureHarness('pi', false)],
  'update-pi': [...ensureHarness('pi', true)],
  'ensure-codex': [...ensureHarness('codex', false)],
  'update-codex': [...ensureHarness('codex', true)]
}

const stages = TARGETS[target]
if (!stages) {
  console.error(`build.mjs: unknown target "${target}" (run with -h for the target list)`)
  process.exit(2)
}

// Streamed (sequential stage): stdout is echoed live and kept for the failure
// tail, stderr is inherited. Buffered (parallel member): stdout and stderr are
// both captured and nothing is written until the caller flushes.
function runStep(step, { buffered = false } = {}) {
  return new Promise((resolve) => {
    const [cmd, stepArgs, extra = {}] = step
    let buf = ''
    const header = `$ ${cmd} ${stepArgs.join(' ')}`
    if (verbose) {
      if (buffered) buf += C.dim(header) + '\n'
      else console.log(C.dim(header))
    }
    const child = spawn(cmd, stepArgs, {
      stdio: buffered ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'],
      env: { ...CHILD_ENV, ...(extra.env ?? {}) }
    })
    const collect = (d) => {
      buf += d.toString()
      if (!buffered) process.stdout.write(d)
    }
    child.stdout.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      buf += `could not start ${cmd}: ${err.message}\n`
      if (!buffered) console.error(`\n  ${C.red('✗')} could not start ${cmd}: ${err.message}`)
      resolve({ code: 1, buf })
    })
    child.on('close', (code) => resolve({ code: code ?? 1, buf }))
  })
}

const secs = (since) => `${((Date.now() - since) / 1000).toFixed(1)}s`

async function runSequential({ label, steps }) {
  for (const step of steps) {
    const res = await runStep(step)
    if (res.code !== 0) {
      console.error(`\n  ${C.red('✗')} ${label} ${C.red(`failed (exit ${res.code})`)}`)
      if (!verbose && res.buf) {
        const lines = res.buf.trim().split('\n').slice(-30)
        console.error(`  ${C.dim(`--- last ${lines.length} lines of ${label} output ---`)}`)
        for (const line of lines) console.error(`  ${line}`)
      }
      return res.code
    }
  }
  return 0
}

// Members run concurrently; each one's steps stay sequential. A member's whole
// buffer is printed when it finishes: on failure that is the full error (stderr
// was captured too, so nothing went to the terminal live), on success it is
// whatever the tool printed despite quiet mode (warnings) or the -v log.
async function runParallel(members) {
  const codes = await Promise.all(
    members.map(async ({ label, steps }) => {
      const t0 = Date.now()
      let out = ''
      let code = 0
      for (const step of steps) {
        const res = await runStep(step, { buffered: true })
        out += res.buf
        code = res.code
        if (code !== 0) break
      }
      const body = out.trimEnd()
      if (code === 0) {
        console.log(`  ${C.green('✓')} ${label} ${C.dim(`(${secs(t0)})`)}`)
        if (body) console.log(body)
      } else {
        console.error(`  ${C.red('✗')} ${label} ${C.red(`failed (exit ${code})`)}`)
        if (body) console.error(body)
      }
      return code
    })
  )
  return codes.find((c) => c !== 0) ?? 0
}

const started = Date.now()
for (let i = 0; i < stages.length; i++) {
  const stage = stages[i]
  const label = stage.parallel ? stage.parallel.map((m) => m.label).join(' ‖ ') : stage.label
  console.log(`${C.dim(`[${i + 1}/${stages.length}]`)} ${label}`)
  const code = stage.parallel ? await runParallel(stage.parallel) : await runSequential(stage)
  if (code !== 0) process.exit(code)
}

console.log(
  `\n${target} ${C.green('✓')} (${stages.length} stages, ${((Date.now() - started) / 1000).toFixed(1)}s)`
)
