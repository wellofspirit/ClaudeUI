import * as os from 'os'
import * as fs from 'fs'
import { v4 as uuid } from 'uuid'
import { logger } from './logger'
import type { TermDetachReason } from '../../shared/remote-protocol'

/** On Windows, prefer pwsh (PowerShell 7+) over cmd.exe. */
function resolveWindowsShell(): string {
  // Check common pwsh locations
  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  // Also check if pwsh is on PATH
  const pathDirs = (process.env.PATH || '').split(';')
  for (const dir of pathDirs) {
    const full = `${dir}\\pwsh.exe`
    try {
      if (fs.existsSync(full)) return full
    } catch (err) {
      logger.warn('PtyManager', 'Skipping invalid PATH entry', { path: full, err })
    }
  }
  return process.env.COMSPEC || 'cmd.exe'
}

interface IPty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** Pause reading the pty master fd (node-pty flow control). */
  pause?: () => void
  /** Resume reading after a pause(). */
  resume?: () => void
  onData: (callback: (data: string) => void) => { dispose(): void }
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void }
}

export interface PtyEntry {
  id: string
  pty: IPty
  cwd: string
}

/**
 * The per-cwd terminal POOL key.
 *
 * Terminals are an ordered pool per working directory (`cwd#0`, `cwd#1`, …), so
 * "open terminal N for this cwd" resolves to the SAME pty from every surface.
 * Both surfaces derive `cwd` from the same replicated session record, so the
 * strings normally match verbatim; the normalization here only removes the
 * accidental ways one string can differ from another naming the same directory
 * (separator flavour, a trailing slash, and — on Windows only — case).
 *
 * Deliberately NOT applied to {@link PtyManager.killByCwd}, whose exact-match
 * semantics are load-bearing for the cold-session sweep and unchanged here.
 */
function poolKeyFor(cwd: string): string {
  let key = cwd.replace(/\\/g, '/')
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  return os.platform() === 'win32' ? key.toLowerCase() : key
}

/** What {@link PtyManager.open} resolved to. */
export interface PtyOpenResult {
  id: string
  /** The pool slot this terminal occupies for its cwd. */
  index: number
  /** True when a pty was spawned; false when a live one was resolved. */
  created: boolean
}

/**
 * How the remote transport receives PTY frames for the connections attached to
 * a terminal (SyncCore phase 2). Injected — the pty manager knows nothing about
 * WebSockets, and with no sink installed it behaves exactly as it did before
 * multi-attach existed.
 */
export interface PtyRemoteSink {
  /** Deliver a chunk (or a scrollback replay) to one attached connection. */
  data(connectionId: string, termId: string, data: string): void
  /** The PTY exited. */
  exit(connectionId: string, termId: string, exitCode: number): void
  /** This connection is no longer attached (policy flip, backpressure, decay). */
  detached(connectionId: string, termId: string, reason: TermDetachReason): void
  /**
   * Bytes queued on that connection's socket, or `null` when the connection is
   * gone. Drives the remote backpressure decision.
   */
  bufferedAmount(connectionId: string): number | null
}

/**
 * Internal per-terminal state for output coalescing + flow control (audit
 * M-PT1). Without this, every node-pty chunk was `webContents.send`'d
 * immediately, so `cat huge.log` produced an IPC storm (thousands of tiny
 * messages) and let the renderer's xterm write buffer grow unbounded.
 */
interface PtyEntryInternal extends PtyEntry {
  /** Chunks received since the last flush, joined + sent as one IPC message. */
  pending: string[]
  /** Byte size of `pending` — drives the pause() high-water decision. */
  pendingBytes: number
  /** The single scheduled flush, or null when idle. */
  flushTimer: ReturnType<typeof setTimeout> | null
  /** True while the pty is paused because OUR send buffer is full. */
  pausedForFlush: boolean
  /** True while the pty is paused because an attached SOCKET is behind. */
  pausedForRemote: boolean
  /** True while `pty.pause()` is in effect (either reason). */
  paused: boolean
  /** Poll timer that lifts {@link pausedForRemote} once sockets drain. */
  drainTimer: ReturnType<typeof setInterval> | null
  /** Remote connection ids currently attached to this terminal. */
  attachments: Set<string>
  /** Server-side scrollback ring (see {@link SCROLLBACK_MAX_BYTES}). */
  scrollback: string[]
  scrollbackBytes: number
  /** Normalized cwd this terminal is pooled under ({@link poolKeyFor}). */
  poolKey: string
  /** This terminal's slot in that pool. */
  index: number
}

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

