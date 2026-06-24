import { useState, useEffect, useCallback } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { SettingsDialogView, type VersionInfo } from './View'
import { SCOPES, type SettingsScope } from './settings-sections'
import type { EngineConfig, VendorConfig } from '../../../../shared/types'
export { SettingsToggle } from './settings-controls'

function firstSectionOfScope(scope: SettingsScope): string {
  const scopeDef = SCOPES.find((s) => s.id === scope)
  return scopeDef?.subgroups[0]?.sections[0]?.id ?? ''
}

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const setStoreEngineConfig = useSessionStore((s) => s.setEngineConfig)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [activeScope, setActiveScope] = useState<SettingsScope>('common')
  const [activeSectionId, setActiveSectionId] = useState(() => firstSectionOfScope('common'))
  const [search, setSearch] = useState('')
  const [engineConfig, setEngineConfig] = useState<EngineConfig>({})
  const [vendorConfig, setVendorConfig] = useState<VendorConfig>({})

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
