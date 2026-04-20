import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  selectVisibleTerminalTabs,
  selectActiveTerminalId,
  selectAllTerminalTabs
} from '../../../stores/session-store'
import { TerminalPanelView } from './View'

interface Props {
  style: React.CSSProperties
}

export function TerminalPanel({ style }: Props): React.JSX.Element {
  const visibleTabs = useSessionStore(useShallow(selectVisibleTerminalTabs))
  const activeId = useSessionStore(selectActiveTerminalId)
  const allTabs = useSessionStore(useShallow(selectAllTerminalTabs))
  const addTerminalTab = useSessionStore((s) => s.addTerminalTab)
  const closeTerminalTab = useSessionStore((s) => s.closeTerminalTab)
  const removeTerminalTab = useSessionStore((s) => s.removeTerminalTab)
  const setActiveTerminal = useSessionStore((s) => s.setActiveTerminal)
  const setTerminalPanelOpen = useSessionStore((s) => s.setTerminalPanelOpen)

  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId
    return id ? s.sessions[id]?.cwd ?? '' : ''
  })

  const handleNewTab = async (): Promise<void> => {
    const terminalId = await window.api.createTerminal(cwd || '.')
    addTerminalTab({ id: terminalId, title: 'Terminal', cwd: cwd || '.' })
  }

  // Listen for PTY exit events
  useEffect(() => {
    const unsub = window.api.onTerminalExit(({ terminalId }) => {
      removeTerminalTab(terminalId)
    })
    return unsub
  }, [removeTerminalTab])

  return (
    <TerminalPanelView
      style={style}
      visibleTabs={visibleTabs}
      allTabs={allTabs}
      activeId={activeId}
      onSelectTab={setActiveTerminal}
      onCloseTab={closeTerminalTab}
      onNewTab={handleNewTab}
      onClosePanel={() => setTerminalPanelOpen(false)}
    />
  )
}
