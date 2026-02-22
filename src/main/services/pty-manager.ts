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
  onData: (callback: (data: string) => void) => { dispose(): void }
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void }
}

export interface PtyEntry {
  id: string
  pty: IPty
  cwd: string
}

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

export class PtyManager {
  private ptys = new Map<string, PtyEntry>()

  create(cwd: string, onData: DataCallback, onExit: ExitCallback): string {
    const id = uuid()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require('node-pty')
    const shell =
      os.platform() === 'win32'
        ? resolveWindowsShell()
        : process.env.SHELL || '/bin/bash'

    const args: string[] = []
    const pty: IPty = nodePty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env }
    })

    pty.onData((data: string) => onData(id, data))
    pty.onExit((e: { exitCode: number }) => {
      this.ptys.delete(id)
      onExit(id, e.exitCode)
    })

    this.ptys.set(id, { id, pty, cwd })
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
    try {
      entry.pty.kill()
    } catch (err) {
      logger.warn('PtyManager', 'PTY may already be dead', { id, err })
    }
    this.ptys.delete(id)
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
