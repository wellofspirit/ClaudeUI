import { useState, useEffect } from 'react'
import type { EngineId, SkillInfo } from '../../../../shared/types'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SkillsDialogView } from './View'
import { SkillsMobileView } from './MobileView'

interface SkillsDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
  sessionId?: string | null
  engineId?: EngineId | null
}

export function SkillsDialog({
  open,
  onClose,
  cwd,
  sessionId,
  engineId
}: SkillsDialogProps): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      // Clear skills on close so a reopen with different cwd doesn't flash stale data
      setSkills([])
      return
    }
    if (!cwd) return
    let cancelled = false
    setLoading(true)
    // Clear old skills immediately so the View's auto-select effect re-fires on the new cwd
    setSkills([])
    window.api
      .loadSkillDetails(cwd, sessionId ?? undefined)
      .then((result) => {
        if (cancelled) return
        setSkills(
          engineId === 'claude'
            ? result.map((skill) => ({ ...skill, compatibilityWarnings: [] }))
            : result
        )
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, sessionId, engineId])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  // Same props, two presentations (the PermissionsDialog / SettingsDialog
  // pattern): a phone gets a fullscreen list ⇄ detail drill-down, because the
  // desktop dialog is a fixed 900×560 box with a 280px side list. Loading and
  // the skill set — everything this container owns — are shared verbatim.
  const View = isMobile ? SkillsMobileView : SkillsDialogView

  return <View skills={skills} loading={loading} cwd={cwd} onClose={onClose} />
}
