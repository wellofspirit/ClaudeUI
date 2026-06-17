import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { SettingsDialogView, type VersionInfo } from './View'
import { SECTIONS, type Section } from './settings-sections'
export { SettingsToggle } from './settings-controls'

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [search, setSearch] = useState('')
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)

  // Fetch version info on mount
  useEffect(() => {
    window.api
      .getVersionInfo()
      .then(setVersionInfo)
      .catch(() => {})
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

  return (
    <SettingsDialogView
      settings={settings}
      updateSettings={updateSettings}
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