/**
 * Coalesce pty output for this long so a burst becomes ONE IPC message instead
 * of thousands. 8 ms keeps interactive keystroke echo well under a frame.
 */
const PTY_FLUSH_INTERVAL_MS = 8
/**
 * Pause the pty (OS backpressure onto the child) once this many unsent bytes
 * accumulate between flushes. Bounds the main-process buffer and the rate the
 * renderer is fed, so a flood can't grow memory without bound.
 */
const PTY_HIGH_WATER_BYTES = 1024 * 1024

/**
 * Server-side scrollback ring per terminal (~200 KB, sync-core.md §Terminal).
 * It is what makes a LATE attach render history instead of a blank screen, and
 * it is fed for desktop-only terminals too — one code path, so a terminal
 * spawned before any remote client connected is still replayable.
 */
const SCROLLBACK_MAX_BYTES = 200 * 1024

/**
 * Remote backpressure (P4). A socket queueing more than this is not keeping up.
 * We pause the PTY (OS backpressure onto the child) rather than buffering in
 * the main process, and resume once every attached socket is under
 * {@link REMOTE_BACKPRESSURE_RESUME_BYTES}.
 *
 * When the pty implementation has no `pause()` we cannot apply backpressure at
 * all, so the slow socket's ATTACHMENT is dropped (with a `term-detached`
 * notice) instead of letting an unbounded queue grow — see
 * {@link PtyManager.evaluateRemoteBackpressure}. node-pty does implement
 * pause/resume, so the drop path is the fallback, not the normal case.
 */
const REMOTE_BACKPRESSURE_HIGH_WATER_BYTES = 1024 * 1024
const REMOTE_BACKPRESSURE_RESUME_BYTES = REMOTE_BACKPRESSURE_HIGH_WATER_BYTES / 2
const REMOTE_DRAIN_POLL_MS = 50

export class PtyManager {
  private ptys = new Map<string, PtyEntryInternal>()
  private remoteSink: PtyRemoteSink | null = null
  /**
   * poolKey → ordered slots. A slot holds the id of the terminal occupying it,
   * or `null` for a slot whose terminal has died (which is what makes "open
   * terminal 1" spawn a fresh shell after the old one exited). Trailing nulls
   * are trimmed so `pool.length` is always "one past the last live slot".
   */
  private pools = new Map<string, Array<string | null>>()

  /**
   * Install (or clear) the remote delivery sink. Without one, `attach()` is
   * refused and the manager behaves exactly as the desktop-only version did.
   */
  setRemoteSink(sink: PtyRemoteSink | null): void {
    this.remoteSink = sink
  }

