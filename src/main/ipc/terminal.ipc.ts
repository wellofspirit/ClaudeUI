import { ipcMain, BrowserWindow } from 'electron'
import { terminalService } from '../services/terminal-service'
import {
  commandRegistry,
  desktopConnection,
  registerCommand,
  type CommandConnection,
  type CommandRegistration
} from './command-registry'

const TERMINAL_IPC_CHANNELS = [
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'terminal:kill-by-cwd',
  'terminal:availability'
]

/**
 * Desktop-transport registration, mirroring session.ipc.ts's `handleIpc`: the
 * handler lives in the shared command registry (SyncCore phase 1) and the
 * `ipcMain.handle` wrapper only routes through `dispatch`, so capability
 * enforcement and audit are the same code the remote transport runs.
 */
function handleIpc(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'desktop' })
  ipcMain.handle(reg.channel, (_event, ...args: unknown[]) =>
    commandRegistry.dispatch(reg.channel, 'desktop', args, desktopConnection())
  )
}

export function registerTerminalIpc(win: BrowserWindow): void {
  for (const channel of TERMINAL_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  // ONE pty manager per app run, shared with the remote transport (phase 2
  // multi-attach). The window is where `terminal:data` / `terminal:exit` go —
  // the desktop transport is byte-identical to what it was before the port.
  terminalService.setWindow(win)

  handleIpc({
    channel: 'terminal:create',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, cwd: string) => terminalService.create(connection, cwd)
  })

  handleIpc({
    channel: 'terminal:write',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, id: string, data: string) => {
      terminalService.write(connection, id, data)
    }
  })

  handleIpc({
    channel: 'terminal:resize',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, id: string, cols: number, rows: number) => {
      terminalService.resize(connection, id, cols, rows)
    }
  })

  handleIpc({
    channel: 'terminal:kill',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, id: string) => {
      terminalService.kill(connection, id)
    }
  })

  handleIpc({
    channel: 'terminal:kill-by-cwd',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, cwd: string) =>
      terminalService.killByCwd(connection, cwd)
  })

  // Same channel the web client gates its terminal affordance on. On desktop it
  // is a constant (`allowed/granted: true`) — the remote toggle arms the `shell`
  // capability for REMOTE connections and never takes the local shell away.
  handleIpc({
    channel: 'terminal:availability',
    capability: 'config',
    kind: 'query',
    withConnection: true,
    handler: (connection: CommandConnection) => terminalService.availability(connection)
  })

  win.on('closed', () => {
    terminalService.killAll()
  })
}
