/**
 * Reading the break-glass password from the console (S5).
 *
 * ## Why this command exists at all
 *
 * security.md §"Headless bootstrap chain" step 4 promises a password-only
 * headless deployment for an operator who does not want passkeys: "provision the
 * credential through the host's own config/CLI (the host anchor)". Every other
 * way to set that credential needs a connection you do not have yet — with zero
 * passkeys AND no password, ADR-056 admits nobody. On a headless box the console
 * IS the host anchor (ADR-056/058 decision 6), so this is the same posture
 * `show-link` and `--disable-auth` already have, not a new one.
 *
 * ## The password never touches argv or the environment
 *
 * Both are readable by any process on the box (`/proc/<pid>/cmdline`, `ps`, the
 * Windows process list, a shell history file), and a credential that grants
 * operator-level access to the machine must not be recoverable from a `ps`
 * snapshot taken thirty seconds later. So there is no `--password` and no
 * `CLAUDEUI_PASSWORD`: the secret arrives on stdin, and only on stdin.
 *
 * ## Auto-detected pipe mode, rather than an explicit `--stdin`
 *
 * `process.stdin.isTTY` decides, and there is no flag. Three reasons:
 *
 *   - It is the SAME primitive echo suppression needs. A non-TTY stdin has no
 *     `setRawMode`, so "can I hide what you type" and "are you a human typing"
 *     are one question with one answer; a flag would let the two disagree.
 *   - There is no ambiguous case for a flag to resolve. A terminal is prompted;
 *     a pipe is read. Neither mode can do the other's job.
 *   - A provisioning script (`printf '%s\n' "$PW" | claudeui-server set-password`)
 *     works with no flag to remember, and a human who accidentally redirects
 *     stdin gets an immediate "no password on stdin" rather than a hang.
 *
 * The pipe path deliberately does NOT ask twice: a script has nothing to confirm
 * against, and reading a second line would either block forever or silently
 * compare the password against the empty string.
 *
 * ## What is NOT here
 *
 * No `--clear`. `HostAnchor.clearPassword()` exists, and riding it would be two
 * lines, but clearing is not a host-anchor need: `passwordBreakGlass: false` is
 * an ordinary web-editable setting, so the operator who wants the credential gone
 * can always reach it — while on a headless box with no passkey enrolled, a
 * console `--clear` is a self-brick whose only recovery is an enrollment link an
 * absent HTTPS origin may refuse to mint. Provisioning is the bootstrap;
 * removing is not.
 *
 * No strength rule either. `provisionPassword` owns the minimum length so the
 * console and the two web paths cannot drift, which is why a short password is
 * refused by the WRITER after both entries are typed rather than by this module
 * after the first.
 *
 * Kept free of the service graph so the branch table is unit-testable without a
 * database, and so the echo-suppression primitive (the one part CI cannot drive)
 * is isolated from the logic around it.
 */

/** Where the new password comes from, and whether it must be typed twice. */
export interface SecretIo {
  /** Read one secret. Writes `prompt` itself when it has somewhere to write it. */
  read(prompt: string): Promise<string>
  /**
   * Ask twice and compare. True on a terminal — a typo you cannot see is a
   * credential you cannot use — false on a pipe, which has nothing to confirm.
   */
  confirm: boolean
}

/**
 * The one line printed on success. Names what changed and what to do next, and
 * never echoes any part of the secret (not even its length: a length is a real
 * hint to anyone reading the operator's scrollback).
 */
export const PASSWORD_SET_CONFIRMATION =
  'Break-glass password set — sign in with it from a client, then enroll a passkey from Settings.'

/**
 * Read (and on a terminal, confirm) the new break-glass password.
 *
 * Throws with operator-facing text on an empty entry or a mismatch; the caller
 * prints the message and exits non-zero rather than dumping a stack trace at
 * someone who mistyped. NOTHING has been written when it throws — the read runs
 * before the service graph boots, so a mismatch costs an operator nothing.
 */
export async function readNewPassword(io: SecretIo): Promise<string> {
  const password = await io.read('New break-glass password: ')
  if (password.length === 0) {
    throw new Error(
      'No password was given, so nothing was changed. To turn the break-glass credential OFF, ' +
        'switch it off in Settings — the console only provisions it.'
    )
  }
  if (io.confirm) {
    const again = await io.read('Repeat it: ')
    if (again !== password) {
      throw new Error('The two entries do not match, so nothing was changed.')
    }
  }
  return password
}

/**
 * Read ONE line from a non-TTY stdin.
 *
 * Only the line TERMINATOR is stripped (LF, and a preceding CR so a CRLF pipe
 * from a Windows shell works) — never surrounding whitespace, because a password
 * may legitimately begin or end with a space and silently trimming one produces
 * a credential the operator cannot reproduce. Input after the first newline is
 * ignored: the secret is a line, not a file.
 *
 * Resolves to `''` on EOF with nothing read, which {@link readNewPassword} turns
 * into the actionable empty-entry error.
 */
export async function readPipedSecret(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding('utf8')
  let buffer = ''
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline !== -1) return stripCr(buffer.slice(0, newline))
  }
  return stripCr(buffer)
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

// The control keys raw mode hands us instead of handling itself. Spelled as code
// points rather than as literals so nothing in this file depends on an invisible
// byte surviving an editor, a diff viewer or a copy-paste.
const KEY_ETX = String.fromCharCode(3) // Ctrl-C
const KEY_EOT = String.fromCharCode(4) // Ctrl-D
const KEY_ESC = String.fromCharCode(27)
const KEY_DEL = String.fromCharCode(127)
const KEY_BACKSPACE = String.fromCharCode(8)
const SPACE = ' '

