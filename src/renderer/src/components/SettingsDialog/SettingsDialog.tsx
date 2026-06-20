import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { SettingsDialogView, type VersionInfo } from './View'
import { SECTIONS, NAV_GROUPS, type Section } from './settings-sections'
import type { EngineConfig, VendorConfig } from '../../../../shared/types'
export { SettingsToggle } from './settings-controls'

/** Get the first section id across all nav groups */
function firstSectionId(): string {
  const firstGroup = NAV_GROUPS[0]
  if (firstGroup?.sections?.[0]) return firstGroup.sections[0].id
  if (firstGroup?.children?.[0]?.sections?.[0]) return firstGroup.children[0].sections[0].id
  return SECTIONS[0]?.id ?? ''
}

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const setStoreEngineConfig = useSessionStore((s) => s.setEngineConfig)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [search, setSearch] = useState('')
  const [activeSection, setActiveSection] = useState(firstSectionId)
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

  const filteredSections = useMemo<Section[]>(() => {
    if (!search.trim()) return SECTIONS
    const q = search.toLowerCase()
    return SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.keywords && item.keywords.toLowerCase().includes(q)) ||
          section.label.toLowerCase().includes(q)
      )
    })).filter((section) => section.items.length > 0)
  }, [search])

  // The View calls onScrollTo to notify the FC that a specific section was
  // clicked; mirror that into activeSection. Scroll-spy updates via
  // onSelectSection as the user scrolls the content container.
  const handleSelectSection = useCallback((id: string) => setActiveSection(id), [])

  const handleUpdateEngineConfig = useCallback((patch: Partial<EngineConfig>) => {
    setEngineConfig((prev) => {
      const next = { ...prev, ...patch }
      window.api.saveEngineConfig('claude', next).catch(() => {})
      setStoreEngineConfig(next)
      return next
    })
  }, [setStoreEngineConfig])

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
      search={search}
      activeSection={activeSection}
      filteredSections={filteredSections}
      onSearchChange={setSearch}
      onSelectSection={handleSelectSection}
      onScrollTo={handleSelectSection}
      onClose={onClose}
    />
  )
}
