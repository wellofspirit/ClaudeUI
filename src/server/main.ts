/**
 * `claudeui-server` — the headless entrypoint (S3 stage 2).
 *
 * A sibling of `src/main` (the Electron desktop), not a part of `src/core`: both
 * are HOSTS that wire adapters and then hand control to the same Electron-free
 * service graph. That symmetry is the whole S3 design — one service graph, two
 * hosts, no second implementation of anything.
 *
 * What this file owns, and nothing more:
 *   1. choosing the SQLite driver for the runtime it finds itself on;
 *   2. wiring the headless `host.ts` adapters;
 *   3. parsing arguments and applying the two bootstrap settings;
 *   4. calling `startCoreServices` and starting the listener;
 *   5. the first-boot console chain and a clean shutdown.
 *
 * Steps 2, 4 and 5 are for the commands that SERVE. `set-password` is the one
 * subcommand that does not: it stops after step 1 plus a single DB write, and the
 * branch that enforces that carries the reasoning.
 *
 * ## Runtime detection lives HERE, deliberately
 *
 * The driver SEAM refuses to sniff — an entrypoint may, a library may not. This
 * is the entrypoint, and it is the only place in the codebase that asks "am I
 * bun or node". It matters because the answer is not cosmetic: S3 stage 0 proved
 * `better-sqlite3` PANICS the bun process (an uncatchable N-API fatal), so the
 * choice has to be made before anything opens a database, and made correctly.
 *
 * The `bun:sqlite` import is DYNAMIC for the same reason: under node the
 * specifier does not resolve at all, so a static import would break the
 * node-hosted distribution just to serve the bun one.
 *
 * ## What is deliberately absent
 *
 * No OAuth browser flow. `HostAuth` here is a read of what the vault and DB
 * already hold — signing a vendor account IN from a headless box is S4's
 * problem, and the `HostAuth` contract's DATA/STATUS-ONLY constraint says a core
 * module that needs more is scope creep, not a missing feature.
 */

// MUST be the first import in this file.
//
// The passkey stack (`@simplewebauthn/server` → `@peculiar/x509` → `tsyringe`)
// needs a `Reflect.metadata` polyfill installed before tsyringe's module body
// runs, or it throws `tsyringe requires a reflect polyfill` on load. Running
// from source that ordering happens naturally; BUNDLING does not preserve it —
// `bun build` hoists tsyringe's check ahead of the polyfill — so the
// distribution died at startup until the entrypoint pulled it in explicitly.
// Electron's main process never hit this because it is not bundled this way.
import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
import { setSqliteDriver, type SqliteDriver } from '../core/services/sqlite-driver'
import { setHostAuth, setHostIsPackaged, setHostPaths, setHostPicker } from '../core/host'
import { logger } from '../core/services/logger'
import { CliError, HELP_TEXT, parseServerArgs, type ServerOptions } from './cli'
import { runFirstBootChain } from './first-boot'
import { PASSWORD_SET_CONFIRMATION, readNewPassword, stdinSecretIo } from './set-password'

/** stdout, one line at a time — the console chain's only side effect. */
function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

/**
 * Report an operator-facing failure and stop. No stack trace: everything routed
 * here is something a person typed (a mismatched password, one too short to
 * accept), and a stack at that person tells them nothing they can act on.
 */
