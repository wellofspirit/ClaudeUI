import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalDecision, ClaudeAPI } from '../shared/types'

const api: ClaudeAPI = {
  pickFolder: () => ipcRenderer.invoke('session:pick-folder'),
  createSession: (cwd: string) => ipcRenderer.invoke('session:create', cwd),
  sendPrompt: (prompt: string) => ipcRenderer.invoke('session:send', prompt),
  cancelSession: () => ipcRenderer.invoke('session:cancel'),
  respondApproval: (requestId: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke('session:approval-response', requestId, decision),

  onMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, msg: unknown): void => cb(msg as never)
    ipcRenderer.on('session:message', handler)
    return () => ipcRenderer.removeListener('session:message', handler)
  },
  onStreamEvent: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:stream', handler)
    return () => ipcRenderer.removeListener('session:stream', handler)
  },
  onApprovalRequest: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, approval: unknown): void =>
      cb(approval as never)
    ipcRenderer.on('session:approval-request', handler)
    return () => ipcRenderer.removeListener('session:approval-request', handler)
  },
  onStatus: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, status: unknown): void =>
      cb(status as never)
    ipcRenderer.on('session:status', handler)
    return () => ipcRenderer.removeListener('session:status', handler)
  },
  onResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, result: unknown): void =>
      cb(result as never)
    ipcRenderer.on('session:result', handler)
    return () => ipcRenderer.removeListener('session:result', handler)
  },
  onError: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, error: string): void => cb(error)
    ipcRenderer.on('session:error', handler)
    return () => ipcRenderer.removeListener('session:error', handler)
  },
  onToolResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:tool-result', handler)
    return () => ipcRenderer.removeListener('session:tool-result', handler)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error global augmentation
  window.api = api
}
