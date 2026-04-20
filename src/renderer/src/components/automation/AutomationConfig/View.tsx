import { useState, useEffect, useMemo } from 'react'
import type { Automation, AutomationSchedule, ClaudePermissions } from '../../../../../shared/types'
import { EFFORT_LEVELS, SCHEDULE_PRESETS, PERMISSION_TEMPLATES, PERMISSION_MODES, isAutomationDirty } from './utils'

export interface ModelOption {
  value: string
  displayName: string
}

export interface InheritedPerms {
  allow: string[]
  deny: string[]
}

export interface AutomationConfigViewProps {
  automation: Automation
  models: ModelOption[]
  globalPerms: InheritedPerms | null
  hasRunningRun: boolean
  loadDirPerms: (cwd: string) => Promise<InheritedPerms | null>
  onSave: (updated: Automation) => void
  onToggleEnabled: (enabled: boolean) => void
  onDelete: () => void
  onRunNow: () => void
  onStopRun: () => void
  onPickFolder: () => Promise<string | null>
}

export function AutomationConfigView(props: AutomationConfigViewProps): React.JSX.Element {
  const { automation, models, globalPerms, hasRunningRun, loadDirPerms, onSave, onToggleEnabled, onDelete, onRunNow, onStopRun, onPickFolder } = props

  const [name, setName] = useState(automation.name)
  const [prompt, setPrompt] = useState(automation.prompt)
  const [cwd, setCwd] = useState(automation.cwd)
  const [schedule, setSchedule] = useState<AutomationSchedule>(automation.schedule)
  const [model, setModel] = useState(automation.model || '')
  const [effort, setEffort] = useState(automation.effort || 'medium')
  const [permissionMode, setPermissionMode] = useState(automation.permissionMode || 'auto')
  const [enabled, setEnabled] = useState(automation.enabled)
  const [allowRules, setAllowRules] = useState<string[]>(automation.permissions.allow)
  const [denyRules, setDenyRules] = useState<string[]>(automation.permissions.deny)
  const [newRule, setNewRule] = useState('')
  const [ruleType, setRuleType] = useState<'allow' | 'deny'>('allow')
  const [permsExpanded, setPermsExpanded] = useState(false)
  const [dirPerms, setDirPerms] = useState<InheritedPerms | null>(null)

  const isDirty = useMemo(
    () => isAutomationDirty({ name, prompt, cwd, schedule, model, effort, permissionMode, allowRules, denyRules }, automation),
    [name, prompt, cwd, schedule, model, effort, permissionMode, allowRules, denyRules, automation]
  )

  useEffect(() => {
    if (!cwd) { setDirPerms(null); return }
    let cancelled = false
    loadDirPerms(cwd).then((perms) => { if (!cancelled) setDirPerms(perms) })
    return () => { cancelled = true }
  }, [cwd, loadDirPerms])

  const handleSave = (): void => {
    const updated: Automation = {
      ...automation,
      name,
      prompt,
      cwd,
      schedule,
      model: model || undefined,
      effort: effort || undefined,
      permissionMode: permissionMode as 'default' | 'auto',
      enabled,
      permissions: { allow: allowRules, deny: denyRules },
    }
    onSave(updated)
  }

  const handlePickFolder = async (): Promise<void> => {
    const folder = await onPickFolder()
    if (folder) setCwd(folder)
  }

  const handleToggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    onToggleEnabled(next)
  }

  const addRule = (): void => {
    const rule = newRule.trim()
    if (!rule) return
    if (ruleType === 'allow') {
      if (!allowRules.includes(rule)) setAllowRules([...allowRules, rule])
    } else {
      if (!denyRules.includes(rule)) setDenyRules([...denyRules, rule])
    }
    setNewRule('')
  }

  const removeAllowRule = (idx: number): void => setAllowRules(allowRules.filter((_, i) => i !== idx))
  const removeDenyRule = (idx: number): void => setDenyRules(denyRules.filter((_, i) => i !== idx))

  return (
    <div className="p-5 max-w-2xl space-y-5">
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-accent transition-colors"
          placeholder="My Automation"
        />
      </Field>

      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-text-accent transition-colors resize-y font-mono"
          placeholder="What should Claude do when this automation runs?"
        />
      </Field>

      <Field label="Working Directory">
        <div className="flex gap-2">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="flex-1 bg-bg-tertiary border border-border/40 rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-accent transition-colors font-mono"
            placeholder="/path/to/project"
          />
          <button
            onClick={handlePickFolder}
            className="px-3 py-1.5 text-xs bg-bg-tertiary border border-border/40 rounded-lg hover:bg-bg-hover transition-colors text-text-secondary"
          >
            Browse
          </button>
        </div>
      </Field>

      <Field label="Schedule">
        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => setSchedule({ ...schedule, type: 'interval' })}
              className={`px-3 py-1 text-xs rounded-lg border transition-colors ${
                schedule.type === 'interval'
                  ? 'bg-bg-hover border-text-accent text-text-primary'
                  : 'border-border/40 text-text-muted hover:bg-bg-hover'
              }`}
            >
              Interval
            </button>
            <button
              onClick={() => setSchedule({ ...schedule, type: 'cron' })}
              className={`px-3 py-1 text-xs rounded-lg border transition-colors ${
                schedule.type === 'cron'
                  ? 'bg-bg-hover border-text-accent text-text-primary'
                  : 'border-border/40 text-text-muted hover:bg-bg-hover'
              }`}
            >
              Cron
            </button>
          </div>

          {schedule.type === 'interval' ? (
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_PRESETS.map((preset) => (
                <button
                  key={preset.ms}
                  onClick={() => setSchedule({ type: 'interval', intervalMs: preset.ms })}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    schedule.intervalMs === preset.ms
                      ? 'bg-bg-hover border-text-accent text-text-primary'
                      : 'border-border/40 text-text-muted hover:bg-bg-hover'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              <input
                value={schedule.cronExpression || ''}
                onChange={(e) => setSchedule({ type: 'cron', cronExpression: e.target.value })}
                className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-accent transition-colors font-mono"
                placeholder="0 * * * *"
              />
              <p className="text-[10px] text-text-muted">
                Standard cron format: minute hour day-of-month month day-of-week
              </p>
            </div>
          )}
        </div>
      </Field>

      <div className="flex gap-4">
        <Field label="Model" className="flex-1">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-accent transition-colors"
          >
            <option value="">Default</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.displayName}</option>
            ))}
          </select>
        </Field>
        <Field label="Effort" className="flex-1">
          <div className="flex gap-1.5">
            {EFFORT_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => setEffort(level)}
                className={`flex-1 px-2 py-1 text-xs rounded-lg border transition-colors capitalize ${
                  effort === level
                    ? 'bg-bg-hover border-text-accent text-text-primary'
                    : 'border-border/40 text-text-muted hover:bg-bg-hover'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Permission Mode" className="flex-1">
          <div className="flex gap-1.5">
            {PERMISSION_MODES.map((mode) => (
              <button
                key={mode.value}
                onClick={() => setPermissionMode(mode.value)}
                title={mode.description}
                className={`flex-1 px-2 py-1 text-xs rounded-lg border transition-colors ${
                  permissionMode === mode.value
                    ? 'bg-bg-hover border-text-accent text-text-primary'
                    : 'border-border/40 text-text-muted hover:bg-bg-hover'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* Permissions */}
      <div>
        <button
          onClick={() => setPermsExpanded(!permsExpanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-text-muted mb-1 hover:text-text-secondary transition-colors"
        >
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`transition-transform ${permsExpanded ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Permissions
          <span className="text-text-muted/60 font-normal">
            ({allowRules.length} allow, {denyRules.length} deny)
          </span>
        </button>

        {permsExpanded && (
          <div className="space-y-2 pl-4 border-l border-border/20">
            {globalPerms && (
              <InheritedPermissions label="Inherited from global settings" perms={globalPerms} />
            )}
            {dirPerms && (
              <InheritedPermissions label="Inherited from directory" perms={dirPerms} />
            )}

            <div>
              <span className="text-[10px] text-green-400 uppercase font-semibold">Allow</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {allowRules.map((rule, idx) => (
                  <PermissionPill key={idx} rule={rule} variant="allow" onRemove={() => removeAllowRule(idx)} />
                ))}
                {allowRules.length === 0 && <span className="text-xs text-text-muted italic">None</span>}
              </div>
            </div>

            <div>
              <span className="text-[10px] text-red-400 uppercase font-semibold">Deny</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {denyRules.map((rule, idx) => (
                  <PermissionPill key={idx} rule={rule} variant="deny" onRemove={() => removeDenyRule(idx)} />
                ))}
                {denyRules.length === 0 && <span className="text-xs text-text-muted italic">None</span>}
              </div>
            </div>

            <div className="flex gap-2 items-center mt-2">
              <select
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as 'allow' | 'deny')}
                className="bg-bg-tertiary border border-border/40 rounded-lg px-2 py-1 text-xs text-text-primary"
              >
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
              <input
                value={newRule}
                onChange={(e) => setNewRule(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addRule()}
                className="flex-1 bg-bg-tertiary border border-border/40 rounded-lg px-2 py-1 text-xs text-text-primary outline-none focus:border-text-accent"
                placeholder="e.g., Bash(command:*)"
                list="permission-templates"
              />
              <datalist id="permission-templates">
                {PERMISSION_TEMPLATES.map((t) => <option key={t} value={t} />)}
              </datalist>
              <button
                onClick={addRule}
                className="px-2 py-1 text-xs bg-bg-tertiary border border-border/40 rounded-lg hover:bg-bg-hover transition-colors text-text-secondary"
              >
                Add
              </button>
            </div>

            <div className="flex flex-wrap gap-1 mt-1">
              {PERMISSION_TEMPLATES.slice(0, 6).map((t) => {
                const isAllowed = allowRules.includes(t)
                const isDenied = denyRules.includes(t)
                if (isAllowed || isDenied) return null
                return (
                  <button
                    key={t}
                    onClick={() => setAllowRules([...allowRules, t])}
                    className="px-1.5 py-0.5 text-[10px] rounded border border-border/30 text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors"
                  >
                    + {t}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2 border-t border-border/20">
        <button
          onClick={handleSave}
          disabled={!isDirty}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            isDirty
              ? 'bg-text-accent/15 border-text-accent/40 text-text-accent hover:bg-text-accent/25'
              : 'bg-bg-tertiary border-border/40 text-text-muted cursor-not-allowed opacity-50'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          {isDirty ? 'Save' : 'Saved'}
        </button>

        <button
          onClick={handleToggleEnabled}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            enabled
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-bg-tertiary border-border/40 text-text-muted'
          }`}
        >
          <div className={`w-2 h-2 rounded-full ${enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
          {enabled ? 'Enabled' : 'Disabled'}
        </button>

        <button
          onClick={hasRunningRun ? onStopRun : onRunNow}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            hasRunningRun
              ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
              : 'bg-bg-tertiary border-border/40 text-text-secondary hover:bg-bg-hover'
          }`}
        >
          {hasRunningRun ? (
            <>
              <span className="text-xs">■</span>
              Stop
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Run Now
            </>
          )}
        </button>

        <div className="flex-1" />

        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// ── Presentational helpers ──────────────────────────────────────────

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-text-muted mb-1">{label}</label>
      {children}
    </div>
  )
}

