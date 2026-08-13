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
 * Targets mirror the package.json scripts: build, build:mac, build:win,
 * build:linux, build:unpack, build:web, ensure-cli, update-cli,
 * ensure-opencode, update-opencode, ensure-pi, update-pi.
 */

import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const verbose = args.includes('-v') || args.includes('--verbose')
const target = args.find((a) => !a.startsWith('-'))

if (args.includes('-h') || args.includes('--help')) {
  console.log(
    'usage: node scripts/build.mjs <target> [-v]\n\n' +
      'targets: ' +
      ['build', 'build:mac', 'build:win', 'build:linux', 'build:unpack', 'build:web', 'ensure-cli', 'update-cli', 'ensure-opencode', 'update-opencode', 'ensure-pi', 'update-pi'].join(', ')
  )
  process.exit(0)
}
if (!target) {
  console.error('usage: node scripts/build.mjs <target> [-v]\n       (run with -h for the target list)')
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
  !!process.stdout.isTTY || (forceColor !== undefined && forceColor !== '0' && forceColor !== 'false')
const C = useColor
  ? {
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`
    }
  : { green: (s) => s, red: (s) => s, dim: (s) => s }
const CHILD_ENV = { ...process.env, FORCE_COLOR: useColor ? '1' : '0' }

// Stage step: [cmd, args, extra?] — extra can carry { env } for spawn().
const typecheck = [{ label: 'typecheck', steps: [['bun', ['run', 'typecheck']]] }]
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
const ensureOpencode = (update) => [
  {
    label: 'ensure-opencode',
    steps: [['node', ['scripts/ensure-opencode.mjs', ...Q, ...(update ? ['--force'] : [])]]]
  }
]
const ensurePi = (update) => [
  {
    label: 'ensure-pi',
    steps: [['node', ['scripts/ensure-pi.mjs', ...Q, ...(update ? ['--force'] : [])]]]
  }
]

const TARGETS = {
  build: [...typecheck, ...ensureCli(false), ...ensureOpencode(false), ...ensurePi(false), ...electronViteBuild],
  'build:mac': [...ensureCli(false), ...ensureOpencode(false), ...ensurePi(false), ...electronViteBuild, ...webBuild, {
    label: 'electron-builder --mac --dir',
    steps: [
      [
        'bunx',
        ['electron-builder', '--mac', '--dir'],
        { env: { ...CHILD_ENV, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } }
      ]
    ]
  }, {
    label: 'codesign',
    steps: [['sh', ['-c', 'codesign --force --deep --sign "${MAC_SIGN_IDENTITY:--}" dist/mac-arm64/ClaudeUI.app']]]
  }, {
    label: 'xattr -cr',
    steps: [['sh', ['-c', 'xattr -cr dist/mac-arm64/ClaudeUI.app']]]
  }],
  'build:win': [...typecheck, ...ensureCli(false), ...ensureOpencode(false), ...ensurePi(false), ...electronViteBuild, ...webBuild, {
    label: 'electron-builder --win --dir',
    steps: [['bunx', ['electron-builder', '--win', '--dir']]]
  }],
  'build:linux': [...ensureCli(false), ...ensureOpencode(false), ...ensurePi(false), ...electronViteBuild, ...webBuild, {
    label: 'electron-builder --linux',
    steps: [['bunx', ['electron-builder', '--linux']]]
  }],
  'build:unpack': [...typecheck, ...ensureCli(false), ...ensureOpencode(false), ...ensurePi(false), ...electronViteBuild, ...webBuild, {
    label: 'electron-builder --dir',
    steps: [['bunx', ['electron-builder', '--dir']]]
  }],
  'build:web': [...webBuild],
  'ensure-cli': [...ensureCli(false)],
  'update-cli': [...ensureCli(true)],
  'ensure-opencode': [...ensureOpencode(false)],
  'update-opencode': [...ensureOpencode(true)],
  'ensure-pi': [...ensurePi(false)],
  'update-pi': [...ensurePi(true)]
}

const stages = TARGETS[target]
if (!stages) {
  console.error(`build.mjs: unknown target "${target}" (run with -h for the target list)`)
  process.exit(2)
}

function runStep(step) {
  return new Promise((resolve) => {
    const [cmd, stepArgs, extra = {}] = step
    if (verbose) console.log(C.dim(`$ ${cmd} ${stepArgs.join(' ')}`))
    const child = spawn(cmd, stepArgs, {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...CHILD_ENV, ...(extra.env ?? {}) }
    })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d.toString()
      process.stdout.write(d)
    })
    child.on('error', (err) => {
      console.error(`\n  ${C.red('✗')} could not start ${cmd}: ${err.message}`)
      resolve({ code: 1, buf })
    })
    child.on('close', (code) => resolve({ code: code ?? 1, buf }))
  })
}

const started = Date.now()
for (let i = 0; i < stages.length; i++) {
  const { label, steps } = stages[i]
  console.log(`${C.dim(`[${i + 1}/${stages.length}]`)} ${label}`)
  for (const step of steps) {
    const res = await runStep(step)
    if (res.code !== 0) {
      console.error(`\n  ${C.red('✗')} ${label} ${C.red(`failed (exit ${res.code})`)}`)
      if (!verbose && res.buf) {
        const lines = res.buf.trim().split('\n').slice(-30)
        console.error(`  ${C.dim(`--- last ${lines.length} lines of ${label} output ---`)}`)
        for (const line of lines) console.error(`  ${line}`)
      }
      process.exit(res.code)
    }
  }
}

console.log(`\n${target} ${C.green('✓')} (${stages.length} stages, ${((Date.now() - started) / 1000).toFixed(1)}s)`)
