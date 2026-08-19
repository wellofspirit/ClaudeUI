/**
 * `claudeui-server` argument parsing (S3 stage 2).
 *
 * Zero-dependency: `node:util`'s `parseArgs` is a builtin on both runtimes this
 * entrypoint targets, so the server adds no supply-chain surface to gain a flag
 * parser. Kept in its own module, free of every side effect, so the surface can
 * be unit-tested without booting a service graph.
 *
 * ## What is a flag, and what is not
 *
 * The surface is deliberately TINY. Everything that can be a DB setting IS a DB
 * setting, editable from the remote UI once you are connected (the owner's
 * "settings DB-resident" ruling), so flags exist only for the two things a
 * setting cannot cover:
 *
 *   1. **Bootstrap** — where to listen (`--port`, `--bind`, `--tls`). You cannot
 *      edit a setting on a server you cannot reach yet.
 *   2. **The host anchor** — operations that on the desktop are reachable ONLY
 *      from the machine itself, never over the wire. `--disable-auth` is the
 *      master switch (ADR-056: host-anchor by ruling, and on a headless box the
 *      console IS the host anchor), `show-link` is the retired-link recovery
 *      path — if your only enrollment link expired, the console is the one place
 *      that can mint another — and `set-password` provisions the break-glass
 *      credential, which is security.md §"Headless bootstrap chain" step 4: the
 *      password-only deployment has to get its password from SOMEWHERE, and with
 *      zero credentials there is no connection to set it over.
 *
 * Anything else belongs in Settings, not here. Note the asymmetry that keeps
 * `set-password` inside the rule: the console can PROVISION the credential but
 * cannot clear it. Turning break-glass off is something you can only want once
 * you can already get in, so it is a Settings action — and on a headless box
 * with no passkey enrolled, a console `--clear` would be a self-brick.
 */

import { parseArgs } from 'node:util'

/** The subcommand, if any. `serve` is the default when none is given. */
export type ServerCommand = 'serve' | 'show-link' | 'set-password' | 'help'

export interface ServerOptions {
  command: ServerCommand
  /** Listen port. `undefined` ⇒ use the persisted config (0 ⇒ random). */
  port?: number
  /** Bind address. `undefined` ⇒ use the persisted config. */
  bind?: string
  /**
   * Serve over `tailscale serve` HTTPS. `undefined` leaves the persisted
   * `tlsMode` alone — an absent flag must not silently turn TLS OFF for a server
   * whose stored config asked for it.
   */
  tls?: boolean
  /**
   * Turn remote authentication OFF (policy `off`). Host-anchor only, and
   * deliberately not `--disable-auth=false`: re-enabling is a Settings action,
   * because a flag that can silently re-enable is a flag that can silently
   * disable on the next restart when someone edits the unit file.
   */
  disableAuth: boolean
}

export class CliError extends Error {}

// The "Minimum 12 characters" in `set-password`'s entry is DISPLAY only — it
// restates `MIN_PASSWORD_LENGTH` from `core/services/remote-auth.ts`, which is
// the sole enforcement point (`provisionPassword` throws) and is shared with both
// web paths. Importing the constant here to interpolate it would drag `db.ts`
// into a module whose whole point is being free of every side effect, so the
// number is duplicated deliberately and `cli.test.ts` pins the two together.
export const HELP_TEXT = `claudeui-server — headless ClaudeUI

USAGE
  claudeui-server [serve] [options]
  claudeui-server show-link
  claudeui-server set-password
  claudeui-server --help

COMMANDS
  serve                Run the server (default when no command is given).
  show-link            Print the current access link and exit. Mints a fresh
                       one-time enrollment link when no credential is enrolled
                       yet — this is the recovery path for an expired link.
  set-password         Provision the break-glass password and exit. Minimum 12
                       characters. Asks twice on a terminal, with echo off. When
                       stdin is NOT a terminal it reads the password as one
                       line, unconfirmed
                       (\`printf '%s\\n' "$PW" | claudeui-server set-password\`),
                       so a provisioning script needs no flag. The password is
                       never taken as an argument or an environment variable —
                       both are readable from the process list. Takes no
                       options. To turn break-glass OFF, switch it off in
                       Settings; the console only provisions.

OPTIONS
  -p, --port <n>       Listen port. Omitted, the persisted setting is used
                       (0 = an OS-assigned random port).
  -b, --bind <addr>    Bind address, e.g. 0.0.0.0 for LAN. Omitted, the
                       persisted setting is used. A non-loopback bind gets a
                       persistent LAN channel key on first use.
      --tls            Serve over Tailscale HTTPS (\`tailscale serve\`). The
                       listener itself stays on loopback. Omitting the flag
                       leaves the persisted setting unchanged.
      --disable-auth   Disable remote authentication entirely (policy "off").
                       Every client that can reach the port gets operator-level
                       access to this machine. Host-anchor only — a remote
                       client can never set this. Re-enable it from Settings.
  -h, --help           Show this help.

CONFIGURATION
  Everything else — passkeys, the break-glass password, step-up tiers, the
  terminal toggle, audit retention — lives in the database and is edited from
  the web UI once you are connected. The surface above covers only what you
  cannot configure over a connection you do not have yet, which is also why
  \`set-password\` can provision the break-glass credential but not remove it.
`

