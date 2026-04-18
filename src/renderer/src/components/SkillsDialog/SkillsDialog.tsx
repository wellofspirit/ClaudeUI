import { useState, useEffect } from 'react'
import type { SkillInfo } from '../../../../shared/types'
import { SkillsDialogView } from './View'

interface SkillsDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
}

export function SkillsDialog({ open, onClose, cwd }: SkillsDialogProps): React.JSX.Element | null {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      // Clear skills on close so a reopen with different cwd doesn't flash stale data
      setSkills([])
      return
    }
    if (!cwd) return
    setLoading(true)
    // Clear old skills immediately so the View's auto-select effect re-fires on the new cwd
    setSkills([])
    window.api.loadSkillDetails(cwd).then((result) => {
      setSkills(result)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [open, cwd])

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

  return (
    <SkillsDialogView
      skills={skills}
      loading={loading}
      cwd={cwd}
      onClose={onClose}
    />
  )
}
