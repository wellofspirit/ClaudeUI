/**
 * @vitest-environment node
 *
 * `claudeui-server set-password` (S5).
 *
 * Two layers, because the command has two halves with very different testability:
 *
 *  1. The BRANCH TABLE — confirm-or-not, empty entry, mismatch, and how a line is
 *     taken off a non-TTY stdin. Pure, driven by an in-memory stream.
 *  2. The WRITE — `provisionBreakGlassPassword`, the writer the desktop's
 *     `remote:set-password` goes through too, against a real (temp) DB via the
 *     driver seam. This is the assertion that matters most: the console must
 *     produce a credential a normal client can actually authenticate with, not
 *     merely a row that looks plausible. So the test computes the proof the way
 *     a browser does and hands it to the production verifier.
 *
 * Echo suppression itself is NOT tested: whether the OS really stops echoing
 * needs a live TTY, which CI does not have. It is isolated behind
 * `createHiddenSecretReader` for exactly that reason — everything raw mode makes
 * THIS module responsible for is driven through a fake terminal below — and the
 * smoke run on a real pty is what covers the rest.
 *
 * The DB is isolated per test by redirecting `os.homedir()` at a temp dir — the
 * db singleton opens `~/.claude/ui/operational.db` lazily, so a redirect
 * installed before the first import is enough, and the real user DB is never
 * touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import {
  PASSWORD_SET_CONFIRMATION,
  createHiddenSecretReader,
  readNewPassword,
  readPipedSecret,
  type SecretIo
} from '../set-password'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'set-password-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

/** A non-TTY stdin carrying `text`, the way a provisioning script pipes it. */
function pipe(text: string): NodeJS.ReadableStream {
  return Readable.from([text]) as unknown as NodeJS.ReadableStream
}

/** A scripted terminal: each `read` hands back the next queued entry. */
function typed(...entries: string[]): SecretIo {
  const queue = [...entries]
  return {
    confirm: true,
    read: async () => {
      if (queue.length === 0) throw new Error('test read past the end of the script')
      return queue.shift() as string
    }
  }
}

// ---------------------------------------------------------------------------
// The branch table
// ---------------------------------------------------------------------------

describe('readPipedSecret', () => {
  it('takes the first line and ignores the rest', async () => {
    expect(await readPipedSecret(pipe('correct horse\nsecond line\n'))).toBe('correct horse')
  })

  it('strips a CRLF terminator, so a Windows shell pipe works', async () => {
    expect(await readPipedSecret(pipe('correct horse\r\n'))).toBe('correct horse')
  })

  it('accepts a final line with no terminator at all', async () => {
    expect(await readPipedSecret(pipe('correct horse'))).toBe('correct horse')
  })

  it('preserves leading and trailing spaces', async () => {
    // A password may legitimately end in a space; trimming one silently
    // provisions a credential the operator cannot reproduce.
    expect(await readPipedSecret(pipe('  spaced out  \n'))).toBe('  spaced out  ')
  })

  it('resolves empty on EOF with nothing piped', async () => {
    expect(await readPipedSecret(pipe(''))).toBe('')
  })

  it('reassembles a secret split across chunks', async () => {
    const stream = Readable.from(['corr', 'ect ho', 'rse\n']) as unknown as NodeJS.ReadableStream
    expect(await readPipedSecret(stream)).toBe('correct horse')
  })
})

/**
 * A stand-in terminal.
 *
 * Whether the OS really stops echoing is the OS's business and needs a live
 * pty; what this fake pins is everything raw mode makes THIS module responsible
 * for — the control keys `readline` would otherwise have handled, and the
 * promise that the terminal is put back the way it was found.
 */
function fakeTty(): {
  input: NodeJS.ReadStream
  output: NodeJS.WritableStream
  written: string[]
  rawModeCalls: boolean[]
  type(chunk: string): void
} {
  const emitter = new EventEmitter()
  const rawModeCalls: boolean[] = []
  const written: string[] = []
  const input = Object.assign(emitter, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      rawModeCalls.push(mode)
      ;(input as { isRaw: boolean }).isRaw = mode
      return input
    },
    setEncoding() {
      return input
    },
    resume() {
      return input
    },
    pause() {
      return input
    }
  }) as unknown as NodeJS.ReadStream
  const output = {
    write(chunk: string) {
      written.push(chunk)
      return true
    }
  } as unknown as NodeJS.WritableStream
  return {
    input,
    output,
    written,
    rawModeCalls,
    type: (chunk: string) => emitter.emit('data', chunk)
  }
}