/** The markers a terminal wraps a PASTE in when bracketed-paste mode is on. */
const PASTE_BEGIN = `${KEY_ESC}[200~`
const PASTE_END = `${KEY_ESC}[201~`

/** Drop one leading line from `buffer`, or null when it holds no terminator yet. */
function takeLine(buffer: string): { line: string; rest: string } | null {
  const chars = Array.from(buffer)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch !== '\r' && ch !== '\n' && ch !== KEY_EOT) continue
    // CRLF is ONE terminator: without this the LF would start the next entry
    // with an empty line the operator never typed.
    const next = ch === '\r' && chars[i + 1] === '\n' ? i + 2 : i + 1
    return { line: chars.slice(0, i).join(''), rest: chars.slice(next).join('') }
  }
  return null
}

/**
 * A reader that asks a terminal for secrets with the echo OFF.
 *
 * A FACTORY rather than a plain function because consecutive reads share state:
 * see the carry-over note below.
 *
 * Raw mode is the only dependency-free primitive that both supported runtimes
 * expose (`tty.ReadStream.prototype.setRawMode` is implemented by node and by
 * bun), and it is the reason this reads bytes itself instead of using
 * `readline`: muting readline means overwriting its private `_writeToOutput`,
 * which is a private API on one runtime and an absent one on the other.
 *
 * Raw mode also means this owns the keys `readline` would have handled:
 *
 *   - Enter (CR, LF, or CRLF as one) and Ctrl-D end the entry;
 *   - Ctrl-C cancels — raw mode swallows SIGINT, so without this the operator
 *     could not get out;
 *   - backspace/DEL edit, because a secret you cannot correct is a secret you
 *     will get wrong. The edit is by code POINT: slicing a UTF-16 unit off a
 *     passphrase ending in an emoji leaves a lone surrogate, which provisions a
 *     credential the operator cannot reproduce and cannot see is wrong;
 *   - a chunk that STARTS with ESC after paste markers are stripped is a terminal
 *     key sequence (arrows, Home) and is dropped whole. Appending its printable
 *     tail — `[A` from an up-arrow — would put characters into the credential
 *     that the operator neither typed nor can see.
 *
 * ## Bracketed paste, and the carry-over
 *
 * A paste into a bracketed-paste terminal arrives as `ESC[200~…ESC[201~`. The
 * markers are STRIPPED and the payload kept: dropping the chunk for starting
 * with ESC would silently discard a pasted password. And because a paste can
 * carry more than one line, a `pw⏎pw⏎` paste answers BOTH prompts — so whatever
 * follows the terminator is carried to the next read instead of being dropped,
 * which is what stops the confirm prompt from waiting forever for input the
 * operator has already given.
 *
 * The raw mode is restored in a `finally`, so a throw cannot leave the operator
 * at a shell that no longer echoes.
 */
export function createHiddenSecretReader(
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream
): (prompt: string) => Promise<string> {
  // Everything typed or pasted PAST the Enter that ended the previous read.
  let carry = ''

  return async function readHidden(prompt: string): Promise<string> {
    if (typeof input.setRawMode !== 'function') {
      throw new Error(
        'This terminal cannot suppress echo, and the password must never be visible. ' +
          'Pipe it instead: printf \'%s\\n\' "$PW" | claudeui-server set-password'
      )
    }
    output.write(prompt)

    // A multi-line paste already answered this prompt — take the line and never
    // touch the terminal.
    const buffered = takeLine(carry)
    if (buffered) {
      carry = buffered.rest
      output.write('\n')
      return buffered.line
    }

    const wasRaw = input.isRaw === true
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    try {
      return await new Promise<string>((resolve, reject) => {
        // A partial line left by the previous paste is the start of this entry.
        let entered = carry
        carry = ''
        const finish = (settle: () => void): void => {
          input.off('data', onData)
          output.write('\n')
          settle()
        }
        const onData = (raw: string): void => {
          const chunk = raw.split(PASTE_BEGIN).join('').split(PASTE_END).join('')
          // A marker-only chunk (a paste split across reads), or an ordinary
          // key sequence — see the doc comment.
          if (chunk.length === 0 || chunk.startsWith(KEY_ESC)) return
          // Indexed over code POINTS, so the remainder handed to `carry` cannot
          // split an astral character in half.
          const chars = Array.from(chunk)
          for (let i = 0; i < chars.length; i++) {
            const ch = chars[i]
            if (ch === '\r' || ch === '\n' || ch === KEY_EOT) {
              const next = ch === '\r' && chars[i + 1] === '\n' ? i + 2 : i + 1
              carry = chars.slice(next).join('')
              finish(() => resolve(entered))
              return
            }
            // No carry to clear: it was drained into `entered` on the way into
            // this loop, and every path that REFILLS it returns immediately.
            if (ch === KEY_ETX) {
              finish(() => reject(new Error('Cancelled — nothing was changed.')))
              return
            }
            if (ch === KEY_DEL || ch === KEY_BACKSPACE) {
              entered = Array.from(entered).slice(0, -1).join('')
              continue
            }
            // Everything else printable; the remaining C0 controls are dropped.
            if (ch >= SPACE) entered += ch
          }
        }
        input.on('data', onData)
      })
    } finally {
      if (!wasRaw) input.setRawMode(false)
      input.pause()
    }
  }
}

/**
 * The process's own stdin, in whichever of the two modes it is actually in.
 *
 * The single place the TTY question is asked — see the module header for why it
 * is asked here rather than answered by a flag. The terminal reader is built
 * ONCE so both prompts share its carry-over.
 */
export function stdinSecretIo(): SecretIo {
  const input = process.stdin
  if (input.isTTY) {
    return { read: createHiddenSecretReader(input, process.stdout), confirm: true }
  }
  return { read: () => readPipedSecret(input), confirm: false }
}
