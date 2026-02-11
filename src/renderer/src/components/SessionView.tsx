import { Sidebar } from './Sidebar'
import { ChatPanel } from './chat/ChatPanel'
import { TaskDetailPanel } from './TaskDetailPanel'
import { useSessionStore } from '../stores/session-store'

export function SessionView(): React.JSX.Element {
  const taskPanelOpen = useSessionStore((s) => s.taskPanelOpen)

  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 min-w-0 bg-bg-secondary/80 flex">
        <div className="flex-1 min-w-0 h-full flex flex-col bg-bg-primary rounded-l-2xl shadow-[-4px_0_24px_rgba(0,0,0,0.3)] overflow-hidden">
          <ChatPanel />
        </div>
        {taskPanelOpen && <TaskDetailPanel />}
      </div>
    </div>
  )
}
