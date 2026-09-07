import { useState, useEffect, useCallback, useMemo } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SettingsDialogView, groupKey } from './View'
import { SettingsMobileView } from './MobileView'
import { PAGES, enginesOf } from './settings-pages'
import type { SettingsPageId, SettingsTarget, VersionInfo } from './settings-target'
import type { EngineConfig, EngineId, VendorConfig } from '../../../../shared/types'
export { SettingsToggle } from './settings-controls'

/**
 * The page the dialog reopens on for the rest of this app run (ADR-065). Module
 * level, not persisted: "where I was last time" is a within-session convenience,
 * and a page remembered across restarts would surprise on the next launch.
 * A deep link always wins over it.
 */
let lastPage: SettingsPageId = 'appearance'

export function SettingsDialog({
  onClose,
  initialTarget
}: {
  onClose: () => void
  /** Where to open. Omitted = the last page this app run. */
  initialTarget?: SettingsTarget
}): React.JSX.Element {
  const isMobile = useIsMobile()
  const settings = useSessionStore((s) => s.settings)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const setStoreEngineConfig = useSessionStore((s) => s.setEngineConfig)
  // An engine segment opens on the engine you are actually working in. With no
  // active session the store answers with the EMPTY state, whose engine is not
  // a preference — a group that does not offer it falls back to its first key.
  const sessionEngine = useActiveSession((s) => s.selectedEngineId)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [activePage, setActivePage] = useState<SettingsPageId>(initialTarget?.page ?? lastPage)
  const [activeGroup, setActiveGroup] = useState<string | null>(initialTarget?.group ?? null)
  // 0 = nothing has asked the pane to scroll yet.
  const [scrollNonce, setScrollNonce] = useState(0)
  const [search, setSearch] = useState('')
  const [engineOverrides, setEngineOverrides] = useState<Record<string, EngineId>>({})
  const [engineConfig, setEngineConfig] = useState<EngineConfig>({})
  const [vendorConfig, setVendorConfig] = useState<VendorConfig>({})

  const targetPage = initialTarget?.page
  const targetGroup = initialTarget?.group
  useEffect(() => {
    if (!targetPage) return
    setActivePage(targetPage)
    setActiveGroup(targetGroup ?? null)
    setSearch('')
    setScrollNonce((n) => n + 1)
  }, [targetPage, targetGroup])

  // Reopening lands where you left off.
  useEffect(() => {
    lastPage = activePage
  }, [activePage])

  // Fetch version info on mount (Advanced › About renders it).
  useEffect(() => {
    window.api
      .getVersionInfo()
      .then(setVersionInfo)
      .catch(() => {})
  }, [])

  // Load engine and vendor config on mount
  useEffect(() => {
    window.api
      .loadEngineConfig('claude')
      .then(setEngineConfig)
      .catch(() => {})
    window.api
      .loadVendorConfig('anthropic')
      .then(setVendorConfig)
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

  /**
   * Every engine-segment group's current engine: the user's explicit pick if
   * there is one, else the active session's engine when the group offers it,
   * else the group's first engine.
   */
  const engineByGroup = useMemo(() => {
    const out: Record<string, EngineId> = {}
    for (const page of PAGES) {
      for (const group of page.groups) {
        if (!group.byEngine) continue
        const engines = enginesOf(group)
        const key = groupKey(page.id, group.id)
        out[key] =
          engineOverrides[key] ??
          (sessionEngine && engines.includes(sessionEngine) ? sessionEngine : engines[0])
      }
    }
    return out
  }, [engineOverrides, sessionEngine])

  const handleSelectPage = useCallback((page: SettingsPageId): void => {
    setActivePage(page)
    setActiveGroup(null)
    setSearch('')
  }, [])

  const handleSelectEngine = useCallback((key: string, engine: EngineId): void => {
    setEngineOverrides((prev) => ({ ...prev, [key]: engine }))
  }, [])

  /** Cross-page links inside a row (Sessions › Command sandbox → Claude). */
  const navigate = useCallback((target: SettingsTarget): void => {
    setActivePage(target.page)
    setActiveGroup(target.group ?? null)
    setSearch('')
    setScrollNonce((n) => n + 1)
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

  const shared = {
    settings,
    updateSettings,
    engineConfig,
    updateEngineConfig: handleUpdateEngineConfig,
    vendorConfig,
    updateVendorConfig: handleUpdateVendorConfig,
    versionInfo,
    search,
    onSearchChange: setSearch,
    onClose
  }

  // Same data, two presentations (the PermissionsDialog pattern). The phone
  // still runs the legacy scope/section model behind an adapter (ADR-065 phase
  // 5 moves it onto the page model), so it OWNS that navigation state rather
  // than taking page/group props it could not use.
  if (isMobile) return <SettingsMobileView {...shared} initialTarget={initialTarget} />

  return (
    <SettingsDialogView
      {...shared}
      activePage={activePage}
      onSelectPage={handleSelectPage}
      activeGroup={activeGroup}
      onActiveGroupChange={setActiveGroup}
      scrollNonce={scrollNonce}
      engineByGroup={engineByGroup}
      onSelectEngine={handleSelectEngine}
      navigate={navigate}
    />
  )
}
