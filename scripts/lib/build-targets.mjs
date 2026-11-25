/**
 * The stage lists behind `node scripts/build.mjs <target>`, as data.
 *
 * Kept apart from the runner (`scripts/build.mjs`, which spawns processes and
 * exits on import) so a unit test can assert the shape of a target — which
 * stages, in which order, with which env — without executing anything.
 *
 * Stage shapes (see the runner for how they execute):
 *   { label, steps: [[cmd, args, extra?], ...], keepGoing? }
 *   { parallel: [stage, ...] }
 * `extra.env` is the child's COMPLETE environment (omit it to inherit the
 * runner's). `keepGoing` lets the pipeline continue past a failure of this
 * stage and fail at the end instead.
 */

import { posix, win32 } from 'node:path'

/**
 * Why a `build*` target must not run while CLAUDEUI_CLI_VENDOR_DIR is set, or
 * null when it may. Packaging always copies `vendor/claude-cli`
 * (electron-builder.yml), so an overridden dir would build a package around a
 * DIFFERENT Claude Code than the one just prepared. `ensure*`, `update-*` and
 * `postinstall` write wherever the variable says and are fine.
 *
 * @param {string} target
 * @param {NodeJS.ProcessEnv} env
 */
export function vendorOverrideRefusal(target, env) {
  if (!env.CLAUDEUI_CLI_VENDOR_DIR) return null
  if (target !== 'build' && !target.startsWith('build:')) return null
  return (
    `build.mjs: refusing "${target}" with CLAUDEUI_CLI_VENDOR_DIR set: packaging always reads ` +
    'vendor/claude-cli (electron-builder.yml), not the override. Unset the variable and retry.'
  )
}

/**
 * Why `build:stage` must not run as asked, or null when it may (any other
 * target: null). It is the local rebuild's target (the desktop app runs it in a
 * source tree, `src/main/services/rebuild/rebuild.ts`): its output must go to
 * the folder the app names, never the tree's own `dist/` (which the running app
 * may live in), so CLAUDEUI_BUILD_OUT is required and absolute; and it packages
 * for the host, which must be one with an install layout (macOS or Windows).
 *
 * @param {string} target
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [platform]
 */
export function stageTargetRefusal(target, env, platform = process.platform) {
  if (target !== 'build:stage') return null
  const out = env.CLAUDEUI_BUILD_OUT ?? ''
  if (out === '')
    return 'build.mjs: refusing "build:stage" without CLAUDEUI_BUILD_OUT (the absolute folder to build into)'
  if (!(platform === 'win32' ? win32 : posix).isAbsolute(out))
    return `build.mjs: refusing "build:stage": CLAUDEUI_BUILD_OUT must be an absolute folder (got "${out}")`
  if (platform !== 'darwin' && platform !== 'win32')
    return `build.mjs: refusing "build:stage" on ${platform}: it packages macOS and Windows desktop builds only`
  return null
}

/**
 * @param {object} opts
 * @param {boolean} opts.quiet   quiet-by-default output: pass --quiet / --logLevel warn
 * @param {NodeJS.ProcessEnv} opts.childEnv  the env children inherit (FORCE_COLOR already set)
 * @param {string} [opts.platform]  host platform (boot-probe is warn-only on darwin)
 */