function fail(err: unknown): never {
  process.stderr.write(`claudeui-server: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

/** Whether this process is bun. The ONE runtime sniff in the codebase. */
function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/**
 * Load the driver for this runtime.
 *
 * The ENGINE is imported here and injected into the driver, rather than being
 * imported by the driver module itself. That is what makes the choice survive
 * bundling: `bun build` hoists a driver module's static engine import to
 * evaluation time even when the module is only reachable down a branch that
 * never runs, so a bundled server would die at startup on the OTHER runtime's
 * builtin (`No such built-in module: node:sqlite` under bun, and the mirror
 * image under node). Only these two `await import`s, guarded by the branch, are
 * lazy in a way the bundler respects.
 */
async function loadSqliteDriver(): Promise<SqliteDriver> {
  if (isBun()) {
    const [{ bunSqliteDriver }, { Database }] = await Promise.all([
      import('../core/services/sqlite/bun-sqlite-driver'),
      import('bun:sqlite')
    ])
    return bunSqliteDriver(Database)
  }
  const [{ nodeSqliteDriver }, { DatabaseSync }] = await Promise.all([
    import('../core/services/sqlite/node-sqlite-driver'),
    import('node:sqlite')
  ])
  return nodeSqliteDriver(DatabaseSync)
}

/**
 * Where the built web client lives, expressed the way `HostPaths` wants it.
 *
 * `RemoteServer.getWebClientDir()` resolves `<appPath>/out/web`, so `appPath`
 * must be the directory that CONTAINS `out/`. Three layouts have to work:
 *
 *   - **from source** — `__dirname` is `<repo>/src/server`, so the root is two
 *     levels up;
 *   - **pure-asset distribution** — the bundle sits at `<dist>/claudeui-server.js`
 *     with `<dist>/out/web` beside it, so the root is `__dirname` itself;
 *   - **compiled executable** — `__dirname` is bun's virtual `/$bunfs` root, which
 *     holds no assets at all, so the root is the directory of the EXECUTABLE.
 *
 * Rather than detect the packaging (which is exactly the kind of guess that
 * silently serves a stale bundle), each candidate is tested for the thing we
 * actually need: an `out/web` directory. `CLAUDEUI_APP_PATH` overrides
 * everything, for a layout nobody anticipated.
 */
function resolveAppPath(): string {
  const override = process.env.CLAUDEUI_APP_PATH
  if (override && override.trim() !== '') return path.resolve(override)

  const fromSource = path.resolve(__dirname, '..', '..')
  const candidates = [__dirname, path.dirname(process.execPath), fromSource]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'out', 'web'))) return candidate
  }
  // Nothing found: fall back to the source layout so the error a caller
  // eventually sees names a real path rather than a virtual one.
  return fromSource
}

/** Wire every host adapter the headless deployment needs. */
function installHostAdapters(): void {
  setHostPaths({ getAppPath: resolveAppPath })

  // A deployed server is not a dev build, so background usage/analytics writes
  // are ON. The desktop's dev-mode skip exists to stop a dev instance fighting
  // the production instance over the same snapshot files; a server has no such
  // twin, and its usage history is the only one there is.
  setHostIsPackaged(() => true)

  // No picker: `session:pick-folder` declares the `host` capability, so it is
  // unreachable from any remote client by construction, and there is no console
  // dialog to show. `pickHostDirectory()` resolves null with nothing wired —
  // the same answer a cancelled dialog gives — so this is left UNSET on
  // purpose rather than stubbed, and the call documents that.
  setHostPicker(null)

  // HostAuth: DATA/STATUS-ONLY, and here it is the honest empty implementation.
  // `accountState()` and `buildClaudeAccountRef()` already tolerate a null host
  // (they return null), which is why nothing is registered for them — a stub
  // returning a FABRICATED account state would be worse than no host at all,
  // because the session layer would then believe a Claude account is active.
  // Vendor OAuth from a headless box is S4.
  setHostAuth(null)
}

/** Apply the bootstrap flags that must land BEFORE the listener starts. */
function applyBootstrapSettings(
  anchor: { setConfig(patch: Record<string, unknown>): unknown },
  options: ServerOptions
): void {
  const patch: Record<string, unknown> = {}
  if (options.port !== undefined) patch.port = options.port
  if (options.bind !== undefined) patch.bindHost = options.bind
  // Absent `--tls` leaves the persisted mode alone — see ServerOptions.tls.
  if (options.tls !== undefined) patch.tlsMode = options.tls ? 1 : 0
  // The master switch. Routed through the SAME host-anchor writer the desktop's
  // `remote:set-config` uses, so the validation, the audit row and the
  // disconnect-every-client reaction are one implementation. That writer also
  // logs the startup-grade warning on the transition; the banner below repeats
  // it on EVERY start, because a warning that only fires on the day you flipped
  // the switch is not a warning about the state you are running in.
  if (options.disableAuth) patch.authPolicy = 'off'

  if (Object.keys(patch).length > 0) anchor.setConfig(patch)
}

async function main(): Promise<void> {
  let options: ServerOptions
  try {
    options = parseServerArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`claudeui-server: ${err.message}\n`)
      process.exit(2)
    }
    throw err
  }

  if (options.command === 'help') {
    print(HELP_TEXT)
    return
  }

  // `set-password` reads the secret BEFORE anything else boots, and the ordering
  // is deliberate. A mismatch or an empty entry then costs nothing at all — not
  // even a database file, which is what makes "nothing was changed" literally
  // true rather than nearly true — and no log line from a migration or a driver
  // can land between the prompt and the (invisible) keystrokes, which is how an
  // operator loses track of which entry they are typing into.
  const newPassword =
    options.command === 'set-password' ? await readNewPassword(stdinSecretIo()).catch(fail) : null

  // Driver first — before ANY module that might reach the DB is constructed.
  setSqliteDriver(await loadSqliteDriver())

  // `set-password` STOPS HERE, and the narrowness is the point.
  //
  // It is one row in one table, so it opens the database and constructs the
  // credential writer, and boots nothing else — no `startCoreServices`. Booting
  // the full graph for it was actively harmful, not merely wasteful: that graph
  // installs a recursive `fs.watch` on `~/.claude`, starts the usage poller (which
  // can lazily SPAWN an engine), runs the usage reconciler and block-usage
  // recalculation, arms every automation's cron timer, and lets `credentialSync`
  // write and delete engine credential files — all of which this command then
  // `process.exit`ed through the middle of. And it is a command an operator runs
  // NEXT TO a live `claudeui-server serve`, so it would have been a second full
  // graph racing the first over the same DB and the same vault.
  //
  // Host adapters are skipped for the same reason: nothing on this path resolves
  // an app path, an engine locator or an account state.
  if (newPassword !== null) {
    const { provisionBreakGlassPassword } = await import('../core/services/break-glass')
    try {
      provisionBreakGlassPassword(newPassword, { via: 'claudeui-server set-password' })
    } catch (err) {
      fail(err)
    }
    // The DB's retention timer is `unref`'d, so this process would exit on its
    // own — but exiting from the write callback is what guarantees the
    // confirmation is flushed first when stdout is a pipe, and it costs nothing
    // to be explicit about a command that is done.
    process.stdout.write(`${PASSWORD_SET_CONFIRMATION}\n`, () => process.exit(0))
    return
  }

  installHostAdapters()

  // Imported after the adapters are wired: these modules pull in the service
  // graph, and a static import would run their module bodies before
  // `setHostPaths` had published the app path the engine locators read.
  const { startCoreServices } = await import('../core/boot/core-services')
  const { sanitizedRemoteConfig } = await import('../core/services/remote-config-view')

  const core = startCoreServices({
    remoteAccessDisabled: false,
    // The desktop-auth pair. A headless server has no OAuth browser and no
    // multi-account UI, so both refuse loudly rather than pretending: the
    // channels stay REGISTERED (the surface must not depend on the host, or the
    // remote UI would render a different app on a server than on a desktop) and
    // fail with a message that names the reason.
    authDeps: {
      requireEngineAuth: () => {
        throw new Error(
          'Engine sign-in is not available on the headless server yet — sign in on the desktop app; ' +
            'the credential vault is shared.'
        )
      },
      setAccountEnabled: () => {
        throw new Error('Multi-account switching is not available on the headless server.')
      }
    },
    // No desktop, so no OS notifications. Automation runs still execute and
    // still emit their events to connected clients.
    notifier: undefined,
    // The server starts its listener EXPLICITLY below, from its arguments — a
    // process whose entire purpose is to listen must not have that decision
    // made for it by a persisted checkbox.
    autostart: false
  })

  const anchor = core.hostAnchor
  applyBootstrapSettings(anchor, options)

  // `show-link` is the recovery path: print and exit without ever listening…
  // except that a link only exists once the server is up, since both the LAN
  // channel key and the enrollment origin come from a live listener. So it
  // starts, prints, and stops.
  await anchor.reconcileAndAutostart().catch(() => {
    /* reconciliation is best-effort; a down tailscaled must not block the start */
  })
  await anchor.start()

  const summary = runFirstBootChain({
    config: sanitizedRemoteConfig(),
    server: core.remoteServer,
    print
  })

  if (options.command === 'show-link') {
    anchor.stop()
    // Nothing to enrol and nothing to reach = nothing was printed worth having.
    if (!summary.enrollUrl && !summary.lanUrl) {
      process.stderr.write(
        'claudeui-server: no access link is available. Start with --tls for an enrollment link, ' +
          'or --bind 0.0.0.0 for a LAN link.\n'
      )
      process.exit(1)
    }
    return
  }

  const status = anchor.status()
  logger.info(
    'server',
    `claudeui-server listening on port ${status.port} (sqlite: ${isBun() ? 'bun:sqlite' : 'node:sqlite'})`
  )

  // Graceful shutdown. `stop()` is fire-and-forget by design (see host-anchor),
  // so the exit is not gated on peers that may never close their sockets.
  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    logger.info('server', `${signal} received — shutting down`)
    anchor.stop()
    // Give the listener a moment to close before the process goes, but never
    // hang on it.
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  process.stderr.write(
    `claudeui-server: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})
