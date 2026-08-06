import { useActiveSession, useSessionStore } from '../stores/session-store'
import { TaskDetailPanel } from './TaskDetailPanel'
import { findTaskBlocks } from './TaskDetailPanel/utils'

/**
 * Mobile full-screen takeover for the task/subagent view.
 *
 * On desktop, opening a task shows TaskDetailPanel as a side panel next to
 * ChatPanel (see SessionView). On mobile there's no room for a side panel, so
 * this component REPLACES ChatPanel entirely in the same content slot while
 * rightPanel === 'task', with a back button that returns to the chat by
 * driving the same closeTaskPanel action the desktop panel's close (X) uses
 * — so panel state never diverges between mobile and desktop.
 */
export function MobileTaskView(): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const closeTaskPanel = useSessionStore((s) => s.closeTaskPanel)
  const openedTaskToolUseIds = useActiveSession((s) => s.openedTaskToolUseIds)
  const messages = useActiveSession((s) => s.messages)

  const title = ((): string => {
    if (openedTaskToolUseIds.length === 0) return 'Task'
    if (openedTaskToolUseIds.length > 1) return 'Tasks'
    const { taskBlock } = findTaskBlocks(messages, openedTaskToolUseIds[0])
    const input = taskBlock?.toolInput || {}
    const description = String(input.description || input.prompt || input.command || '')
    return description || 'Task'
  })()

  const handleBack = (): void => {
    if (activeSessionId) closeTaskPanel(activeSessionId)
  }

  return (
    <div data-testid="MobileTaskView" className="h-full flex flex-col bg-bg-primary overflow-hidden">
      <div
        className="shrink-0 flex items-center gap-3 px-3 h-12 border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <button
          data-testid="MobileTaskView.back"
          onClick={handleBack}
          className="flex items-center gap-1 shrink-0 -ml-1 px-1 py-1 text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="text-[13px] font-medium">Back</span>
        </button>
        <span className="text-[13px] text-text-secondary truncate flex-1">{title}</span>
      </div>
      <div className="flex-1 min-h-0 flex">
        <TaskDetailPanel variant="fullscreen" style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  )
}
