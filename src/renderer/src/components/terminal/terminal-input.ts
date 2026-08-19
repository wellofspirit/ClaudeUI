/**
 * The seam a NON-keyboard affordance (the mobile accessory key row) uses to put
 * bytes into a terminal.
 *
 * It deliberately does NOT call `terminal:write`. Every keystroke xterm produces
 * goes through XTermInstance's `onData` handler, and that handler is where the
 * ADR-054 read/act gate lives: in read-only state the byte is DROPPED and a
 * step-up ceremony is asked for instead. A button that reached for the IPC
 * channel directly would bypass that gate — the server would refuse the frame
 * silently (a `term-input` error is an oracle for which terminals exist), so the
 * user would get a key that does nothing and no prompt explaining why.
 *
 * So the injector registered here is `Terminal.input(data, true)`: xterm's own
 * "treat this as if the user typed it" entry point, which fires `onData` exactly
 * as a keypress does. Read-only refusal, step-up, and the write path are then
 * shared by construction rather than by two code paths agreeing to match.
 *
 * A module-level registry (rather than a ref handed down) because the injector's
 * lifetime is the xterm MOUNT effect's — one per live tab, keyed by pty id — and
 * the key row only ever knows the ACTIVE tab's id, not which of the mounted
 * instances holds it.
 */

type TerminalInput = (data: string) => void

const injectors = new Map<string, TerminalInput>()

/**
 * Register this terminal's injector for as long as its xterm instance lives.
 * Returns the unregister, which is idempotent and only ever clears its OWN
 * entry: React can mount the replacement before running the old cleanup (strict
 * mode, a fast tab reshuffle), and a blind `delete` there would unregister the
 * live instance.
 */
export function registerTerminalInput(terminalId: string, inject: TerminalInput): () => void {
  injectors.set(terminalId, inject)
  return () => {
    if (injectors.get(terminalId) === inject) injectors.delete(terminalId)
  }
}

/**
 * Type `data` into `terminalId` as if it came from the keyboard.
 *
 * Returns false when there is nothing to type into — no active tab, or an
 * instance still loading (xterm is lazy-chunked). Callers treat that as a no-op,
 * never as an error: pressing Esc before the terminal has mounted is not a
 * failure worth telling anyone about.
 */
export function sendTerminalInput(terminalId: string | null | undefined, data: string): boolean {
  if (!terminalId) return false
  const inject = injectors.get(terminalId)
  if (!inject) return false
  inject(data)
  return true
}
