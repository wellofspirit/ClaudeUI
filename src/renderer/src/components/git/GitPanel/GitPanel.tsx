import { useEffect, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { GitPanelView } from './View'

interface Props {
  style?: React.CSSProperties
}

export function GitPanel({ style }: Props): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const gitPanelLayout = useSessionStore((s) => s.settings.gitPanelLayout)
  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const setGitSelectedFile = useSessionStore((s) => s.setGitSelectedFile)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  // Fetch initial status when panel opens and auto-select first file
  useEffect(() => {
    if (!cwd || !activeSessionId) return
    window.api.gitGetStatus(cwd).then((status) => {
      setGitStatus(activeSessionId, status)
      const current = useSessionStore.getState().sessions[activeSessionId]?.gitSelectedFile
      if (!current && status.files.length > 0) {
        setGitSelectedFile(activeSessionId, status.files[0].path)
      }
    }).catch(() => {})
  }, [cwd, activeSessionId, setGitStatus, setGitSelectedFile])

  const handleClose = useCallback(() => {
    if (activeSessionId) closeGitPanel(activeSessionId)
  }, [activeSessionId, closeGitPanel])

  const toggleLayout = useCallback(() => {
    updateSettings({ gitPanelLayout: gitPanelLayout === 'single' ? 'double' : 'single' })
  }, [gitPanelLayout, updateSettings])

  return (
    <GitPanelView
      style={style}
      gitStatus={gitStatus}
      isDouble={gitPanelLayout === 'double'}
      onClose={handleClose}
      onToggleLayout={toggleLayout}
    />
  )
}
