import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { ClaudePermissions, PermissionScope, WorkspaceTrust } from '../../../../shared/types'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PermissionsDialogView } from './View'
import { PermissionsMobileView } from './MobileView'
import type { RuleCategory } from './shared'
import { ipcErrorMessage } from '../../utils/ipc-error'

interface PermissionsDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
  initialTab?: PermissionScope
}

const EMPTY_PERMS: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}

export function PermissionsDialog({
  open,
  onClose,
  cwd,
  initialTab
}: PermissionsDialogProps): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const [activeTab, setActiveTab] = useState<PermissionScope>(initialTab ?? 'local')
  const [permsMap, setPermsMap] = useState<Record<PermissionScope, ClaudePermissions>>({
    local: { ...EMPTY_PERMS },
    project: { ...EMPTY_PERMS },
    user: { ...EMPTY_PERMS }
  })
  const [dirty, setDirty] = useState<Record<PermissionScope, boolean>>({
    local: false,
    project: false,
    user: false
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** null until probed / when there is no cwd to probe. */
  const [trust, setTrust] = useState<WorkspaceTrust | null>(null)
  const [trustSaving, setTrustSaving] = useState(false)
  const [trustError, setTrustError] = useState<string | null>(null)
  /** Bumped on every probe (open/cwd change): a save that lands after it belongs to a stale cwd. */
  const trustGeneration = useRef(0)

  const loaded = useRef(false)

  // Available tabs — project/local only available when cwd is set. Memoized so
  // its identity is stable (it feeds a useCallback dependency list).
  const tabs: PermissionScope[] = useMemo(
    () => (cwd ? ['local', 'project', 'user'] : ['user']),
    [cwd]
  )

  // Reset active tab only when cwd or initialTab changes (not when activeTab
  // changes). The reset must run in BOTH directions: the dialog is mounted
  // (closed) from app boot, when cwd is briefly null — forcing 'user' then
  // never coming back meant the dialog always opened on Global instead of
  // Local once the session hydrated.
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
    else setActiveTab(cwd ? 'local' : 'user')
  }, [cwd, initialTab])

  useEffect(() => {
    if (!open) {
      loaded.current = false
      return
    }

    async function load(): Promise<void> {
      setLoading(true)
      try {
        const [user, project, local] = await Promise.all([
          window.api.loadClaudePermissions('user'),
          cwd
            ? window.api.loadClaudePermissions('project', cwd)
            : Promise.resolve({ ...EMPTY_PERMS }),
          cwd ? window.api.loadClaudePermissions('local', cwd) : Promise.resolve({ ...EMPTY_PERMS })
        ])
        setPermsMap({ user, project, local })
        setDirty({ local: false, project: false, user: false })
        loaded.current = true
      } catch {
        // Silently use empty defaults
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [open, cwd])

  // Workspace trust gates whether cli.js honors project/local ALLOW rules at
  // all, so it's only meaningful once there's a cwd. A probe failure leaves it
  // null → no row, rather than crying wolf on an unknown state.
  useEffect(() => {
    trustGeneration.current++
    setTrustSaving(false)
    setTrustError(null)
    if (!open || !cwd) {
      setTrust(null)
      return
    }
    let cancelled = false
    window.api
      .getWorkspaceTrust(cwd)
      .then((t) => {
        if (!cancelled) setTrust(t)
      })
      .catch(() => {
        if (!cancelled) setTrust(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd])

  // Saved immediately and independently of the dialog's Save/dirty state: it
  // writes ~/.claude.json, not a settings file. Optimistic; reverts on failure.
  const toggleTrust = useCallback(async (): Promise<void> => {
    if (!cwd || !trust || trustSaving) return
    const previous = trust
    const next = !previous.trusted
    const generation = trustGeneration.current
    setTrustSaving(true)
    setTrustError(null)
    setTrust({ ...previous, trusted: next })
    try {
      const saved = await window.api.setWorkspaceTrust(cwd, next)
      if (generation === trustGeneration.current) setTrust(saved)
    } catch (e) {
      if (generation !== trustGeneration.current) return
      setTrustError(ipcErrorMessage(e))
      // A remote call can fail after the host already wrote (dropped connection,
      // timeout): show what is on disk, not a guess. Fall back to the old state.
      const actual = await window.api.getWorkspaceTrust(cwd).catch(() => null)
      if (generation === trustGeneration.current) setTrust(actual ?? previous)
    } finally {
      if (generation === trustGeneration.current) setTrustSaving(false)
    }
  }, [cwd, trust, trustSaving])

  const saveScope = useCallback(
    async (scope: PermissionScope): Promise<void> => {
      if (!dirty[scope]) return
      setSaving(true)
      try {
        await window.api.saveClaudePermissions(scope, permsMap[scope], cwd ?? undefined)
        setDirty((d) => ({ ...d, [scope]: false }))
      } finally {
        setSaving(false)
      }
    },
    [dirty, permsMap, cwd]
  )

  const saveAll = useCallback(async (): Promise<void> => {
    for (const scope of tabs) {
      if (dirty[scope]) await saveScope(scope)
    }
  }, [tabs, dirty, saveScope])

  const updateRules = useCallback(
    (scope: PermissionScope, category: RuleCategory, updater: (rules: string[]) => string[]) => {
      setPermsMap((prev) => ({
        ...prev,
        [scope]: {
          ...prev[scope],
          [category]: updater(prev[scope][category])
        }
      }))
      setDirty((d) => ({ ...d, [scope]: true }))
    },
    []
  )

  const updateDirs = useCallback(
    (scope: PermissionScope, updater: (dirs: string[]) => string[]) => {
      setPermsMap((prev) => ({
        ...prev,
        [scope]: {
          ...prev[scope],
          additionalDirectories: updater(prev[scope].additionalDirectories)
        }
      }))
      setDirty((d) => ({ ...d, [scope]: true }))
    },
    []
  )

  const handleClose = useCallback(async () => {
    await saveAll()
    onClose()
  }, [saveAll, onClose])

  const handleChangeTab = useCallback(
    async (scope: PermissionScope): Promise<void> => {
      await saveScope(activeTab)
      setActiveTab(scope)
    },
    [activeTab, saveScope]
  )

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, handleClose])

  if (!open) return null

  const perms = permsMap[activeTab]
  const hasDirty = tabs.some((s) => dirty[s])

  // Same props, two presentations: the mobile view is a fullscreen two-layer
  // takeover (browse + entry sheet) because the desktop dialog's per-section
  // text inputs are unusable under a soft keyboard. See MobileView.tsx.
  const View = isMobile ? PermissionsMobileView : PermissionsDialogView

  return (
    <View
      loading={loading}
      saving={saving}
      activeTab={activeTab}
      tabs={tabs}
      perms={perms}
      dirty={dirty}
      hasDirty={hasDirty}
      cwd={cwd}
      trust={trust}
      trustSaving={trustSaving}
      trustError={trustError}
      onToggleTrust={toggleTrust}
      onListDir={window.api.listDir}
      onChangeTab={handleChangeTab}
      onUpdateRule={(category, i, v) =>
        updateRules(activeTab, category, (r) => r.map((x, j) => (j === i ? v : x)))
      }
      onDeleteRule={(category, i) =>
        updateRules(activeTab, category, (r) => r.filter((_, j) => j !== i))
      }
      onAddRule={(category, rule) => updateRules(activeTab, category, (r) => [...r, rule])}
      onUpdateDir={(i, v) => updateDirs(activeTab, (d) => d.map((x, j) => (j === i ? v : x)))}
      onDeleteDir={(i) => updateDirs(activeTab, (d) => d.filter((_, j) => j !== i))}
      onAddDir={(dir) => updateDirs(activeTab, (d) => [...d, dir])}
      onSaveAll={saveAll}
      onClose={handleClose}
    />
  )
}
