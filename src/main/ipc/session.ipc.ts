import { ipcMain, dialog, BrowserWindow } from 'electron'
import { ClaudeSession } from '../services/claude-session'
import type { ApprovalDecision } from '../../shared/types'

let session: ClaudeSession | null = null

export function registerSessionIpc(win: BrowserWindow): void {
  ipcMain.handle('session:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('session:create', (_event, cwd: string) => {
    // Clean up old session before creating a new one
    session?.cancel()
    session = new ClaudeSession(win, cwd)
  })

  ipcMain.handle('session:send', (_event, prompt: string) => {
    if (!session) throw new Error('No session')
    // Fire and forget — results stream back via webContents.send
    session.run(prompt)
  })

  ipcMain.handle('session:cancel', () => {
    session?.cancel()
  })

  ipcMain.handle(
    'session:approval-response',
    (_event, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) => {
      session?.resolveApproval(requestId, decision, answers)
    }
  )

  ipcMain.handle('session:watch-background', (_e, toolUseId: string) => {
    session?.watchBackground(toolUseId)
  })

  ipcMain.handle('session:unwatch-background', (_e, toolUseId: string) => {
    session?.unwatchBackground(toolUseId)
  })

  ipcMain.handle('session:read-background-range', (_e, toolUseId: string, offset: number, length: number) => {
    return session?.readBackgroundRange(toolUseId, offset, length) ?? ''
  })

}
