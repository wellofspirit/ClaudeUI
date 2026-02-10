import type { ClaudeAPI } from '../shared/types'

declare global {
  interface Window {
    api: ClaudeAPI
  }
}
