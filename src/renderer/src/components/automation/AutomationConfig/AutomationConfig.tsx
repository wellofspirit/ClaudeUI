import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAutomationStore } from '../../../stores/automation-store'
import { useSessionStore } from '../../../stores/session-store'
import type {
  Automation,
  AutomationRun,
  ClaudePermissions,
  ModelInfo
} from '../../../../../shared/types'
import { AutomationConfigView, type ModelOption, type InheritedPerms } from './View'

export function AutomationConfig(): React.JSX.Element {
  const selectedId = useAutomationStore((s) => s.selectedAutomationId)
  const automations = useAutomationStore((s) => s.automations)
  const automation = automations.find((a) => a.id === selectedId)

  if (!automation) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
        Select an automation
      </div>
    )
  }

  return <AutomationConfigController key={automation.id} automation={automation} />
}

function AutomationConfigController({ automation }: { automation: Automation }): React.JSX.Element {
  const [models, setModels] = useState<ModelOption[]>([])
  const [globalPerms, setGlobalPerms] = useState<InheritedPerms | null>(null)

  const runs = useAutomationStore((s) => s.runs[automation.id])
  const detailTab = useAutomationStore((s) => s.detailTab)
  const setDetailTab = useAutomationStore((s) => s.setDetailTab)
  const setRuns = useAutomationStore((s) => s.setRuns)
  const selectRun = useAutomationStore((s) => s.selectRun)
  const hasRunningRun = runs?.some((r) => r.status === 'running') ?? false

  useEffect(() => {
    window.api.getModels().then((infos: ModelInfo[]) => {
      setModels(
        infos.map((m) => ({
          ...m,
          shortName: m.description?.split('·')[0]?.trim() || m.displayName
        }))
      )
    })
    window.api
      .loadClaudePermissions('user')
      .then((user: ClaudePermissions) => {
        setGlobalPerms(
          user.allow.length > 0 || user.deny.length > 0
            ? { allow: user.allow, deny: user.deny }
            : null
        )
      })
      .catch(() => setGlobalPerms(null))
  }, [])

  // Load runs on mount if not already in the store, so the Runs tab is populated.
  useEffect(() => {
    if (runs !== undefined) return
    let cancelled = false
    window.api
      .listAutomationRuns(automation.id)
      .then((r: AutomationRun[]) => {
        if (!cancelled) setRuns(automation.id, r)
      })
      .catch(() => {
        if (!cancelled) setRuns(automation.id, [])
      })
    return () => {
      cancelled = true
    }
  }, [automation.id, runs, setRuns])

  const loadDirPerms = useCallback(async (cwd: string): Promise<InheritedPerms | null> => {
    if (!cwd) return null
    try {
      const [project, local] = await Promise.all([
        window.api.loadClaudePermissions('project', cwd),
        window.api.loadClaudePermissions('local', cwd)
      ])
      const merged: InheritedPerms = {
        allow: [...project.allow, ...local.allow],
        deny: [...project.deny, ...local.deny]
      }
      return merged.allow.length > 0 || merged.deny.length > 0 ? merged : null
    } catch {
      return null
    }
  }, [])

  const handleSave = useCallback((updated: Automation) => {
    window.api.saveAutomation(updated)
  }, [])

  const handleToggleEnabled = useCallback(
    (enabled: boolean) => {
      window.api.toggleAutomation(automation.id, enabled)
    },
    [automation.id]
  )

  const handleRunNow = useCallback(() => {
    window.api.runAutomationNow(automation.id)
  }, [automation.id])

  const handleStopRun = useCallback(() => {
    window.api.cancelAutomationRun(automation.id)
    const runningRun = runs?.find((r) => r.status === 'running')
    if (runningRun) {
      window.api.dismissAutomationRun(automation.id, runningRun.id)
    }
  }, [automation.id, runs])

  const handleDelete = useCallback(() => {
    if (confirm(`Delete "${automation.name}"? This cannot be undone.`)) {
      window.api.deleteAutomation(automation.id)
      useAutomationStore.getState().selectAutomation(null)
    }
  }, [automation.id, automation.name])

  const handlePickFolder = useCallback(async (): Promise<string | null> => {
    return window.api.pickFolder()
  }, [])

  // ADR-046 decision 3: on the web client `pickFolder()` resolves to null, so the
  // View browses the host's filesystem through `file:list-dir` instead. Desktop
  // passes nothing and keeps the native dialog.
  const isWeb = window.api.platform === 'web'
  const listDir = isWeb ? window.api.listDir : undefined
  const listPlaces = isWeb ? window.api.listPlaces : undefined

  // Recents for the browser's rail. Mapped through a memo, not inside the
  // selector: a selector that builds a new array every call never compares
  // equal, so the store would re-render this tree on every notification.
  const directories = useSessionStore((s) => s.directories)
  const recents = useMemo(
    () => directories.map((g) => ({ cwd: g.cwd, folderName: g.folderName })),
    [directories]
  )

  const handleSelectRun = useCallback(
    (runId: string) => {
      selectRun(automation.id, runId)
    },
    [automation.id, selectRun]
  )

  return (
    <AutomationConfigView
      automation={automation}
      models={models}
      globalPerms={globalPerms}
      hasRunningRun={hasRunningRun}
      runs={runs}
      detailTab={detailTab}
      loadDirPerms={loadDirPerms}
      onSave={handleSave}
      onToggleEnabled={handleToggleEnabled}
      onDelete={handleDelete}
      onRunNow={handleRunNow}
      onStopRun={handleStopRun}
      onPickFolder={handlePickFolder}
      listDir={listDir}
      listPlaces={listPlaces}
      recents={recents}
      onSelectRun={handleSelectRun}
      onSetDetailTab={setDetailTab}
    />
  )
}