/**
 * Parse `argv` (the arguments AFTER the executable and script, i.e.
 * `process.argv.slice(2)`).
 *
 * Throws {@link CliError} with a user-facing message on anything malformed —
 * the caller prints it and exits non-zero rather than dumping a stack trace at
 * an operator who typed a bad port.
 */
export function parseServerArgs(argv: readonly string[]): ServerOptions {
  // Take the subcommand off the front BEFORE parseArgs: positionals mixed with
  // options are exactly where hand-rolled parsers get confusing, and there is
  // only ever one.
  let command: ServerCommand = 'serve'
  const rest = [...argv]
  if (rest.length > 0 && !rest[0].startsWith('-')) {
    const candidate = rest.shift() as string
    if (
      candidate === 'serve' ||
      candidate === 'show-link' ||
      candidate === 'set-password' ||
      candidate === 'help'
    ) {
      command = candidate
    } else {
      throw new CliError(`Unknown command "${candidate}". Try --help.`)
    }
  }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        port: { type: 'string', short: 'p' },
        bind: { type: 'string', short: 'b' },
        tls: { type: 'boolean' },
        'disable-auth': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    })
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)} Try --help.`)
  }

  const values = parsed.values as {
    port?: string
    bind?: string
    tls?: boolean
    'disable-auth'?: boolean
    help?: boolean
  }

  if (values.help || command === 'help') {
    return { command: 'help', disableAuth: false }
  }

  // `set-password` writes ONE row and exits, so every other flag on the line is
  // a lie about what the invocation will do. Refusing beats ignoring: silently
  // dropping `--disable-auth` from `set-password --disable-auth` would leave an
  // operator believing they had flipped the master switch.
  if (command === 'set-password') {
    const stray = (['port', 'bind', 'tls', 'disable-auth'] as const).filter(
      (key) => values[key] !== undefined
    )
    if (stray.length > 0) {
      throw new CliError(
        `set-password takes no options (got ${stray.map((k) => `--${k}`).join(', ')}). ` +
          'It provisions the break-glass password and exits — run serve separately.'
      )
    }
  }

  let port: number | undefined
  if (values.port !== undefined) {
    port = Number(values.port)
    // 0 is legal and means "let the OS pick", matching the persisted setting's
    // meaning. Everything else must clear the privileged range, exactly as
    // `remote:set-config` enforces — one rule, both host surfaces.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new CliError(`--port must be an integer between 0 and 65535 (got "${values.port}").`)
    }
    if (port !== 0 && port < 1024) {
      throw new CliError(`--port must be 0 (random) or between 1024 and 65535 (got ${port}).`)
    }
  }

  const bind = values.bind
  if (bind !== undefined && bind.trim() === '') {
    throw new CliError('--bind requires an address, e.g. --bind 0.0.0.0')
  }

  return {
    command,
    port,
    bind,
    // `undefined` (flag absent) is meaningfully different from `false` here —
    // see ServerOptions.tls.
    tls: values.tls,
    disableAuth: values['disable-auth'] === true
  }
}
