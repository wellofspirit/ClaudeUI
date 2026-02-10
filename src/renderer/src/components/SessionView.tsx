import { Sidebar } from './Sidebar'
import { ChatPanel } from './chat/ChatPanel'

export function SessionView(): React.JSX.Element {
  return (
    <div className="h-screen flex">
      <Sidebar />
      <div className="flex-1 min-w-0 bg-bg-secondary/80">
        <div className="h-full flex flex-col bg-bg-primary rounded-l-2xl shadow-[-4px_0_24px_rgba(0,0,0,0.3)] overflow-hidden">
          <ChatPanel />
        </div>
      </div>
    </div>
  )
}
