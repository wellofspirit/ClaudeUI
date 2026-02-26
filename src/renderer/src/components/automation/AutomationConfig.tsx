import { useState, useEffect, useCallback, useRef } from 'react'
import { useAutomationStore } from '../../stores/automation-store'
import type { Automation, AutomationSchedule } from '../../../../shared/types'

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

const SCHEDULE_PRESETS = [
  { label: 'Every 15 min', ms: 15 * 60 * 1000 },
  { label: 'Every 30 min', ms: 30 * 60 * 1000 },
  { label: 'Every hour', ms: 60 * 60 * 1000 },
  { label: 'Every 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: 'Every day', ms: 24 * 60 * 60 * 1000 }
]

const PERMISSION_TEMPLATES = [
  'Bash(command:*)',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Edit',
  'Write',
  'Bash(command:git*)',
  'Task'
]

export function AutomationConfig(): React.JSX.Element {
  const selectedId = useAutomationStore((s) => s.selectedAutomationId)
  const automations = useAutomationStore((s) => s.automations)
  const automation = automations.find((a) => a.id === selectedId)

  if (!automation) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">Select an automation</div>
  }

  return <AutomationConfigForm key={automation.id} automation={automation} />
}

// ---------------------------------------------------------------------------
// Config Form
// ---------------------------------------------------------------------------

function AutomationConfigForm({ automation }: { automation: Automation }): React.JSX.Element {
  const [name, setName] = useState(automation.name)
  const [prompt, setPrompt] = useState(automation.prompt)
  const [cwd, setCwd] = useState(automation.cwd)
  const [schedule, setSchedule] = useState<AutomationSchedule>(automation.schedule)
  const [model, setModel] = useState(automation.model || '')
  const [effort, setEffort] = useState(automation.effort || 'medium')
  const [enabled, setEnabled] = useState(automation.enabled)
  const [allowRules, setAllowRules] = useState<string[]>(automation.permissions.allow)
  const [denyRules, setDenyRules] = useState<string[]>(automation.permissions.deny)
  const [models, setModels] = useState<Array<{ value: string; displayName: string }>>([])
  const [newRule, setNewRule] = useState('')
  const [ruleType, setRuleType] = useState<'allow' | 'deny'>('allow')

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load available models
  useEffect(() => {
    window.api.getModels().then(setModels)
  }, [])

  // Auto-save with debounce
  const save = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      const updated: Automation = {
        ...automation,
        name,
        prompt,
        cwd,
        schedule,
        model: model || undefined,
        effort: effort || undefined,
        enabled,
        permissions: { allow: allowRules, deny: denyRules }
      }
      window.api.saveAutomation(updated)
    }, 500)
  }, [automation, name, prompt, cwd, schedule, model, effort, enabled, allowRules, denyRules])

  // Trigger save on any change
  useEffect(() => {
    save()
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current) }
  }, [save])

  const handlePickFolder = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) setCwd(folder)
  }

  const handleToggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    window.api.toggleAutomation(automation.id, next)
  }

  const runs = useAutomationStore((s) => s.runs[automation.id])
  const hasRunningRun = runs?.some((r) => r.status === 'running') ?? false

  const handleRunNow = (): void => {
    if (hasRunningRun) {
      window.api.cancelAutomationRun(automation.id)
    } else {
      window.api.runAutomationNow(automation.id)
    }
  }

  const handleDelete = (): void => {
    if (confirm(`Delete "${name}"? This cannot be undone.`)) {
      window.api.deleteAutomation(automation.id)
      useAutomationStore.getState().selectAutomation(null)
    }
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
      {/* Name */}
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-accent transition-colors"
          placeholder="My Automation"
        />
      </Field>

      {/* Prompt */}
      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-text-accent transition-colors resize-y font-mono"
          placeholder="What should Claude do when this automation runs?"
        />
      </Field>

      {/* Working Directory */}
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

      {/* Schedule */}
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

      {/* Model + Effort */}
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
      </div>

      {/* Permissions */}
      <Field label="Permissions">
        <div className="space-y-2">
          {/* Allow rules */}
          <div>
            <span className="text-[10px] text-green-400 uppercase font-semibold">Allow</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {allowRules.map((rule, idx) => (
                <PermissionPill key={idx} rule={rule} variant="allow" onRemove={() => removeAllowRule(idx)} />
              ))}
              {allowRules.length === 0 && <span className="text-xs text-text-muted italic">None</span>}
            </div>
          </div>

          {/* Deny rules */}
          <div>
            <span className="text-[10px] text-red-400 uppercase font-semibold">Deny</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {denyRules.map((rule, idx) => (
                <PermissionPill key={idx} rule={rule} variant="deny" onRemove={() => removeDenyRule(idx)} />
              ))}
              {denyRules.length === 0 && <span className="text-xs text-text-muted italic">None</span>}
            </div>
          </div>

          {/* Add rule */}
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

          {/* Quick-add templates */}
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
      </Field>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2 border-t border-border/20">
        {/* Enable toggle */}
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

        {/* Run Now / Stop */}
        <button
          onClick={handleRunNow}
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

        {/* Delete */}
        <button
          onClick={handleDelete}
          className="px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-text-muted mb-1">{label}</label>
      {children}
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