export function targets({ quiet, childEnv, platform = process.platform }) {
  const Q = quiet ? ['--quiet'] : []
  const LL = quiet ? ['--logLevel', 'warn'] : []

  // Stage step: [cmd, args, extra?] — extra can carry { env } for spawn().
  // The two tsc projects are independent; calling the sub-scripts directly also
  // skips the `npm run` hop of the aggregate `typecheck` script.
  const typecheckStages = [
    { label: 'typecheck:node', steps: [['bun', ['run', '--silent', 'typecheck:node']]] },
    { label: 'typecheck:web', steps: [['bun', ['run', '--silent', 'typecheck:web']]] }
  ]
  const electronViteBuild = [
    { label: 'electron-vite build', steps: [['bunx', ['electron-vite', 'build', ...LL]]] }
  ]

  // The pipeline ends in a boot probe (gate 0): rebundle-cli only syntax-checks
  // the chunks a patch changed, so a patch that parses but throws at startup
  // would otherwise first show up in a real session. Warn-only on darwin until a
  // Mac run is on record (cli.js's keychain read may prompt for an ad-hoc-signed
  // binary).
  const probeFlags = platform === 'darwin' ? ['--warn-only'] : []
  const ensureCli = (update) => [
    {
      label: 'ensure-cli',
      steps: [
        ['node', ['scripts/extract-cli.mjs', ...Q, ...(update ? ['--force'] : [])]],
        ['node', ['patch/apply-all.mjs', ...Q]],
        ['node', ['scripts/rebundle-cli.mjs', ...Q]],
        ['node', ['scripts/boot-probe.mjs', ...Q, ...probeFlags]]
      ]
    }
  ]
  // opencode and pi install into ClaudeUI's managed store through the
  // app's own installer (`scripts/ensure-harness.mjs`, ADR-082 §8), which is
  // TypeScript: bun runs it. A host without a reviewed release exits 0 with
  // a skip line; real failures exit non-zero and stop the target. No build target
  // runs these: packages no longer carry opencode or pi, and development
  // gets them from `postinstall`.
  const ensureHarness = (id, update) => [
    {
      label: `ensure-${id}`,
      steps: [['bun', [`scripts/ensure-${id}.mjs`, ...Q, ...(update ? ['--force'] : [])]]]
    }
  ]

  // Everything a package needs before electron-builder, as one parallel group.
  // The members share no outputs: typecheck is --noEmit, ensure-cli writes
  // vendor/claude-cli, and electron-vite writes out/{main,preload,renderer} (each
  // target empties only its own dir; the one renderer build is both the desktop
  // and the web client, and compresses its own assets).
  const prepare = ({ typecheck }) => [
    {
      parallel: [...(typecheck ? typecheckStages : []), ...ensureCli(false), ...electronViteBuild]
    }
  ]

  // The build's identity (`out/build-info.json`, src/shared/build-info.ts), written
  // after electron-vite so its `out/` exists, and before electron-builder packs
  // it. It imports the shared TypeScript, so bun runs it.
  const stampBuildInfo = [
    { label: 'stamp build-info', steps: [['bun', ['scripts/stamp-build-info.mjs', ...Q]]] }
  ]

  // CLAUDEUI_BUILD_OUT (an absolute dir) redirects electron-builder's output,
  // so a rebuild never lands in the running install or the tree's own `dist/`.
  // Unset: the default `dist/`, exactly as before.
  const buildOut = childEnv.CLAUDEUI_BUILD_OUT || ''
  const outArg = buildOut ? [`-c.directories.output=${buildOut}`] : []
  const outDir = buildOut ? buildOut.replace(/[\\/]+$/, '') : 'dist'
  const macApp = `${outDir}/mac-arm64/ClaudeUI.app`
  const winDir = `${outDir}/win-unpacked`

  // The install marker (`src/shared/install-marker.ts`): what lets the relaunch
  // helper and the deletion gate prove a folder is a ClaudeUI install. Written
  // after electron-builder (Windows lists the packaged folder's top-level names)
  // and, on macOS, before codesign so the signature seals it. It imports the
  // shared TypeScript, so bun runs it.
  const stampInstallMarker = (packaged, markerPlatform) => [
    {
      label: 'stamp install-marker',
      steps: [
        ['bun', ['scripts/stamp-install-marker.mjs', packaged, '--platform', markerPlatform, ...Q]]
      ]
    }
  ]
  // `build:unpack` packages for the host: a marker where the host has a layout.
  const hostMarker =
    platform === 'darwin'
      ? stampInstallMarker(macApp, 'mac')
      : platform === 'win32'
        ? stampInstallMarker(winDir, 'win')
        : []

  // Packaging an unpacked desktop build for macOS / Windows, after build-info:
  // electron-builder, the install marker, and on macOS the signature (ad-hoc
  // unless MAC_SIGN_IDENTITY) and the quarantine attributes cleared.
  const macPackage = [
    {
      label: 'electron-builder --mac --dir',
      steps: [
        [
          'bunx',
          ['electron-builder', '--mac', '--dir', ...outArg],
          { env: { ...childEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } }
        ]
      ]
    },
    ...stampInstallMarker(macApp, 'mac'),
    {
      label: 'codesign',
      steps: [
        // argv, not `sh -c`: the app path may come from CLAUDEUI_BUILD_OUT.
        // No identity = ad-hoc (`-`), as `${MAC_SIGN_IDENTITY:--}` did.
        ['codesign', ['--force', '--deep', '--sign', childEnv.MAC_SIGN_IDENTITY || '-', macApp]]
      ]
    },
    {
      label: 'xattr -cr',
      steps: [['xattr', ['-cr', macApp]]]
    }
  ]
  const winPackage = [
    {
      label: 'electron-builder --win --dir',
      steps: [['bunx', ['electron-builder', '--win', '--dir', ...outArg]]]
    },
    ...stampInstallMarker(winDir, 'win')
  ]

  // The CLI and the two harnesses, installed together. The members share no
  // outputs except the harness store's `.staging` dir: the two installs
  // share its stale-entry sweep (`store-writer.ts` cleanStaleEntries, 1 h
  // mtime guard), which is safe unless an install runs longer than an hour.
  // Every member runs to completion, so one run reports every failure.
  const ensureAll = () => [
    {
      parallel: [
        ...ensureCli(false),
        ...ensureHarness('opencode', false),
        ...ensureHarness('pi', false)
      ]
    }
  ]

  // electron-builder's install-app-deps shells out to node-pty's build, whose
  // `GetCommitHash.bat` is not found when the environment sets
  // NoDefaultCurrentDirectoryInExePath (agent shells do) — and a failed
  // postinstall used to skip every ensure after it. Drop the variable for that
  // one stage (Windows env keys are case-insensitive, so match that way).
  const withoutNoDefaultCwdExe = Object.fromEntries(
    Object.entries(childEnv).filter(
      ([k]) => k.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'
    )
  )

  return {
    // No typecheck: CI and the release workflows run `bun run typecheck` as their
    // own step. ensure-cli writes only vendor/claude-cli, which electron-vite
    // never reads, so the two run side by side.
    build: [{ parallel: [...ensureCli(false), ...electronViteBuild] }, ...stampBuildInfo],
    'build:mac': [...prepare({ typecheck: true }), ...stampBuildInfo, ...macPackage],
    'build:win': [...prepare({ typecheck: true }), ...stampBuildInfo, ...winPackage],
    // The local rebuild (design review ruling 6): what `build:mac` / `build:win`
    // do for the host, WITHOUT ensure-cli. In a worktree `vendor/claude-cli` is
    // the main checkout's (a link), and ensure-cli would rewrite it under every
    // other tree; the app checks instead that the tree's `claudeCliVersion`
    // matches what `vendor/claude-cli` holds. Output only into
    // CLAUDEUI_BUILD_OUT (`stageTargetRefusal` makes it required).
    'build:stage': [
      { parallel: [...typecheckStages, ...electronViteBuild] },
      ...stampBuildInfo,
      ...(platform === 'darwin' ? macPackage : platform === 'win32' ? winPackage : [])
    ],
    'build:linux': [
      ...prepare({ typecheck: false }),
      ...stampBuildInfo,
      {
        label: 'electron-builder --linux',
        steps: [['bunx', ['electron-builder', '--linux', ...outArg]]]
      }
    ],
    'build:unpack': [
      ...prepare({ typecheck: true }),
      ...stampBuildInfo,
      {
        label: 'electron-builder --dir',
        steps: [['bunx', ['electron-builder', '--dir', ...outArg]]]
      },
      ...hostMarker
    ],
    // `bun install` runs this (package.json#postinstall). Electron's binary
    // first (a failure stops the run), then the native rebuild (a failure is
    // recorded but the ensures still run), then the ensures.
    postinstall: [
      {
        label: 'electron install',
        steps: [['node', ['node_modules/electron/install.js']]]
      },
      {
        label: 'native deps',
        keepGoing: true,
        steps: [['bunx', ['electron-builder', 'install-app-deps'], { env: withoutNoDefaultCwdExe }]]
      },
      ...ensureAll()
    ],
    ensure: [...ensureAll()],
    'ensure-cli': [...ensureCli(false)],
    'update-cli': [...ensureCli(true)],
    'ensure-opencode': [...ensureHarness('opencode', false)],
    'update-opencode': [...ensureHarness('opencode', true)],
    'ensure-pi': [...ensureHarness('pi', false)],
    'update-pi': [...ensureHarness('pi', true)]
  }
}
