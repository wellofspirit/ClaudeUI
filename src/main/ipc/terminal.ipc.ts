import { ipcMain } from 'electron'
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
  'terminal:availability',
  'terminal:attach',
  'terminal:detach'
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

/**
 * Register the terminal channels. Window-free since SyncCore phase 4d: the pty
 * manager is process-lifetime, so the registration is too, and the two
 * window-LIFETIME concerns it used to own — where `terminal:data`/`terminal:exit`
 * are delivered (`terminalService.setWindow`) and killing the shells when the
 * window closes — moved to `createWindow()`. A windowless boot therefore still
 * serves `terminal:*` to remote clients (phase 2 multi-attach) with no local sink.
 */
export function registerTerminalIpc(): void {
  for (const channel of TERMINAL_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  // `index` is the pool slot (`cwd#0`, `cwd#1`, …). Omitted ⇒ next free slot,
  // which is what a caller that predates the pool always got: a fresh pty.
  handleIpc({
    channel: 'terminal:create',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, cwd: string, index?: number) =>
      terminalService.create(connection, cwd, index)
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

  // Attach/detach exist on the DESKTOP transport too as of the terminal-pool
  // work. They used to be remote-only (and stubbed as local no-ops in the
  // preload) because desktop output has always been broadcast on `terminal:data`
  // — but a desktop tab can now resolve to a pty someone else spawned, and
  // without an attach it would render a blank screen instead of the history the
  // scrollback ring already holds. Same `command`-kind declaration as the remote
  // side, so the lifecycle is audited identically on both surfaces.
  handleIpc({
    channel: 'terminal:attach',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, id: string) => terminalService.attach(connection, id)
  })

  handleIpc({
    channel: 'terminal:detach',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: (connection: CommandConnection, id: string) => {
      terminalService.detach(connection, id)
    }
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
}
