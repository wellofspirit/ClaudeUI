import { useState, useEffect, useCallback } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { SettingsDialogView, type VersionInfo } from './View'
import {
  SCOPES,
  scopeCapabilities,
  isSectionVisible,
  SECTION_SCOPE_MAP,
  type SettingsScope
} from './settings-sections'
import type { EngineConfig, VendorConfig } from '../../../../shared/types'
export { SettingsToggle } from './settings-controls'

function firstSectionOfScope(scope: SettingsScope): string {
  const scopeDef = SCOPES.find((s) => s.id === scope)
  if (!scopeDef) return ''
  // First capability-visible section (don't default to a gated-out one).
  const caps = scopeCapabilities(scope)
  for (const sg of scopeDef.subgroups) {
    const sec = sg.sections.find((s) => isSectionVisible(s.id, caps))
    if (sec) return sec.id
  }
  return ''
}

export function SettingsDialog({
  onClose,
  initialScope,
  initialSection
}: {
  onClose: () => void
  initialScope?: SettingsScope
  initialSection?: string
}): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const setStoreEngineConfig = useSessionStore((s) => s.setEngineConfig)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [activeScope, setActiveScope] = useState<SettingsScope>('common')
  const [activeSectionId, setActiveSectionId] = useState(() => firstSectionOfScope('common'))
  const [search, setSearch] = useState('')
  const [engineConfig, setEngineConfig] = useState<EngineConfig>({})
  const [vendorConfig, setVendorConfig] = useState<VendorConfig>({})

  useEffect(() => {
    const scope = initialScope ?? (initialSection ? SECTION_SCOPE_MAP.get(initialSection) : undefined)
    if (!scope) return
    setActiveScope(scope)
    setActiveSectionId(initialSection || firstSectionOfScope(scope))
    setSearch('')
  }, [initialScope, initialSection])

  // Fetch version info on mount
  useEffect(() => {
    window.api
      .getVersionInfo()
      .then(setVersionInfo)
      .catch(() => {})
  }, [])

  // Load engine and vendor config on mount
  useEffect(() => {
    window.api.loadEngineConfig('claude').then(setEngineConfig).catch(() => {})
    window.api.loadVendorConfig('anthropic').then(setVendorConfig).catch(() => {})
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Switching scope → reset to first section of that scope, clear search
  const handleSelectScope = useCallback((scope: SettingsScope): void => {
    setActiveScope(scope)
    setActiveSectionId(firstSectionOfScope(scope))
    setSearch('')
  }, [])

  const handleSelectSection = useCallback((id: string): void => {
    setActiveSectionId(id)
  }, [])

  const handleUpdateEngineConfig = useCallback(
    (patch: Partial<EngineConfig>) => {
      setEngineConfig((prev) => {
        const next = { ...prev, ...patch }
        window.api.saveEngineConfig('claude', next).catch(() => {})
        setStoreEngineConfig(next)
        return next
      })
    },
    [setStoreEngineConfig]
  )

  const handleUpdateVendorConfig = useCallback((patch: Partial<VendorConfig>) => {
    setVendorConfig((prev) => {
      const next = { ...prev, ...patch }
      window.api.saveVendorConfig('anthropic', next).catch(() => {})
      return next
    })
  }, [])

  return (
    <SettingsDialogView
      settings={settings}
      updateSettings={updateSettings}
      engineConfig={engineConfig}
      updateEngineConfig={handleUpdateEngineConfig}
      vendorConfig={vendorConfig}
      updateVendorConfig={handleUpdateVendorConfig}
      versionInfo={versionInfo}
      activeScope={activeScope}
      onSelectScope={handleSelectScope}
      activeSectionId={activeSectionId}
      onSelectSection={handleSelectSection}
      search={search}
      onSearchChange={setSearch}
      onClose={onClose}
    />
  )
}
