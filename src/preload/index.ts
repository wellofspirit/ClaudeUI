import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalDecision, ClaudeAPI } from '../shared/types'

const api: ClaudeAPI = {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('session:pick-folder'),
  createSession: (cwd: string, effort?: string) => ipcRenderer.invoke('session:create', cwd, effort),
  sendPrompt: (prompt: string) => ipcRenderer.invoke('session:send', prompt),
  cancelSession: () => ipcRenderer.invoke('session:cancel'),
  respondApproval: (requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) =>
    ipcRenderer.invoke('session:approval-response', requestId, decision, answers),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

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
  },
  onTaskProgress: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:task-progress', handler)
    return () => ipcRenderer.removeListener('session:task-progress', handler)
  },
  onMaximizeChange: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, isMaximized: boolean): void => cb(isMaximized)
    ipcRenderer.on('window:maximized-change', handler)
    return () => ipcRenderer.removeListener('window:maximized-change', handler)
  },
  onTaskNotification: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:task-notification', handler)
    return () => ipcRenderer.removeListener('session:task-notification', handler)
  },
  onSubagentStream: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:subagent-stream', handler)
    return () => ipcRenderer.removeListener('session:subagent-stream', handler)
  },
  onSubagentMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:subagent-message', handler)
    return () => ipcRenderer.removeListener('session:subagent-message', handler)
  },
  onSubagentToolResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:subagent-tool-result', handler)
    return () => ipcRenderer.removeListener('session:subagent-tool-result', handler)
  },
  onPermissionMode: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, mode: unknown): void => cb(mode as never)
    ipcRenderer.on('session:permission-mode', handler)
    return () => ipcRenderer.removeListener('session:permission-mode', handler)
  },
  onBackgroundOutput: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown): void => cb(data as never)
    ipcRenderer.on('session:background-output', handler)
    return () => ipcRenderer.removeListener('session:background-output', handler)
  },
  watchBackground: (toolUseId: string) => ipcRenderer.invoke('session:watch-background', toolUseId),
  unwatchBackground: (toolUseId: string) => ipcRenderer.invoke('session:unwatch-background', toolUseId),
  readBackgroundRange: (toolUseId: string, offset: number, length: number) =>
    ipcRenderer.invoke('session:read-background-range', toolUseId, offset, length),
  stopTask: (toolUseId: string) => ipcRenderer.invoke('session:stop-task', toolUseId),
  setPermissionMode: (mode: string) => ipcRenderer.invoke('session:set-permission-mode', mode),
  setModel: (model: string) => ipcRenderer.invoke('session:set-model', model),
  setEffort: (effort: string) => ipcRenderer.invoke('session:set-effort', effort),
  getModels: () => ipcRenderer.invoke('session:get-models'),
  getPlanContent: () => ipcRenderer.invoke('session:get-plan-content'),
  getSessionLogPath: () => ipcRenderer.invoke('session:get-session-log-path')
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error global augmentation
  window.api = api
}
