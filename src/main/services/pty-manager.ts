import * as os from 'os'
import * as fs from 'fs'
import { v4 as uuid } from 'uuid'
import { logger } from './logger'

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
  /** True while the pty is paused for flow control. */
  paused: boolean
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

export class PtyManager {
  private ptys = new Map<string, PtyEntryInternal>()

  create(cwd: string, onData: DataCallback, onExit: ExitCallback): string {
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
      paused: false
    }

    const flush = (): void => {
      entry.flushTimer = null
      if (entry.pending.length === 0) return
      const data = entry.pending.join('')
      entry.pending.length = 0
      entry.pendingBytes = 0
      onData(id, data)
      // The main-side buffer is now drained — lift flow control so the child
      // can produce more.
      if (entry.paused) {
        entry.paused = false
        try {
          entry.pty.resume?.()
        } catch (err) {
          logger.warn('PtyManager', 'resume() failed', { id, err })
        }
      }
    }

    pty.onData((data: string) => {
      entry.pending.push(data)
      entry.pendingBytes += Buffer.byteLength(data, 'utf8')
      // Flow control: if the child floods faster than we hand chunks to the
      // renderer, pause the pty so its stdout write() blocks instead of letting
      // our unsent buffer + the renderer heap grow without bound.
      if (!entry.paused && entry.pendingBytes >= PTY_HIGH_WATER_BYTES) {
        entry.paused = true
        try {
          entry.pty.pause?.()
        } catch (err) {
          logger.warn('PtyManager', 'pause() failed', { id, err })
        }
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
        onData(id, data)
      }
      this.ptys.delete(id)
      onExit(id, e.exitCode)
    })

    this.ptys.set(id, entry)
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
    try {
      entry.pty.kill()
    } catch (err) {
      logger.warn('PtyManager', 'PTY may already be dead', { id, err })
    }
    this.ptys.delete(id)
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
}
