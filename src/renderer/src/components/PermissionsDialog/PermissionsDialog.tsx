import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { ClaudePermissions, PermissionScope } from '../../../../shared/types'
import { PermissionsDialogView, type RuleCategory } from './View'

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
  const [workspaceTrusted, setWorkspaceTrusted] = useState<boolean | null>(null)

  const loaded = useRef(false)

  // Available tabs — project/local only available when cwd is set. Memoized so
  // its identity is stable (it feeds a useCallback dependency list).
  const tabs: PermissionScope[] = useMemo(
    () => (cwd ? ['local', 'project', 'user'] : ['user']),
    [cwd]
  )

  // Reset active tab only when cwd or initialTab changes (not when activeTab changes)
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
    else if (!cwd) setActiveTab('user')
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
  // null → no banner, rather than crying wolf on an unknown state.
  useEffect(() => {
    if (!open || !cwd) {
      setWorkspaceTrusted(null)
      return
    }
    let cancelled = false
    window.api
      .isWorkspaceTrusted(cwd)
      .then((trusted) => {
        if (!cancelled) setWorkspaceTrusted(trusted)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceTrusted(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd])

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

  return (
    <PermissionsDialogView
      loading={loading}
      saving={saving}
      activeTab={activeTab}
      tabs={tabs}
      perms={perms}
      dirty={dirty}
      hasDirty={hasDirty}
      workspaceTrusted={workspaceTrusted}
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
