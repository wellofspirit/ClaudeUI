/**
 * `claudeui-server` distribution builder (S3 stage 3).
 *
 *   node scripts/build-server.mjs bundle    →  dist/server/         (pure-asset)
 *   node scripts/build-server.mjs compile   →  dist/server-bin/     (executable)
 *
 * Two artifacts, per the owner's ruling, and thanks to the stage-1 SQLite driver
 * seam BOTH ship with **zero native dependencies for storage** — the bundle
 * targets `node:sqlite` / `bun:sqlite`, so there is no `better-sqlite3` to
 * rebuild per platform, per ABI, or at all. That is the whole reason the seam
 * was worth building (S3 stage 0: better-sqlite3 cannot even load under bun).
 *
 * ## What is deliberately NOT bundled
 *
 * `node-pty` stays external in both artifacts. It is a native addon, so
 * `--compile` cannot embed it — but unlike better-sqlite3 it LOADS fine under
 * bun, and `pty-manager.ts` `require()`s it lazily inside `spawnPty()`. So the
 * server boots, serves, and runs sessions without it present; only `terminal:*`
 * needs it. Both artifacts therefore work fully when `node-pty` is resolvable
 * beside them, and work in every respect except raw terminals when it is not.
 * That is a documented limitation, not a silent one — see README-server.md.
 *
 * ## The web client
 *
 * `RemoteServer` serves the built web bundle from `<appPath>/out/web` with
 * ordinary `fs` reads. The pure-asset artifact ships `out/web` beside the
 * bundle, which `resolveAppPath()` finds. The COMPILED artifact does the same:
 * a bun single-file executable exposes its embedded files through `Bun.file`,
 * not through `fs` against a real path, so genuinely embedding the web bundle
 * would require changing `RemoteServer`'s static serving — a core change,
 * out of scope here and flagged in the S3 report rather than smuggled in.
 * `resolveAppPath()` handles it by resolving relative to the EXECUTABLE.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(ROOT, 'src', 'server', 'main.ts')
const WEB_SRC = path.join(ROOT, 'out', 'web')

/**
 * Left external.
 *
 *  - `node-pty` / `better-sqlite3` — native addons (see the header);
 *  - `ws` — pulls optional native accelerators;
 *  - **`node:sqlite` and `bun:sqlite`** — each resolves on exactly ONE runtime,
 *    and the entrypoint picks between them with a dynamic import. Without this,
 *    the bundler pulls both driver modules into the entry chunk and hoists their
 *    engine imports, so a bun-hosted bundle dies at startup on
 *    `No such built-in module: node:sqlite` — the runtime choice the driver seam
 *    exists to make would be undone by bundling. Externalising leaves both as
 *    runtime requires, reached only down the branch that applies.
 */
const EXTERNAL = ['node-pty', 'ws', 'better-sqlite3', 'node:sqlite', 'bun:sqlite']

function log(msg) {
  process.stdout.write(`[build-server] ${msg}\n`)
}

function fail(msg) {
  process.stderr.write(`[build-server] ERROR: ${msg}\n`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
}

/** Remove a directory's contents individually — never a recursive force-delete. */
function clearDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    return
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      clearDir(target)
      fs.rmdirSync(target)
    } else {
      fs.unlinkSync(target)
    }
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function ensureWebBundle() {
  if (!fs.existsSync(WEB_SRC)) {
    fail(
      `the web client is not built (${path.relative(ROOT, WEB_SRC)} is missing). ` +
        'Run `bun run build:web` first.'
    )
  }
}

/**
 * The bun:sqlite conformance arm. Run BEFORE either artifact is produced: the
 * compiled executable ships `bun:sqlite` as its storage engine, and no other
 * gate in the repo exercises it (vitest runs on node and cannot host a bun
 * builtin). An artifact whose storage engine was never checked is not an
 * artifact worth shipping.
 */
function verifySqlite() {
  log('verifying the bun:sqlite driver against the shared conformance spec…')
  run('bun', [path.join('scripts', 'verify-bun-sqlite.ts')])
}

function buildBundle() {
  ensureWebBundle()
  verifySqlite()

  const out = path.join(ROOT, 'dist', 'server')
  clearDir(out)

  // `--target=bun`. The intent was a bundle that runs on EITHER runtime, and
  // `--target=node` output does run under both — but it currently does not
  // build correctly, for a reason that is worth stating rather than papering
  // over: `jsonc-parser` ships a UMD `main` and an ESM `module` with NO
  // `exports` map, so the node target resolves its UMD entry, whose internal
  // `require("./impl/format")` cannot survive bundling. The bundle then dies at
  // startup on `Cannot find module './impl/format'` under BOTH runtimes.
  //
  // Fixing it needs a resolver alias pinning `jsonc-parser` to `lib/esm/main.js`,
  // which means driving `Bun.build()` with a plugin instead of the CLI — a build
  // rework, not a flag. Until then this artifact targets bun, which is a
  // perfectly good "user-supplied runtime" and the same engine the compiled
  // executable embeds. The `node:sqlite` driver stays fully live and tested for
  // the node path; only this bundling step is blocked. See the S3 report.
  log('bundling src/server/main.ts → dist/server/claudeui-server.js')
  run('bun', [
    'build',
    ENTRY,
    '--target=bun',
    '--outfile',
    path.join(out, 'claudeui-server.js'),
    ...EXTERNAL.flatMap((dep) => ['--external', dep])
  ])

  log('copying the web client → dist/server/out/web')
  copyDir(WEB_SRC, path.join(out, 'out', 'web'))

  fs.writeFileSync(path.join(out, 'README.md'), READMES.bundle, 'utf-8')
  log(`done → ${path.relative(ROOT, out)}`)
  log('run it with:  bun dist/server/claudeui-server.js --help')
}