const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const ESC = String.fromCharCode(27)
const DEL = String.fromCharCode(127)
const PASTE_BEGIN = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

describe('createHiddenSecretReader', () => {
  it('prompts, collects until Enter, and never writes the secret back', async () => {
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('New password: ')
    tty.type('hunter')
    tty.type('2\r')
    expect(await pending).toBe('hunter2')
    // The prompt and the closing newline, and nothing else — no echo, not even
    // a masking character (which would leak the length).
    expect(tty.written).toEqual(['New password: ', '\n'])
  })

  it('restores the terminal on the way out, in both directions', async () => {
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type('secret\n')
    await pending
    expect(tty.rawModeCalls).toEqual([true, false])
  })

  it('restores the terminal even when the operator cancels', async () => {
    // Raw mode swallows SIGINT, so leaving it on after a Ctrl-C would hand the
    // operator back a shell that no longer echoes.
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type(CTRL_C)
    await expect(pending).rejects.toThrow(/Cancelled/)
    expect(tty.rawModeCalls).toEqual([true, false])
  })

  it('ends on Ctrl-D as well as Enter', async () => {
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type(`typed${CTRL_D}`)
    expect(await pending).toBe('typed')
  })

  it('edits with backspace and DEL', async () => {
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type('abcX')
    tty.type(DEL)
    tty.type('dY\b')
    tty.type('e\n')
    expect(await pending).toBe('abcde')
  })

  it('backspaces a whole astral character, not half of one', async () => {
    // Slicing a UTF-16 unit leaves a lone surrogate: the entry LOOKS corrected
    // (nothing is echoed either way) but provisions a credential the operator
    // cannot reproduce. Type an emoji, rub it out, retype — must round-trip.
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type('pass\u{1F510}')
    tty.type(DEL)
    tty.type('\u{1F510}word\n')
    const entered = await pending
    expect(entered).toBe('pass\u{1F510}word')
    // The decisive check: no unpaired surrogate survived the edit.
    expect(entered).toBe(Array.from(entered).join(''))
    expect(/[\uD800-\uDFFF]/.test(entered.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(
      false
    )
  })

  it('drops a terminal key sequence whole rather than banking its printable tail', async () => {
    // An up-arrow arrives as ESC [ A. Appending the `[A` would put two
    // characters into the credential that the operator neither typed nor sees.
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type('good')
    tty.type(`${ESC}[A`)
    tty.type('pass\r')
    expect(await pending).toBe('goodpass')
  })

  it('keeps an astral character in a pasted passphrase intact', async () => {
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type('pass\u{1F510}word\n')
    expect(await pending).toBe('pass\u{1F510}word')
  })

  it('keeps a BRACKETED paste instead of discarding it for starting with ESC', async () => {
    // A bracketed-paste chunk opens with ESC just like an arrow key does.
    // Dropping it would silently swallow a pasted password.
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type(`${PASTE_BEGIN}pasted-secret${PASTE_END}`)
    tty.type('\r')
    expect(await pending).toBe('pasted-secret')
  })

  it('handles a paste whose markers arrive in separate chunks', async () => {
    const tty = fakeTty()
    const pending = createHiddenSecretReader(tty.input, tty.output)('p: ')
    tty.type(PASTE_BEGIN)
    tty.type('split-across-chunks')
    tty.type(PASTE_END)
    tty.type('\n')
    expect(await pending).toBe('split-across-chunks')
  })

  it('carries a multi-line paste over to the NEXT prompt', async () => {
    // `pw⏎pw⏎` pasted at the first prompt answers both. Dropping the remainder
    // left the confirm read waiting forever for input already given.
    const tty = fakeTty()
    const read = createHiddenSecretReader(tty.input, tty.output)
    const first = read('New password: ')
    tty.type(`${PASTE_BEGIN}both-lines-here\r\nboth-lines-here\r\n${PASTE_END}`)
    expect(await first).toBe('both-lines-here')
    // The second read is answered from the carry-over without the terminal ever
    // going back into raw mode.
    const before = tty.rawModeCalls.length
    expect(await read('Repeat it: ')).toBe('both-lines-here')
    expect(tty.rawModeCalls.length).toBe(before)
  })

  it('carries a PARTIAL trailing line into the next entry rather than losing it', async () => {
    const tty = fakeTty()
    const read = createHiddenSecretReader(tty.input, tty.output)
    const first = read('New password: ')
    tty.type('line-one\nline-tw')
    expect(await first).toBe('line-one')
    const second = read('Repeat it: ')
    tty.type('o\n')
    expect(await second).toBe('line-two')
  })

  it('treats CRLF as ONE terminator', async () => {
    // A lone LF left over would end the next entry instantly as the empty
    // string, which reads to the operator as a mysterious mismatch.
    const tty = fakeTty()
    const read = createHiddenSecretReader(tty.input, tty.output)
    const first = read('p: ')
    tty.type('windows-line\r\nsecond-line\r\n')
    expect(await first).toBe('windows-line')
    expect(await read('again: ')).toBe('second-line')
  })

  it('refuses outright when the stream cannot suppress echo', async () => {
    // Fail closed: printing the prompt and reading in the clear would put the
    // credential in the operator's scrollback.
    const noRawMode = new EventEmitter() as unknown as NodeJS.ReadStream
    const tty = fakeTty()
    await expect(createHiddenSecretReader(noRawMode, tty.output)('p: ')).rejects.toThrow(
      /cannot suppress echo/
    )
    expect(tty.written).toEqual([])
  })
})

describe('readNewPassword', () => {
  it('asks twice on a terminal and returns the agreed value', async () => {
    expect(await readNewPassword(typed('a-long-enough-password', 'a-long-enough-password'))).toBe(
      'a-long-enough-password'
    )
  })

  it('refuses a mismatch and says nothing was changed', async () => {
    await expect(readNewPassword(typed('first-entry-here', 'second-entry-here'))).rejects.toThrow(
      /do not match.*nothing was changed/
    )
  })

  it('asks ONCE on a pipe — a script has nothing to confirm against', async () => {
    const stream = pipe('piped-password-12\n')
    let reads = 0
    const io: SecretIo = {
      confirm: false,
      read: () => {
        reads++
        return readPipedSecret(stream)
      }
    }
    expect(await readNewPassword(io)).toBe('piped-password-12')
    expect(reads).toBe(1)
  })

  it('refuses an empty entry and points at Settings for turning it OFF', async () => {
    // Empty must never be overloaded as "clear the credential": clearing is a
    // separate concept with different consequences, and on a headless box with
    // no passkey it is a self-brick.
    const io: SecretIo = { confirm: false, read: () => readPipedSecret(pipe('')) }
    await expect(readNewPassword(io)).rejects.toThrow(/No password was given/)
    await expect(readNewPassword(io)).rejects.toThrow(/Settings/)
  })
})

// ---------------------------------------------------------------------------
// The write, against a real DB through the driver seam
// ---------------------------------------------------------------------------

/**
 * A fresh module graph over a fresh temp DB, holding exactly what
 * `claudeui-server set-password` itself boots: the driver, the DB, and the
 * break-glass writer. NO host anchor and NO `startCoreServices` — the command's
 * narrowness is a property under test, not an implementation detail, so the
 * fixture that stands in for it must not be wider than it is.
 *
 * `vi.resetModules()` hands back a fresh `sqlite-driver` too, and the seam has
 * no default engine (S3 stage 1) — so the driver is installed again right where
 * the fresh `db` is imported.
 */
async function freshConsole(): Promise<{
  provisionBreakGlassPassword: typeof import('../../core/services/break-glass').provisionBreakGlassPassword
  db: typeof import('../../core/services/db')
  remoteAuth: typeof import('../../core/services/remote-auth')
  configView: typeof import('../../core/services/remote-config-view')
  /** What `claudeui-server` passes as the actor — `method: 'host'`, console label. */
  consoleActor: import('../../core/ipc/command-registry').CommandConnection
}> {
  vi.resetModules()
  const driverSeam = await import('../../core/services/sqlite-driver')
  const { betterSqlite3Driver } = await import('../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())

  const { provisionBreakGlassPassword } = await import('../../core/services/break-glass')
  const db = await import('../../core/services/db')
  const remoteAuth = await import('../../core/services/remote-auth')
  const configView = await import('../../core/services/remote-config-view')
  const { hostConnection } = await import('../../core/ipc/command-registry')
  return {
    provisionBreakGlassPassword,
    db,
    remoteAuth,
    configView,
    consoleActor: hostConnection('server-console')
  }
}

/**
 * The same fixture plus a host anchor, for the shared-writer tests.
 *
 * `asConsole` picks which HOST SURFACE the anchor attributes its audited writes
 * to — the default (no `actor`) is what `src/main` constructs, the console actor
 * is what `claudeui-server` passes through `startCoreServices`.
 */
async function freshAnchor(opts?: { asConsole?: boolean }): Promise<{
  anchor: import('../../core/boot/host-anchor').HostAnchor
  db: typeof import('../../core/services/db')
  disconnects: () => number
  surfaceSweeps: () => number
  resumeSweeps: () => number
}> {
  const { db, consoleActor } = await freshConsole()
  const { createHostAnchor } = await import('../../core/boot/host-anchor')

  let disconnected = 0
  let surfaceSwept = 0
  let resumeSweeps = 0
  const anchor = createHostAnchor({
    // The three reactions the tested paths reach: `setPassword`'s 4008 sweep,
    // `setConfig`'s 4009 auth-surface sweep, and (ADR-063) the resumption-token
    // sweep the transition to auth-mode `off` owes. A stub keeps a listener (and
    // a machine-global port claim) out of a unit test.
    remoteServer: {
      disconnectPasswordClients: () => {
        disconnected++
      },
      disconnectAuthSurfaceClients: () => {
        surfaceSwept++
      },
      clearResumeTokens: () => {
        resumeSweeps++
      }
    } as unknown as import('../../core/services/remote-server').RemoteServer,
    tailscaleManager:
      {} as unknown as import('../../core/services/tailscale-manager').TailscaleManager,
    remoteAccessDisabled: true,
    ...(opts?.asConsole ? { actor: consoleActor } : {})
  })
  return {
    anchor,
    db,
    disconnects: () => disconnected,
    surfaceSweeps: () => surfaceSwept,
    resumeSweeps: () => resumeSweeps
  }
}

/**
 * The proof a compliant client sends: `hex(scrypt(NFC(password), salt, params))`,
 * derived ONLY from what `/remote/auth-info` advertises. Deliberately not built
 * from the module's private constants — the point of the assertion is that the
 * console's write is usable by a client that knows nothing but the public
 * parameters.
 */
function clientProof(
  password: string,
  saltHex: string,
  kdf: { dkLen: number; N: number; r: number; p: number }
): string {
  return crypto
    .scryptSync(
      Buffer.from(password.normalize('NFC'), 'utf-8'),
      Buffer.from(saltHex, 'hex'),
      kdf.dkLen,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 }
    )
    .toString('hex')
}

const VIA = 'claudeui-server set-password'

describe('the set-password write path', () => {
  it('provisions a credential a normal client can authenticate with', async () => {
    const { provisionBreakGlassPassword, remoteAuth, consoleActor } = await freshConsole()

    // The whole command, in the order main.ts runs it: read a piped line, then
    // hand it to the break-glass writer under the console's own host identity.
    // No host anchor in sight — the console has no listener, so it constructs
    // none.
    const password = await readNewPassword({
      confirm: false,
      read: () => readPipedSecret(pipe('console-provisioned-pw\n'))
    })
    provisionBreakGlassPassword(password, { via: VIA, actor: consoleActor })

    const provider = remoteAuth.dbPasswordAuthProvider()
    const params = provider.params()
    expect(params).not.toBeNull()
    expect(provider.verify(clientProof(password, params!.saltHex, params!.kdf))).toBe(true)
    // A wrong proof of the right shape must still fail — otherwise "verify"
    // could be passing on length alone.
    expect(provider.verify(crypto.randomBytes(32).toString('hex'))).toBe(false)
  })

  it('flips the advertised state to passwordSet', async () => {
    const { provisionBreakGlassPassword, configView } = await freshConsole()
    expect(configView.sanitizedRemoteConfig().passwordSet).toBe(false)

    provisionBreakGlassPassword('console-provisioned-pw', { via: VIA })

    const after = configView.sanitizedRemoteConfig()
    expect(after.passwordSet).toBe(true)
    expect(after.passwordUpdatedAt).toBeGreaterThan(0)
  })

  it('writes an auth:settings-change row shaped like the web path’s, naming the console', async () => {
    const { provisionBreakGlassPassword, db, consoleActor } = await freshConsole()
    provisionBreakGlassPassword('console-provisioned-pw', { via: VIA, actor: consoleActor })

    const rows = db.listAuditLog({ limit: 20 })
    const row = rows.find((r) => r.channel === 'auth:settings-change')
    expect(row).toBeDefined()
    expect(row).toMatchObject({ capability: 'admin', kind: 'command', outcome: 'ok' })
    // The row SHAPE is shared with `authcfg:set-password` (one `auditSettingsChange`
    // writer); `detail` is what says which VERB the hands were on.
    expect(row!.detail).toBe(`break-glass password rotated via ${VIA} on the host anchor`)
  })

  // The 2026-08-20 rename, pinned end to end on a real DB. Before it, a console
  // rotation on a headless box wrote `method: 'desktop'` / `label:
  // 'desktop-renderer'` — a row naming a renderer that does not exist there.
  it('attributes the console write to method "host" / label "server-console"', async () => {
    const { provisionBreakGlassPassword, db, consoleActor } = await freshConsole()
    provisionBreakGlassPassword('console-provisioned-pw', { via: VIA, actor: consoleActor })

    const row = db.listAuditLog({ limit: 20 }).find((r) => r.channel === 'auth:settings-change')
    expect(row).toMatchObject({ method: 'host', label: 'server-console' })
  })

  it('attributes the DESKTOP host anchor to method "host" / label "desktop-renderer"', async () => {
    // Same method — both are the host's own surface — and the label is the whole
    // difference. `createHostAnchor` with no `actor` is what `src/main` does.
    const { anchor, db } = await freshAnchor()
    anchor.setPassword('desktop-provisioned-pw')

    const row = db.listAuditLog({ limit: 20 }).find((r) => r.channel === 'auth:settings-change')
    expect(row).toMatchObject({ method: 'host', label: 'desktop-renderer' })
  })

  it('carries a construction-time actor through the anchor’s own setPassword', async () => {
    // The knob `claudeui-server` turns: it never calls `provisionBreakGlassPassword`
    // for `remote:set-password`, it goes through the anchor — so the actor has to
    // survive that hop or an anchor-mediated rotation would still be attributed to
    // a renderer.
    const { anchor, db } = await freshAnchor({ asConsole: true })
    anchor.setPassword('console-anchor-pw')

    const row = db.listAuditLog({ limit: 20 }).find((r) => r.channel === 'auth:settings-change')
    expect(row).toMatchObject({ method: 'host', label: 'server-console' })
  })

  // `--disable-auth` is the ONE `hostActor` consumer that fires on a live
  // `claudeui-server serve`: `applyBootstrapSettings` turns the flag into
  // `setConfig({ authPolicy: 'off' })`, which is the single most important row in
  // the trail — somebody turned authentication off on this box. The LABEL is the
  // load-bearing assertion: `method` would read `host` even on the default actor
  // (that is the rename), so only the label proves the console's identity
  // actually reached `auditAuthPolicyChange` rather than the renderer default.
  it('attributes a console --disable-auth policy row to label "server-console"', async () => {
    const { anchor, db, surfaceSweeps, resumeSweeps } = await freshAnchor({ asConsole: true })

    anchor.setConfig({ authPolicy: 'off' })

    const row = db.listAuditLog({ limit: 20 }).find((r) => r.channel === 'auth:policy-change')
    expect(row).toMatchObject({
      channel: 'auth:policy-change',
      method: 'host',
      label: 'server-console',
      capability: 'admin',
      kind: 'command',
      outcome: 'ok'
    })
    expect(row!.detail).toContain('remote:set-config on the host anchor')
    // The other half of the same branch: auditing a change nobody was
    // re-admitted for would be a trail that lies.
    expect(surfaceSweeps()).toBe(1)
    // …and the third half since ADR-063: turning authentication OFF must not
    // leave a resumption token alive to walk back in on when it is turned on
    // again. Nothing minted before the anchor-guarded flip survives it.
    expect(resumeSweeps()).toBe(1)
  })

  it('an auth-surface change that is NOT the `off` flip leaves resumption tokens alone', async () => {
    const { anchor, surfaceSweeps, resumeSweeps } = await freshAnchor({ asConsole: true })

    // A break-glass flip is a full auth-surface change (4009 sweep and all) —
    // and deliberately NOT an invalidation: the fresh handshake presents the
    // token and the rules now in force judge it, exactly like every other
    // credential (ADR-063 §Invalidation).
    anchor.setConfig({ passwordBreakGlass: false })
    expect(surfaceSweeps()).toBe(1)
    expect(resumeSweeps()).toBe(0)

    // Nor does a change made while ALREADY `off` re-sweep: only the transition.
    anchor.setConfig({ authPolicy: 'off' })
    expect(resumeSweeps()).toBe(1)
    anchor.setConfig({ sessionMaxAgeHours: 8 })
    expect(resumeSweeps()).toBe(1)
  })

  it('leaves the DESKTOP anchor’s policy row on the renderer label', async () => {
    const { anchor, db } = await freshAnchor()

    anchor.setConfig({ authPolicy: 'off' })

    const row = db.listAuditLog({ limit: 20 }).find((r) => r.channel === 'auth:policy-change')
    expect(row).toMatchObject({ method: 'host', label: 'desktop-renderer' })
  })

  it('honours the SAME strength rule the web path applies, and writes nothing when it refuses', async () => {
    const { provisionBreakGlassPassword, configView, db } = await freshConsole()
    expect(() => provisionBreakGlassPassword('short', { via: VIA })).toThrow(
      /at least \d+ characters/
    )

    expect(configView.sanitizedRemoteConfig().passwordSet).toBe(false)
    // The refusal must not audit a rotation that did not happen.
    expect(db.listAuditLog({ limit: 20 }).some((r) => r.channel === 'auth:settings-change')).toBe(
      false
    )
  })

  it('is the SAME writer the desktop host anchor uses, which adds the 4008 sweep', async () => {
    // One writer, two surfaces. The desktop keeps its default `via` (it must not
    // start attributing itself to the console) and adds the disconnect the
    // console cannot do: it has no listener holding password clients.
    const { anchor, db, disconnects } = await freshAnchor()
    anchor.setPassword('desktop-provisioned-pw')

    const row = db.listAuditLog({ limit: 20 }).find((r) => r.channel === 'auth:settings-change')
    expect(row!.detail).toBe(
      'break-glass password rotated via remote:set-password on the host anchor'
    )
    expect(disconnects()).toBe(1)
  })

  it('does not sweep on a refusal', async () => {
    const { anchor, disconnects } = await freshAnchor()
    expect(() => anchor.setPassword('short')).toThrow(/at least \d+ characters/)
    expect(disconnects()).toBe(0)
  })
})

describe('the confirmation line', () => {
  it('names what changed and never hints at the secret', () => {
    expect(PASSWORD_SET_CONFIRMATION).toMatch(/Break-glass password set/)
    // No length, no prefix, no echo — an operator's scrollback is read by
    // whoever can read the console, which is the whole trust boundary here.
    expect(PASSWORD_SET_CONFIRMATION).not.toMatch(/\d/)
  })
})
