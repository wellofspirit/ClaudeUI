import { create } from 'zustand'
import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  ContentBlock
} from '../../../shared/types'

const RECENT_DIRS_KEY = 'claudeui-recent-dirs'

function loadRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_DIRS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecentDirs(dirs: string[]): void {
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs))
}

function addToRecent(dir: string, existing: string[]): string[] {
  const filtered = existing.filter((d) => d !== dir)
  const updated = [dir, ...filtered].slice(0, 20)
  saveRecentDirs(updated)
  return updated
}

interface SessionState {
  cwd: string | null
  recentDirs: string[]
  messages: ChatMessage[]
  streamingText: string
  status: SessionStatus
  pendingApproval: PendingApproval | null
  error: string | null

  setCwd: (cwd: string | null) => void
  openDirectory: (cwd: string) => void
  addMessage: (message: ChatMessage) => void
  addUserMessage: (id: string, text: string) => void
  appendStreamingText: (text: string) => void
  clearStreamingText: () => void
  setStatus: (status: SessionStatus) => void
  setPendingApproval: (approval: PendingApproval | null) => void
  setError: (error: string | null) => void
  appendToolResult: (toolUseId: string, result: string, isError: boolean) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  cwd: null,
  recentDirs: loadRecentDirs(),
  messages: [],
  streamingText: '',
  status: {
    state: 'idle',
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0
  },
  pendingApproval: null,
  error: null,

  setCwd: (cwd) => set({ cwd }),

  openDirectory: (cwd) =>
    set((state) => {
      const alreadyExists = state.recentDirs.includes(cwd)
      const recentDirs = alreadyExists
        ? state.recentDirs
        : [cwd, ...state.recentDirs].slice(0, 20)
      if (!alreadyExists) saveRecentDirs(recentDirs)
      return { cwd, messages: [], streamingText: '', error: null, pendingApproval: null, recentDirs }
    }),

  addMessage: (message) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === message.id)
      const messages =
        idx >= 0
          ? state.messages.map((m, i) => (i === idx ? message : m))
          : [...state.messages, message]
      return { messages, streamingText: '' }
    }),

  addUserMessage: (id, text) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          role: 'user' as const,
          content: [{ type: 'text' as const, text }],
          timestamp: Date.now()
        }
      ],
      recentDirs: state.cwd ? addToRecent(state.cwd, state.recentDirs) : state.recentDirs
    })),

  appendStreamingText: (text) =>
    set((state) => ({ streamingText: state.streamingText + text })),

  clearStreamingText: () => set({ streamingText: '' }),

  setStatus: (status) => set({ status }),

  setPendingApproval: (approval) => set({ pendingApproval: approval }),

  setError: (error) => set({ error }),

  appendToolResult: (toolUseId, result, isError) =>
    set((state) => {
      const messages = [...state.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant') {
          const hasToolUse = msg.content.some(
            (b: ContentBlock) => b.type === 'tool_use' && b.toolUseId === toolUseId
          )
          if (hasToolUse) {
            messages[i] = {
              ...msg,
              content: [
                ...msg.content,
                { type: 'tool_result', toolUseId, toolResult: result, isError }
              ]
            }
            break
          }
        }
      }
      return { messages }
    })
}))
