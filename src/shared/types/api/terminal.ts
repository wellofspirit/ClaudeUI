import type { IdeAvailability, IdeEntry, IdeThemeKind } from '../../remote-protocol'
import type {
  StepUpIntent,
  TerminalAttachResult,
  TerminalAvailability,
  TerminalStepUpResult
} from '../terminal'

export interface TerminalAPI {
  /**
   * Open terminal `index` of this cwd's POOL (`cwd#0`, `cwd#1`, …) and get its
   * id back. The slot resolves attach-or-spawn in main: if that slot already
   * holds a live pty — one this surface never spawned, e.g. the desktop's
   * terminal 0 seen from a phone — the same id comes back and its history
   * arrives on the next `attachTerminal`. Omitting the index means "next free
   * slot", i.e. always a fresh shell (the pre-pool behavior).
   */
  createTerminal(cwd: string, index?: number): Promise<string>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  killTerminal(id: string): Promise<void>
  killTerminalsByCwd(cwd: string): Promise<string[]>
  /**
   * PTY bytes. `replay: true` marks a scrollback replay delivered on attach: it
   * is the terminal's whole history, so the receiver must CLEAR and write it
   * rather than append (the desktop lane is a broadcast, so some of those bytes
   * may already have been rendered). The clear has to be IN BAND — write
   * `ESC c` (RIS) immediately ahead of the data, not `Terminal.reset()`, whose
   * synchronous execution would race the deferred write queue and leave the
   * replay drawn after a no-op clear. Live chunks always follow a replay, never
   * interleave with it.
   */
  onTerminalData(
    cb: (data: { terminalId: string; data: string; replay?: boolean }) => void
  ): () => void
  onTerminalExit(cb: (data: { terminalId: string; code: number }) => void): () => void
  /**
   * Another surface resized the shared pty (ADR-060).
   *
   * Server → client output, like the bytes themselves: it carries no authority
   * and is gated by nothing beyond already being attached. A surface that
   * MIRRORS the pty's width (the mobile fork) adopts `cols` from this; a
   * fit-driven surface (the desktop panel) ignores the event entirely, which is
   * what keeps the two from resizing each other in a loop.
   */
  onTerminalResized(
    cb: (data: { terminalId: string; cols: number; rows: number }) => void
  ): () => void
  /**
   * May this client open a terminal, and does it need a step-up first?
   * (SyncCore phase 2.) Desktop answers a constant; the web client gates its
   * whole terminal affordance on it.
   */
  terminalAvailability(): Promise<TerminalAvailability>
  /**
   * May this client open VS Code on the host, and why not (ADR-064)?
   *
   * Unlike {@link ClaudeAPI.terminalAvailability} the desktop answers this for
   * real rather than with a constant: whether a usable VS Code CLI exists is a
   * fact about the machine, not about the transport, and the desktop settings
   * pane is the surface that renders the typed probe result.
   */
  ideAvailability(): Promise<IdeAvailability>
  /**
   * Mint a single-use IDE entry URL for `folder`, RELATIVE to this origin.
   *
   * Relative because the caller navigates its own page's origin with it — the
   * host never has to guess what that origin is, and the cookie the entry sets is
   * scoped to `/vscode` on it. Throws {@link IDE_UNAVAILABLE_ERROR} with a typed
   * reason suffix when the toggle, the origin, the CLI or the spawn refuses.
   *
   * `themeKind` is the client's own colour scheme, carried so the workbench
   * opens matching it rather than in whatever the host profile last stored
   * (ADR-064 polish). Purely cosmetic: omitted or unrecognized simply leaves the
   * workbench alone, and it never affects whether an entry is handed out.
   */
  ideMintEntry(folder: string, themeKind?: IdeThemeKind): Promise<IdeEntry>
  /**
   * Which slots of `cwd`'s terminal POOL currently hold a LIVE pty.
   *
   * Terminals are an ordered per-cwd pool shared by every surface, and closing
   * a tab only DETACHES this surface — so "open terminal N" may resolve to a
   * shell that is still running from an earlier tab (or from a phone). Nothing
   * else on the wire tells a client that: `terminal:create` answers with a bare
   * id whether it spawned or attached, and `terminal:availability` is cwd-less.
   * This is the query the open/reopen affordance badges "running" from.
   *
   * Declares the `shell` capability like every other terminal verb, so it runs
   * the same three gates (toggle, grant, decay) — a refusal must read as "no
   * information", never as "no shells here".
   */
  terminalPool(cwd: string): Promise<number[]>
  /**
   * Replace this connection's volatile-stream subscription set (phase 5 S1).
   *
   * REPLACE, never additive — the client sends the set it wants. The host
   * answers by pushing the coalesced value of every non-empty stream of those
   * sessions as `offset: 0` frames, which is what makes re-sending the same set
   * the cure for a mid-connection offset mismatch. Bounded server-side
   * (`MAX_STREAM_WATCH`); an over-long set is refused rather than clipped.
   *
   * `automationIds` is the lane's second scope (phase 5 S2) — what
   * `automation:stream-event` is filtered by. Replaced independently, so omitting
   * it leaves the automation set alone; pass `[]` to stop watching automations.
   * Automation-level, not run-level: the emission carries no run id.
   */
  watchStreams(sessionIds: string[], automationIds?: string[]): Promise<void>
  /**
   * Run the step-up ceremony with the operator's remote-access password.
   * Desktop resolves `{ok:true}` without a ceremony — there is nothing to step
   * up to when you are already at the machine.
   *
   * `intent: 'settings'` additionally opens the settings-editing session
   * (ADR-054 §6 amendment); the deadline comes back on
   * `settingsSessionExpiresAt`. The two members keep their terminal-flavoured
   * NAMES from ADR-052, when the terminal was the only thing a step-up could
   * buy — a rename would touch the preload, the adapter, the harness API and
   * every mock, for no behavioral gain. The doc comments carry the truth: this
   * is THE ceremony surface.
   */
  terminalStepUp(password: string, intent?: StepUpIntent): Promise<TerminalStepUpResult>
  /**
   * Run the step-up ceremony with a PASSKEY (ADR-052 decision 5: step-up is
   * passkey-first, password only as fallback). Fetches a fresh `step-up`-kind
   * challenge, signs it, and sends the assertion — no password ever leaves the
   * device. Desktop resolves `{ok:true}` for the same reason
   * {@link TerminalAPI.terminalStepUp} does.
   *
   * Refusals arrive as a resolved `{ok:false, code}`, not a throw: `code` is
   * what tells the prompt whether to offer the password instead
   * (`passkey-unavailable`) or to keep insisting on the passkey
   * (`passkey-required` from the password path).
   */
  terminalStepUpPasskey(intent?: StepUpIntent): Promise<TerminalStepUpResult>
  /**
   * Subscribe this client to a live PTY (server-side scrollback replays first).
   * Real on BOTH surfaces since the terminal pool landed: a desktop tab can
   * resolve to a pty it did not spawn, and the replay is how it renders that
   * terminal's history.
   *
   * Resolves with the pty's GEOMETRY (ADR-060) so a mirroring surface can adopt
   * the shared shell's width in the same step it attaches. `{ ok: false }` means
   * the terminal is gone (a stale tab).
   *
   * The bare `boolean` in the union is VERSION SKEW, not a second shape this
   * build produces: an older host answers `true`/`false`, and a client that
   * cannot read a geometry off the reply must fall back to fitting both axes
   * (which is exactly what it did before this existed).
   */
  attachTerminal(id: string): Promise<TerminalAttachResult | boolean>
  detachTerminal(id: string): Promise<void>
  /**
   * The server dropped this client's attachment (toggle turned off, grant
   * decayed, or the socket fell too far behind). Never fires on desktop.
   */
  onTerminalDetached(cb: (data: { terminalId: string; reason: string }) => void): () => void
}