  /**
   * Resolve terminal `index` of `cwd`'s pool: attach to the live pty in that
   * slot, or spawn one there.
   *
   * `index === null` (or absent) means "the next free slot", which always
   * spawns — that is the backward-compatible path for a caller that cannot
   * express an index (an older remote bundle), and it reproduces the
   * pre-pool behavior of `create()` exactly: every call gets SOME terminal.
   */
  open(
    cwd: string,
    index: number | null,
    onData: DataCallback,
    onExit: ExitCallback
  ): PtyOpenResult {
    const poolKey = poolKeyFor(cwd)
    const pool = this.pools.get(poolKey) ?? []
    if (index !== null && index !== undefined) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`A terminal index must be a non-negative integer (got ${String(index)})`)
      }
      const existing = pool[index]
      // Attach-to-existing: the caller gets the id of a pty it did not spawn,
      // and reads its history from the scrollback ring like any late attach.
      if (existing && this.ptys.has(existing)) return { id: existing, index, created: false }
    }
    const slot = index ?? this.nextFreeSlot(pool)
    return { id: this.spawn(cwd, poolKey, slot, onData, onExit), index: slot, created: true }
  }

  create(cwd: string, onData: DataCallback, onExit: ExitCallback): string {
    return this.open(cwd, null, onData, onExit).id
  }

  private spawn(
    cwd: string,
    poolKey: string,
    index: number,
    onData: DataCallback,
    onExit: ExitCallback
  ): string {
    const id = uuid()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require('node-pty')
    const shell =
      os.platform() === 'win32' ? resolveWindowsShell() : process.env.SHELL || '/bin/bash'

    const args: string[] = []
    const pty: IPty = nodePty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env }
    })

    const entry: PtyEntryInternal = {
      id,
      pty,
      cwd,
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      pausedForFlush: false,
      pausedForRemote: false,
      paused: false,
      drainTimer: null,
      attachments: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
      poolKey,
      index
    }

    const flush = (): void => {
      entry.flushTimer = null
      if (entry.pending.length === 0) return
      const data = entry.pending.join('')
      entry.pending.length = 0
      entry.pendingBytes = 0
      // ONE delivery point for every consumer: the desktop renderer (unchanged
      // transport), the scrollback ring, and every attached remote socket.
      this.pushScrollback(entry, data)
      onData(id, data)
      this.fanOutToAttached(entry, data)
      // The main-side buffer is now drained — lift flow control so the child
      // can produce more.
      if (entry.pausedForFlush) {
        entry.pausedForFlush = false
        this.applyPauseState(entry)
      }
    }

    pty.onData((data: string) => {
      entry.pending.push(data)
      entry.pendingBytes += Buffer.byteLength(data, 'utf8')
      // Flow control: if the child floods faster than we hand chunks to the
      // renderer, pause the pty so its stdout write() blocks instead of letting
      // our unsent buffer + the renderer heap grow without bound.
      if (!entry.pausedForFlush && entry.pendingBytes >= PTY_HIGH_WATER_BYTES) {
        entry.pausedForFlush = true
        this.applyPauseState(entry)
      }
      if (!entry.flushTimer) entry.flushTimer = setTimeout(flush, PTY_FLUSH_INTERVAL_MS)
    })

    pty.onExit((e: { exitCode: number }) => {
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer)
        entry.flushTimer = null
      }
      // Deliver any buffered tail before signalling exit so no output is lost.
      if (entry.pending.length > 0) {
        const data = entry.pending.join('')
        entry.pending.length = 0
        entry.pendingBytes = 0
        this.pushScrollback(entry, data)
        onData(id, data)
        this.fanOutToAttached(entry, data)
      }
      this.clearDrainTimer(entry)
      // Attached remote clients learn about the exit here — the desktop learns
      // through its own `onExit` callback below, exactly as before.
      for (const connectionId of entry.attachments) {
        this.remoteSink?.exit(connectionId, id, e.exitCode)
      }
      entry.attachments.clear()
      this.ptys.delete(id)
      // A dead terminal releases its pool slot, so the next "open terminal N"
      // for this cwd spawns a fresh shell there instead of resolving a corpse.
      this.freeSlot(entry)
      onExit(id, e.exitCode)
    })

    this.ptys.set(id, entry)
    this.claimSlot(poolKey, index, id)
    return id
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.pty.resize(cols, rows)
  }

  kill(id: string): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    // Cancel the pending flush and drop its buffer — an explicit kill discards
    // any not-yet-sent tail (the terminal is being torn down). A NATURAL exit
    // still delivers the tail via the onExit handler.
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    entry.pending.length = 0
    entry.pendingBytes = 0
    this.clearDrainTimer(entry)
    try {
      entry.pty.kill()
    } catch (err) {
      logger.warn('PtyManager', 'PTY may already be dead', { id, err })
    }
    // The entry leaves the map now, but its `attachments` set stays intact: the
    // pty's own onExit (which node-pty raises after kill) is the ONE place that
    // notifies attached sockets, so a killed terminal and a naturally-exited one
    // look identical on the wire.
    this.ptys.delete(id)
    this.freeSlot(entry)
  }

  /** Kill all PTYs spawned with a given cwd. Returns the killed terminal IDs. */
  killByCwd(cwd: string): string[] {
    const killed: string[] = []
    for (const [id, entry] of this.ptys) {
      if (entry.cwd === cwd) {
        this.kill(id)
        killed.push(id)
      }
    }
    return killed
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) {
      this.kill(id)
    }
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /** The cwd a terminal was spawned in, or undefined when it is gone. */
  cwdOf(id: string): string | undefined {
    return this.ptys.get(id)?.cwd
  }

  // ---------------------------------------------------------------------------
  // The per-cwd pool
  // ---------------------------------------------------------------------------

  /** The live terminal in slot `index` of `cwd`'s pool, if any. */
  terminalAt(cwd: string, index: number): string | undefined {
    const id = this.pools.get(poolKeyFor(cwd))?.[index]
    return id && this.ptys.has(id) ? id : undefined
  }

  /** Which slot a terminal occupies, or undefined when it is gone. */
  indexOf(id: string): number | undefined {
    return this.ptys.get(id)?.index
  }

  /** Live terminals of one cwd, by slot. Inspection seam (and future listing). */
  poolOf(cwd: string): Array<{ index: number; id: string }> {
    const pool = this.pools.get(poolKeyFor(cwd)) ?? []
    const out: Array<{ index: number; id: string }> = []
    pool.forEach((id, index) => {
      if (id && this.ptys.has(id)) out.push({ index, id })
    })
    return out
  }

  /**
   * The scrollback ring as one string — what an attaching surface replays.
   *
   * The remote path gets this pushed through the sink inside {@link attach};
   * the desktop path PULLS it, because its bytes ride a broadcast IPC channel
   * that predates attachment and has no per-connection addressing.
   */
  scrollbackOf(id: string): string {
    const entry = this.ptys.get(id)
    return entry ? entry.scrollback.join('') : ''
  }

  /** First slot with no live terminal (a hole, or one past the end). */
  private nextFreeSlot(pool: ReadonlyArray<string | null>): number {
    for (let i = 0; i < pool.length; i++) {
      const id = pool[i]
      if (!id || !this.ptys.has(id)) return i
    }
    return pool.length
  }

  private claimSlot(poolKey: string, index: number, id: string): void {
    const pool = this.pools.get(poolKey) ?? []
    while (pool.length < index) pool.push(null)
    pool[index] = id
    this.pools.set(poolKey, pool)
  }

  /**
   * Release a slot — idempotent, and guarded on identity so a kill's late
   * `onExit` can never evict the terminal that has since taken the slot.
   */
  private freeSlot(entry: PtyEntryInternal): void {
    const pool = this.pools.get(entry.poolKey)
    if (!pool) return
    if (pool[entry.index] !== entry.id) return
    pool[entry.index] = null
    while (pool.length > 0 && pool[pool.length - 1] === null) pool.pop()
    if (pool.length === 0) this.pools.delete(entry.poolKey)
  }

  // ---------------------------------------------------------------------------
  // Multi-attach (SyncCore phase 2)
  // ---------------------------------------------------------------------------

  /** Is `connectionId` currently attached to `id`? Gate for term-input frames. */
  isAttached(id: string, connectionId: string): boolean {
    return this.ptys.get(id)?.attachments.has(connectionId) === true
  }

  /**
   * Attach a remote connection and replay the scrollback ring to it.
   *
   * Ordering is PINNED: the snapshot is taken, the attachment registered, and
   * the replay handed to the sink in ONE synchronous step, so no live chunk can
   * interleave ahead of the history it belongs after (pty data arrives from the
   * event loop, never mid-statement).
   *
   * Returns false when the terminal does not exist or no sink is installed.
   */
  attach(id: string, connectionId: string): boolean {
    const entry = this.ptys.get(id)
    if (!entry || !this.remoteSink) return false
    if (entry.attachments.has(connectionId)) return true
    const replay = entry.scrollback.join('')
    entry.attachments.add(connectionId)
    if (replay.length > 0) this.remoteSink.data(connectionId, id, replay)
    return true
  }

  /** Detach one connection from one terminal. */
  detach(id: string, connectionId: string): void {
    this.ptys.get(id)?.attachments.delete(connectionId)
  }

  /**
   * Detach a connection from EVERY terminal — socket close, decayed grant, or
   * the desktop toggle going OFF. `reason` (when given) is pushed to the client
   * so its UI can explain the drop instead of silently freezing.
   */
  detachAll(connectionId: string, reason?: TermDetachReason): void {
    for (const [id, entry] of this.ptys) {
      if (!entry.attachments.delete(connectionId)) continue
      if (reason) this.remoteSink?.detached(connectionId, id, reason)
    }
  }

  /** Terminal ids `connectionId` is attached to (test/inspection seam). */
  attachedTerminals(connectionId: string): string[] {
    return [...this.ptys]
      .filter(([, entry]) => entry.attachments.has(connectionId))
      .map(([id]) => id)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Append to the ring, evicting the oldest chunks past the cap. A single chunk
   * larger than the whole ring is truncated to its TAIL (the newest bytes are
   * the ones a late attach needs).
   */
  private pushScrollback(entry: PtyEntryInternal, data: string): void {
    if (data.length === 0) return
    let chunk = data
    let bytes = Buffer.byteLength(chunk, 'utf8')
    if (bytes > SCROLLBACK_MAX_BYTES) {
      const buf = Buffer.from(chunk, 'utf8')
      chunk = buf.subarray(buf.length - SCROLLBACK_MAX_BYTES).toString('utf8')
      bytes = Buffer.byteLength(chunk, 'utf8')
      entry.scrollback.length = 0
      entry.scrollbackBytes = 0
    }
    entry.scrollback.push(chunk)
    entry.scrollbackBytes += bytes
    while (entry.scrollbackBytes > SCROLLBACK_MAX_BYTES && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift()!
      entry.scrollbackBytes -= Buffer.byteLength(dropped, 'utf8')
    }
  }

  /** Deliver one flushed chunk to every attached socket, then re-check pressure. */
  private fanOutToAttached(entry: PtyEntryInternal, data: string): void {
    const sink = this.remoteSink
    if (!sink || entry.attachments.size === 0) return
    for (const connectionId of entry.attachments) {
      sink.data(connectionId, entry.id, data)
    }
    this.evaluateRemoteBackpressure(entry)
  }

  /**
   * Pause the pty while any attached socket is behind; drop the attachment
   * instead when this pty cannot be paused (see
   * {@link REMOTE_BACKPRESSURE_HIGH_WATER_BYTES}).
   */
  private evaluateRemoteBackpressure(entry: PtyEntryInternal): void {
    const sink = this.remoteSink
    if (!sink) return
    const canPause = typeof entry.pty.pause === 'function'
    let anyBehind = false
    for (const connectionId of [...entry.attachments]) {
      const buffered = sink.bufferedAmount(connectionId)
      if (buffered === null) {
        // The socket is gone; the close handler will detach too, but do not keep
        // measuring a corpse in the meantime.
        entry.attachments.delete(connectionId)
        continue
      }
      if (buffered < REMOTE_BACKPRESSURE_HIGH_WATER_BYTES) continue
      if (canPause) {
        anyBehind = true
        continue
      }
      // No flow control available: buffering without bound is the one outcome
      // we refuse, so the slow attachment is dropped with a notice.
      entry.attachments.delete(connectionId)
      sink.detached(connectionId, entry.id, 'backpressure')
      logger.warn('PtyManager', 'Dropped a slow terminal attachment (no pty flow control)', {
        id: entry.id,
        connectionId
      })
    }
    if (anyBehind && !entry.pausedForRemote) {
      entry.pausedForRemote = true
      this.applyPauseState(entry)
      this.startDrainTimer(entry)
    }
  }

  /** Poll until every attached socket is back under the low-water mark. */
  private startDrainTimer(entry: PtyEntryInternal): void {
    if (entry.drainTimer) return
    entry.drainTimer = setInterval(() => {
      const sink = this.remoteSink
      if (!sink) {
        entry.pausedForRemote = false
        this.clearDrainTimer(entry)
        this.applyPauseState(entry)
        return
      }
      let stillBehind = false
      for (const connectionId of [...entry.attachments]) {
        const buffered = sink.bufferedAmount(connectionId)
        if (buffered === null) {
          entry.attachments.delete(connectionId)
          continue
        }
        if (buffered > REMOTE_BACKPRESSURE_RESUME_BYTES) stillBehind = true
      }
      if (stillBehind) return
      entry.pausedForRemote = false
      this.clearDrainTimer(entry)
      this.applyPauseState(entry)
    }, REMOTE_DRAIN_POLL_MS)
    // Never hold the process open for a drain poll.
    entry.drainTimer.unref?.()
  }

  private clearDrainTimer(entry: PtyEntryInternal): void {
    if (entry.drainTimer) {
      clearInterval(entry.drainTimer)
      entry.drainTimer = null
    }
  }

  /**
   * Reconcile `pty.pause()`/`resume()` with the two independent reasons to
   * stall the child. Paused while EITHER holds; resumed only when both clear —
   * so a remote pause can never cancel the flush-buffer pause or vice versa.
   */
  private applyPauseState(entry: PtyEntryInternal): void {
    const shouldPause = entry.pausedForFlush || entry.pausedForRemote
    if (shouldPause === entry.paused) return
    entry.paused = shouldPause
    try {
      if (shouldPause) entry.pty.pause?.()
      else entry.pty.resume?.()
    } catch (err) {
      logger.warn('PtyManager', `${shouldPause ? 'pause' : 'resume'}() failed`, {
        id: entry.id,
        err
      })
    }
  }
}
