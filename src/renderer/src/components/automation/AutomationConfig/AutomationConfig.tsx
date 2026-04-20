import { useState, useEffect, useCallback } from 'react'
import { useAutomationStore } from '../../../stores/automation-store'
import type { Automation, ClaudePermissions } from '../../../../../shared/types'
import { AutomationConfigView, type ModelOption, type InheritedPerms } from './View'

export function AutomationConfig(): React.JSX.Element {
  const selectedId = useAutomationStore((s) => s.selectedAutomationId)
  const automations = useAutomationStore((s) => s.automations)
  const automation = automations.find((a) => a.id === selectedId)

  if (!automation) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">Select an automation</div>
  }

  return <AutomationConfigController key={automation.id} automation={automation} />
}

function AutomationConfigController({ automation }: { automation: Automation }): React.JSX.Element {
  const [models, setModels] = useState<ModelOption[]>([])
  const [globalPerms, setGlobalPerms] = useState<InheritedPerms | null>(null)

  const runs = useAutomationStore((s) => s.runs[automation.id])
  const hasRunningRun = runs?.some((r) => r.status === 'running') ?? false

  useEffect(() => {
    window.api.getModels().then(setModels)
    window.api.loadClaudePermissions('user').then((user: ClaudePermissions) => {
      setGlobalPerms(user.allow.length > 0 || user.deny.length > 0 ? { allow: user.allow, deny: user.deny } : null)
    }).catch(() => setGlobalPerms(null))
  }, [])

  const loadDirPerms = useCallback(async (cwd: string): Promise<InheritedPerms | null> => {
    if (!cwd) return null
    try {
      const [project, local] = await Promise.all([
        window.api.loadClaudePermissions('project', cwd),
        window.api.loadClaudePermissions('local', cwd),
      ])
      const merged: InheritedPerms = {
        allow: [...project.allow, ...local.allow],
        deny: [...project.deny, ...local.deny],
      }
      return merged.allow.length > 0 || merged.deny.length > 0 ? merged : null
    } catch {
      return null
    }
  }, [])

  const handleSave = useCallback((updated: Automation) => {
    window.api.saveAutomation(updated)
  }, [])

  const handleToggleEnabled = useCallback((enabled: boolean) => {
    window.api.toggleAutomation(automation.id, enabled)
  }, [automation.id])

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

  return (
    <AutomationConfigView
      automation={automation}
      models={models}
      globalPerms={globalPerms}
      hasRunningRun={hasRunningRun}
      loadDirPerms={loadDirPerms}
      onSave={handleSave}
      onToggleEnabled={handleToggleEnabled}
      onDelete={handleDelete}
      onRunNow={handleRunNow}
      onStopRun={handleStopRun}
      onPickFolder={handlePickFolder}
    />
  )
}