/**
 * `target` is a bun compile target (`bun-linux-x64`, `bun-darwin-arm64`, …) or
 * null for the host platform. Cross-targets make bun download that platform's
 * runtime on first use — this works from linux and mac hosts (it is how the
 * ubuntu release job could cross-build, though it compiles natively instead),
 * but on Windows hosts bun 1.3.14 fails to extract ANY foreign runtime
 * ("Failed to extract executable … The download may be incomplete"), so
 * cross-building from Windows is not currently possible.
 */
function buildCompile(target) {
  ensureWebBundle()
  verifySqlite()

  const out = path.join(ROOT, 'dist', 'server-bin')
  clearDir(out)

  const forWindows = target ? target.includes('windows') : process.platform === 'win32'
  const exeName = forWindows ? 'claudeui-server.exe' : 'claudeui-server'
  log(
    `compiling a single-file executable → dist/server-bin/${exeName}` +
      (target ? ` (target: ${target})` : '')
  )
  run('bun', [
    'build',
    ENTRY,
    '--compile',
    ...(target ? [`--target=${target}`] : []),
    '--outfile',
    path.join(out, exeName),
    ...EXTERNAL.flatMap((dep) => ['--external', dep])
  ])

  // The web client rides BESIDE the executable rather than inside it — see the
  // module header for why embedding needs a RemoteServer change.
  log('copying the web client → dist/server-bin/out/web')
  copyDir(WEB_SRC, path.join(out, 'out', 'web'))

  fs.writeFileSync(path.join(out, 'README.md'), READMES.compile, 'utf-8')
  log(`done → ${path.relative(ROOT, out)}`)
  log(`run it with:  ./dist/server-bin/${exeName} --help`)
}

const READMES = {
  bundle: `# claudeui-server — pure-asset bundle

Run with your own bun:

    bun claudeui-server.js --help

> **Node is not yet supported by this artifact.** The server's own code is
> runtime-agnostic (it selects \`node:sqlite\` under node), but one dependency
> — \`jsonc-parser\` — ships a UMD entry that does not survive bundling for the
> node target. Use bun, or run from source.

Layout — \`out/web\` must stay beside the bundle, or set \`CLAUDEUI_APP_PATH\`
to the directory that contains it.

    claudeui-server.js
    out/web/…

## Storage

No native dependency: \`bun:sqlite\`, a bun builtin. The database is
\`~/.claude/ui/operational.db\`, shared with the desktop app.

## Terminals

\`terminal:*\` needs \`node-pty\`, which is a native addon and is NOT bundled.
Everything else — sessions, git, config, automations — works without it.
Install it beside the bundle to enable terminals:

    npm install node-pty

## First run

With no passkey enrolled and no password set, nothing can connect. Start with
\`--tls\` (Tailscale HTTPS) and the console prints a one-time enrollment link;
a passkey binds to the origin that created it, so enrollment needs a stable
HTTPS name. \`claudeui-server show-link\` re-prints it later.
`,
  compile: `# claudeui-server — compiled executable

    ./claudeui-server --help

Layout — \`out/web\` must stay beside the executable, or set
\`CLAUDEUI_APP_PATH\` to the directory that contains it.

    claudeui-server(.exe)
    out/web/…

## Building for other platforms

Bun cross-compiles. From the repo:

    bun run build:server:compile --target=bun-linux-x64
    bun run build:server:compile --target=bun-darwin-arm64
    bun run build:server:compile --target=bun-windows-x64

Cross-targets download that platform's bun runtime on first use. This works
from linux and mac hosts; bun 1.3.x on Windows fails to extract foreign
runtimes, so cross-build from linux/mac or let CI produce the artifact.

## Storage

No native dependency: the executable embeds \`bun:sqlite\`, a bun builtin. The
database is \`~/.claude/ui/operational.db\`, shared with the desktop app.

## Terminals

\`terminal:*\` needs \`node-pty\`, a native addon that cannot be embedded in a
single-file executable. Everything else works without it. Place a \`node_modules/node-pty\`
beside the executable to enable terminals.
`
}

const command = process.argv[2]
const targetArg = process.argv.slice(3).find((a) => a.startsWith('--target='))
const target = targetArg ? targetArg.slice('--target='.length) : null
if (target && !/^bun-[a-z0-9]+-[a-z0-9-]+$/.test(target)) {
  fail(`invalid --target "${target}" — expected a bun compile target like bun-linux-x64`)
}
if (command === 'bundle') buildBundle()
else if (command === 'compile') buildCompile(target)
else {
  process.stderr.write(
    'usage: node scripts/build-server.mjs <bundle|compile> [--target=bun-<os>-<arch>]\n'
  )
  process.exit(2)
}
