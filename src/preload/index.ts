import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalDecision, ClaudeAPI } from '../shared/types'

const api: ClaudeAPI = {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('session:pick-folder'),
  createSession: (routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string) =>
    ipcRenderer.invoke('session:create', routingId, cwd, effort, resumeSessionId, permissionMode),
  sendPrompt: (routingId: string, prompt: string) =>
    ipcRenderer.invoke('session:send', routingId, prompt),
  cancelSession: (routingId: string) =>
    ipcRenderer.invoke('session:cancel', routingId),
  respondApproval: (routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) =>
    ipcRenderer.invoke('session:approval-response', routingId, requestId, decision, answers),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  listDirectories: () => ipcRenderer.invoke('session:list-directories'),
  loadSessionHistory: (sessionId: string, projectKey: string) =>
    ipcRenderer.invoke('session:load-history', sessionId, projectKey),
  loadSubagentHistory: (sessionId: string, projectKey: string, agentId: string) =>
    ipcRenderer.invoke('session:load-subagent-history', sessionId, projectKey, agentId),
  loadBackgroundOutput: (projectKey: string, taskId: string, outputFile?: string) =>
    ipcRenderer.invoke('session:load-background-output', projectKey, taskId, outputFile),

  onMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:message', handler)
    return () => ipcRenderer.removeListener('session:message', handler)
  },
  onStreamEvent: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:stream', handler)
    return () => ipcRenderer.removeListener('session:stream', handler)
  },
  onApprovalRequest: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:approval-request', handler)
    return () => ipcRenderer.removeListener('session:approval-request', handler)
  },
  onStatus: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:status', handler)
    return () => ipcRenderer.removeListener('session:status', handler)
  },
  onResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:result', handler)
    return () => ipcRenderer.removeListener('session:result', handler)
  },
  onError: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:error', handler)
    return () => ipcRenderer.removeListener('session:error', handler)
  },
  onToolResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:tool-result', handler)
    return () => ipcRenderer.removeListener('session:tool-result', handler)
  },
  onTaskProgress: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:task-progress', handler)
    return () => ipcRenderer.removeListener('session:task-progress', handler)
  },
  onMaximizeChange: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, isMaximized: boolean): void => cb(isMaximized)
    ipcRenderer.on('window:maximized-change', handler)
    return () => ipcRenderer.removeListener('window:maximized-change', handler)
  },
  onTaskNotification: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:task-notification', handler)
    return () => ipcRenderer.removeListener('session:task-notification', handler)
  },
  onSubagentStream: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-stream', handler)
    return () => ipcRenderer.removeListener('session:subagent-stream', handler)
  },
  onSubagentMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-message', handler)
    return () => ipcRenderer.removeListener('session:subagent-message', handler)
  },
  onSubagentToolResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-tool-result', handler)
    return () => ipcRenderer.removeListener('session:subagent-tool-result', handler)
  },
  onPermissionMode: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:permission-mode', handler)
    return () => ipcRenderer.removeListener('session:permission-mode', handler)
  },
  onBackgroundOutput: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:background-output', handler)
    return () => ipcRenderer.removeListener('session:background-output', handler)
  },
  watchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:watch-background', routingId, toolUseId),
  unwatchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:unwatch-background', routingId, toolUseId),
  readBackgroundRange: (routingId: string, toolUseId: string, offset: number, length: number) =>
    ipcRenderer.invoke('session:read-background-range', routingId, toolUseId, offset, length),
  stopTask: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:stop-task', routingId, toolUseId),
  setPermissionMode: (routingId: string, mode: string) =>
    ipcRenderer.invoke('session:set-permission-mode', routingId, mode),
  setModel: (routingId: string, model: string) =>
    ipcRenderer.invoke('session:set-model', routingId, model),
  setEffort: (routingId: string, effort: string) =>
    ipcRenderer.invoke('session:set-effort', routingId, effort),
  getModels: () => ipcRenderer.invoke('session:get-models'),
  generateTitle: (conversationText: string) =>
    ipcRenderer.invoke('session:generate-title', conversationText),
  writeCustomTitle: (sessionId: string, projectKey: string, title: string) =>
    ipcRenderer.invoke('session:write-custom-title', sessionId, projectKey, title),
  getPlanContent: (routingId: string) =>
    ipcRenderer.invoke('session:get-plan-content', routingId),
  getSessionLogPath: (routingId: string) =>
    ipcRenderer.invoke('session:get-session-log-path', routingId),
  watchSession: (routingId: string, sessionId: string, projectKey: string) =>
    ipcRenderer.invoke('session:watch-session', routingId, sessionId, projectKey),
  unwatchSession: (routingId: string) =>
    ipcRenderer.invoke('session:unwatch-session', routingId),
  onWatchUpdate: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:watch-update', handler)
    return () => ipcRenderer.removeListener('session:watch-update', handler)
  },
  onDirectoriesChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('session:directories-changed', handler)
    return () => ipcRenderer.removeListener('session:directories-changed', handler)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error global augmentation
  window.api = api
}