function InheritedPermissions({ label, perms }: { label: string; perms: InheritedPerms }): React.JSX.Element {
  return (
    <div className="bg-bg-tertiary/50 rounded-lg px-3 py-2 space-y-1.5">
      <span className="text-[10px] text-text-muted uppercase font-semibold">{label}</span>
      {perms.allow.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {perms.allow.map((rule, idx) => (
            <span key={idx} className="inline-flex items-center px-2 py-0.5 text-[10px] rounded-full border bg-green-500/5 border-green-500/15 text-green-400/70">
              {rule}
            </span>
          ))}
        </div>
      )}
      {perms.deny.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {perms.deny.map((rule, idx) => (
            <span key={idx} className="inline-flex items-center px-2 py-0.5 text-[10px] rounded-full border bg-red-500/5 border-red-500/15 text-red-400/70">
              {rule}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function PermissionPill({ rule, variant, onRemove }: { rule: string; variant: 'allow' | 'deny'; onRemove: () => void }): React.JSX.Element {
  const colors = variant === 'allow'
    ? 'bg-green-500/10 border-green-500/20 text-green-400'
    : 'bg-red-500/10 border-red-500/20 text-red-400'

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border ${colors}`}>
      {rule}
      <button onClick={onRemove} className="hover:text-text-primary ml-0.5">&times;</button>
    </span>
  )
}

// Use ClaudePermissions type elsewhere; keep import-only dependency explicit
export type { ClaudePermissions }
