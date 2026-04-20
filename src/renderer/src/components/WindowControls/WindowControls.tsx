import { useState, useEffect } from 'react'
import { WindowControlsView } from './View'

export function WindowControls(): React.JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    return window.api.onMaximizeChange(setIsMaximized)
  }, [])

  if (window.api.platform !== 'win32') return null

  return (
    <WindowControlsView
      isMaximized={isMaximized}
      onMinimize={() => window.api.minimizeWindow()}
      onMaximize={() => window.api.maximizeWindow()}
      onClose={() => window.api.closeWindow()}
    />
  )
}
