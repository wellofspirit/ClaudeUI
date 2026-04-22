import { useState, useEffect, useMemo, useRef } from 'react'
import type { Automation, AutomationSchedule, AutomationRun, ClaudePermissions } from '../../../../../shared/types'
import type { DetailTab } from '../../../stores/automation-store'
import {
  PERMISSION_TEMPLATES, PERMISSION_MODES, isAutomationDirty,
  type IntervalUnit, type StatusKind,
  unitMultiplier, naturalUnit, computeNextRuns,
  formatScheduleSummary, deriveStatus,
} from './utils'
import {
  ModelPicker,
  EffortPicker,
  ThinkingPicker,
  type ModelDisplay,
} from '../../shared/InlinePickers'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
  modelSupportedEffortLevels,
  modelDefaultEffort,
  modelDefaultThinkingMode,
  modelResolveThinkingMode,
  modelResolveEffort,
  type EffortLevel,
  type ThinkingMode,
} from '../../../../../shared/model-capabilities'

export type ModelOption = ModelDisplay

export interface InheritedPerms {
  allow: string[]
  deny: string[]
}

export interface AutomationConfigViewProps {
  automation: Automation
  models: ModelOption[]
  globalPerms: InheritedPerms | null
  hasRunningRun: boolean
  runs: AutomationRun[] | undefined
  detailTab: DetailTab
  loadDirPerms: (cwd: string) => Promise<InheritedPerms | null>
  onSave: (updated: Automation) => void
  onToggleEnabled: (enabled: boolean) => void
  onDelete: () => void
  onRunNow: () => void
  onStopRun: () => void
  onPickFolder: () => Promise<string | null>
  onSelectRun: (runId: string) => void
  onSetDetailTab: (tab: DetailTab) => void
}

export function AutomationConfigView(props: AutomationConfigViewProps): React.JSX.Element {
  const {
    automation, models, globalPerms, hasRunningRun, runs, detailTab, loadDirPerms,
    onSave, onToggleEnabled, onDelete, onRunNow, onStopRun, onPickFolder, onSelectRun, onSetDetailTab,
  } = props

  // Form state
  const [name, setName] = useState(automation.name)
  const [nameEditing, setNameEditing] = useState(false)
  const [prompt, setPrompt] = useState(automation.prompt)
  const [cwd, setCwd] = useState(automation.cwd)
  const [schedule, setSchedule] = useState<AutomationSchedule>(automation.schedule)
  const [model, setModel] = useState(automation.model || '')
  const [effort, setEffort] = useState<EffortLevel | ''>((automation.effort as EffortLevel | undefined) ?? '')
  const [thinkingMode, setThinkingModeState] = useState<ThinkingMode | ''>(automation.thinkingMode ?? '')
  const [permissionMode, setPermissionMode] = useState(automation.permissionMode || 'auto')
  const [enabled, setEnabled] = useState(automation.enabled)
  const [allowRules, setAllowRules] = useState<string[]>(automation.permissions.allow)
  const [denyRules, setDenyRules] = useState<string[]>(automation.permissions.deny)
  const [newRule, setNewRule] = useState('')
  const [ruleType, setRuleType] = useState<'allow' | 'deny'>('allow')
  const [dirPerms, setDirPerms] = useState<InheritedPerms | null>(null)

  const selectedModel = useMemo<ModelDisplay>(() => {
    const match = models.find((m) => m.value === model)
    if (match) return match
    if (models.length > 0) return models[0]
    return { value: '', displayName: 'Default', shortName: 'Default' }
  }, [models, model])

  const adaptiveSupported = useMemo(() => modelSupportsAdaptiveThinking(selectedModel), [selectedModel])
  const effortSupported = useMemo(() => modelSupportsEffort(selectedModel), [selectedModel])
  const allowedEffortLevels = useMemo(() => modelSupportedEffortLevels(selectedModel), [selectedModel])
  const effectiveEffort = useMemo<EffortLevel>(
    () => (effort || modelDefaultEffort(selectedModel)),
    [effort, selectedModel],
  )
  const effectiveThinking = useMemo<ThinkingMode>(
    () => (thinkingMode || modelDefaultThinkingMode(selectedModel)),
    [thinkingMode, selectedModel],
  )

  const isDirty = useMemo(
    () => isAutomationDirty({ name, prompt, cwd, schedule, model, effort, thinkingMode, permissionMode, allowRules, denyRules }, automation),
    [name, prompt, cwd, schedule, model, effort, thinkingMode, permissionMode, allowRules, denyRules, automation],
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
      thinkingMode: thinkingMode || undefined,
      permissionMode: permissionMode as 'default' | 'auto',
      enabled,
      permissions: { allow: allowRules, deny: denyRules },
    }
    onSave(updated)
  }

  const handleSelectModel = (value: string): void => {
    setModel(value)
    const nextModel = models.find((m) => m.value === value)
    if (!nextModel) return
    if (effort) {
      const coerced = modelResolveEffort(nextModel, effort as EffortLevel)
      if (coerced === null) setEffort('')
      else if (coerced !== effort) setEffort(coerced)
    }
    if (thinkingMode) {
      const coerced = modelResolveThinkingMode(nextModel, thinkingMode as ThinkingMode)
      if (coerced !== thinkingMode) setThinkingModeState(coerced)
    }
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

  const commitName = (): void => {
    setNameEditing(false)
    if (name.trim() === '') setName(automation.name)
  }

  // ── Derived header values ────────────────────────────────────────
  const statusKind = deriveStatus({ enabled, hasRunningRun, lastRunStatus: automation.lastRunStatus })
  const scheduleSummary = formatScheduleSummary(schedule)
  const lastRunLine = formatLastRunLine(automation, hasRunningRun)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: title + status + actions */}
      <header className="px-6 pt-5 pb-4 border-b border-border/30 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 mb-1.5 group">
              {nameEditing ? (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitName()
                    if (e.key === 'Escape') { setName(automation.name); setNameEditing(false) }
                  }}
                  className="text-[15px] font-semibold tracking-tight bg-bg-tertiary border border-border/40 rounded px-1.5 py-0.5 text-text-primary outline-none focus:border-text-accent min-w-0 flex-1"
                />
              ) : (
                <>
                  <h3
                    onClick={() => setNameEditing(true)}
                    className="text-[15px] font-semibold tracking-tight text-text-primary cursor-text hover:text-text-accent transition-colors truncate"
                    title="Click to rename"
                  >
                    {name || 'Untitled automation'}
                  </h3>
                  <button
                    onClick={() => setNameEditing(true)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary shrink-0"
                    title="Rename"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                </>
              )}
            </div>
            <div className="text-[12px] text-text-muted flex items-center gap-2 flex-wrap">
              <StatusInline status={statusKind} />
              <span className="text-border-bright">·</span>
              <span>{scheduleSummary}</span>
              {lastRunLine && <><span className="text-border-bright">·</span><span>{lastRunLine}</span></>}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleToggleEnabled}
              className="flex items-center gap-2 text-xs text-text-muted pr-3 border-r border-border/30"
              title={enabled ? 'Disable automation' : 'Enable automation'}
            >
              <span>{enabled ? 'Enabled' : 'Disabled'}</span>
              <Toggle on={enabled} />
            </button>
            <button
              onClick={hasRunningRun ? onStopRun : onRunNow}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md border transition-colors ${
                hasRunningRun
                  ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
                  : 'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20'
              }`}
            >
              {hasRunningRun ? (
                <><span className="text-[10px] leading-none">■</span>Stop</>
              ) : (
                <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>
                  Run now
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="px-6 border-b border-border/30 shrink-0">
        <div className="flex gap-1 pt-2.5">
          <TabButton active={detailTab === 'configure'} onClick={() => onSetDetailTab('configure')}>Configure</TabButton>
          <TabButton active={detailTab === 'runs'} onClick={() => onSetDetailTab('runs')}>
            Runs{runs && runs.length > 0 && <span className="ml-1.5 text-text-muted">{runs.length}</span>}
          </TabButton>
          <TabButton active={detailTab === 'permissions'} onClick={() => onSetDetailTab('permissions')}>
            Permissions
            {(allowRules.length + denyRules.length) > 0 && (
              <span className="ml-1.5 text-text-muted">{allowRules.length + denyRules.length}</span>
            )}
          </TabButton>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {detailTab === 'configure' && (
          <ConfigurePanel
            prompt={prompt} setPrompt={setPrompt}
            schedule={schedule} setSchedule={setSchedule}
            lastRunAt={automation.lastRunAt}
            cwd={cwd} setCwd={setCwd} onBrowseFolder={handlePickFolder}
            models={models} selectedModel={selectedModel} onSelectModel={handleSelectModel}
            thinkingMode={effectiveThinking} onSelectThinking={(m) => setThinkingModeState(m)} adaptiveSupported={adaptiveSupported}
            effort={effectiveEffort} onSelectEffort={(l) => setEffort(l)} effortSupported={effortSupported} allowedEffortLevels={allowedEffortLevels}
            permissionMode={permissionMode} setPermissionMode={setPermissionMode}
            isDirty={isDirty} onSave={handleSave} onDelete={onDelete}
          />
        )}
        {detailTab === 'runs' && (
          <RunsPanel runs={runs} onSelectRun={onSelectRun} onRunNow={onRunNow} hasRunningRun={hasRunningRun} />
        )}
        {detailTab === 'permissions' && (
          <PermissionsPanel
            allowRules={allowRules} denyRules={denyRules}
            onRemoveAllow={removeAllowRule} onRemoveDeny={removeDenyRule}
            newRule={newRule} setNewRule={setNewRule}
            ruleType={ruleType} setRuleType={setRuleType}
            onAddRule={addRule}
            onAddTemplate={(t) => setAllowRules([...allowRules, t])}
            globalPerms={globalPerms}
            dirPerms={dirPerms}
            permissionMode={permissionMode}
            setPermissionMode={setPermissionMode}
            isDirty={isDirty} onSave={handleSave}
          />
        )}
      </div>
    </div>
  )
}

// ── Configure tab content ──────────────────────────────────────────

interface ConfigurePanelProps {
  prompt: string; setPrompt: (v: string) => void
  schedule: AutomationSchedule; setSchedule: (s: AutomationSchedule) => void
  lastRunAt: number | null
  cwd: string; setCwd: (v: string) => void; onBrowseFolder: () => void
  models: ModelOption[]; selectedModel: ModelDisplay; onSelectModel: (v: string) => void
  thinkingMode: ThinkingMode; onSelectThinking: (m: ThinkingMode) => void; adaptiveSupported: boolean
  effort: EffortLevel; onSelectEffort: (l: EffortLevel) => void; effortSupported: boolean; allowedEffortLevels: EffortLevel[]
  permissionMode: string; setPermissionMode: (v: 'default' | 'auto') => void
  isDirty: boolean; onSave: () => void; onDelete: () => void
}

function ConfigurePanel(p: ConfigurePanelProps): React.JSX.Element {
  const {
    prompt, setPrompt, schedule, setSchedule, lastRunAt, cwd, setCwd, onBrowseFolder,
    models, selectedModel, onSelectModel, thinkingMode, onSelectThinking, adaptiveSupported,
    effort, onSelectEffort, effortSupported, allowedEffortLevels,
    permissionMode, setPermissionMode, isDirty, onSave, onDelete,
  } = p

  const nextRuns = useMemo(() => computeNextRuns(schedule, lastRunAt, 4), [schedule, lastRunAt])

  // Sticky unit for the interval editor — if we derived it every render, typing
  // "60" (minutes) would snap to "1 hour" and you couldn't edit freely.
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(() =>
    schedule.type === 'interval' ? naturalUnit(schedule.intervalMs ?? 900_000) : 'minutes',
  )
  const intervalValue = schedule.type === 'interval'
    ? Math.max(1, Math.round((schedule.intervalMs ?? 900_000) / unitMultiplier(intervalUnit)))
    : 1
  const setIntervalValue = (n: number): void => {
    const clamped = Math.max(1, Math.floor(n) || 1)
    setSchedule({ type: 'interval', intervalMs: clamped * unitMultiplier(intervalUnit) })
  }
  const changeIntervalUnit = (u: IntervalUnit): void => {
    setIntervalUnit(u)
    setSchedule({ type: 'interval', intervalMs: intervalValue * unitMultiplier(u) })
  }

  return (
    <>
      {/* Prompt hero */}
      <section className="px-6 pt-5 pb-6">
        <div className="flex items-baseline justify-between mb-2.5">
          <SectionLabel>Prompt</SectionLabel>
          <span className="text-[10px] text-text-muted font-mono">{prompt.length.toLocaleString()} chars</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="w-full bg-bg-tertiary border border-border/40 rounded-lg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-text-accent/60 transition-colors resize-y leading-relaxed"
          placeholder="What should Claude do when this automation runs?"
        />
      </section>

      {/* Trigger */}
      <section className="px-6 py-5 border-t border-border/30">
        <SectionHeader icon="clock">Trigger</SectionHeader>

        <InspectorRow label="Schedule">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex gap-0.5 p-0.5 rounded-md border border-border/40 bg-bg-input shrink-0">
              <SegButton active={schedule.type === 'interval'} onClick={() => setSchedule({ type: 'interval', intervalMs: schedule.intervalMs ?? 15 * 60_000 })}>Interval</SegButton>
              <SegButton active={schedule.type === 'cron'} onClick={() => setSchedule({ type: 'cron', cronExpression: schedule.cronExpression ?? '*/15 * * * *' })}>Cron</SegButton>
            </div>
            {schedule.type === 'cron' ? (
              <input
                value={schedule.cronExpression || ''}
                onChange={(e) => setSchedule({ type: 'cron', cronExpression: e.target.value })}
                className="flex-1 bg-bg-tertiary border border-border/40 rounded-md px-3 py-1.5 text-[13px] font-mono text-text-primary outline-none focus:border-text-accent/60 transition-colors"
                placeholder="*/15 * * * *"
              />
            ) : (
              <>
                <span className="text-[13px] text-text-secondary ml-1">Every</span>
                <div className="inline-flex items-stretch bg-bg-tertiary border border-border/40 rounded-md focus-within:border-text-accent/60 transition-colors">
                  <input
                    type="number"
                    min={1}
                    value={intervalValue}
                    onChange={(e) => setIntervalValue(Number(e.target.value))}
                    className="w-16 px-2.5 py-1 bg-transparent text-[13px] font-mono text-text-primary outline-none text-right rounded-l-md [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <div className="w-px self-stretch bg-border/40" />
                  <UnitDropdown value={intervalUnit} onChange={changeIntervalUnit} />
                </div>
              </>
            )}
          </div>

          <NextRunsRow runs={nextRuns} invalid={schedule.type === 'cron' && !!schedule.cronExpression && nextRuns.length === 0} />
        </InspectorRow>
      </section>

      {/* Environment */}
      <section className="px-6 py-5 border-t border-border/30">
        <SectionHeader icon="folder">Environment</SectionHeader>

        <InspectorRow label="Directory">
          <div className="flex items-center gap-2 bg-bg-tertiary border border-border/40 rounded-md px-2.5 py-1 focus-within:border-text-accent/60 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted shrink-0">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              className="flex-1 bg-transparent text-[13px] font-mono text-text-primary outline-none min-w-0"
              placeholder="/path/to/project"
            />
            <button
              onClick={onBrowseFolder}
              className="text-[11px] text-text-muted hover:text-text-secondary px-2 py-0.5 rounded border border-border/40 hover:bg-bg-hover transition-colors shrink-0"
            >
              Browse
            </button>
          </div>
        </InspectorRow>
      </section>

      {/* Execution */}
      <section className="px-6 py-5 border-t border-border/30">
        <SectionHeader icon="bolt">Execution</SectionHeader>

        <InspectorRow label="Model">
          <div className="inline-flex items-center flex-wrap gap-0.5">
            <ModelPicker models={models} selectedModel={selectedModel} onSelectModel={onSelectModel} />
            <ThinkingPicker thinkingMode={thinkingMode} adaptiveSupported={adaptiveSupported} onSelectThinking={onSelectThinking} />
            <EffortPicker effort={effort} allowedEffortLevels={allowedEffortLevels} supported={effortSupported} onSelectEffort={onSelectEffort} />
          </div>
        </InspectorRow>

        <InspectorRow label="Mode">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-0.5 p-0.5 rounded-md border border-border/40 bg-bg-input shrink-0">
              {PERMISSION_MODES.map((mode) => (
                <SegButton
                  key={mode.value}
                  active={permissionMode === mode.value}
                  onClick={() => setPermissionMode(mode.value)}
                >
                  {mode.label}
                </SegButton>
              ))}
            </div>
            <span className="text-[12px] text-text-muted">
              {PERMISSION_MODES.find((m) => m.value === permissionMode)?.description}
            </span>
          </div>
        </InspectorRow>
      </section>

      {/* Footer */}
      <div className="px-6 py-3.5 border-t border-border/30 flex items-center justify-between bg-bg-secondary sticky bottom-0">
        <button
          onClick={onSave}
          disabled={!isDirty}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors ${
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
          onClick={onDelete}
          className="px-3 py-1.5 text-xs text-red-400 border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 rounded-md transition-colors"
        >
          Delete automation
        </button>
      </div>
    </>
  )
}

// ── Runs tab content ──────────────────────────────────────────

function RunsPanel({
  runs, onSelectRun, onRunNow, hasRunningRun,
}: { runs: AutomationRun[] | undefined; onSelectRun: (id: string) => void; onRunNow: () => void; hasRunningRun: boolean }): React.JSX.Element {
  if (!runs) {
    return <div className="p-8 text-center text-xs text-text-muted">Loading runs…</div>
  }
  if (runs.length === 0) {
    return (
      <div className="p-10 text-center">
        <div className="text-sm text-text-secondary mb-1">No runs yet</div>
        <div className="text-xs text-text-muted mb-4">Run this automation now, or wait for its next scheduled run.</div>
        <button
          onClick={onRunNow}
          disabled={hasRunningRun}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>
          Run now
        </button>
      </div>
    )
  }

  return (
    <div className="py-2">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} onClick={() => onSelectRun(run.id)} />
      ))}
    </div>
  )
}

function RunRow({ run, onClick }: { run: AutomationRun; onClick: () => void }): React.JSX.Element {
  const time = new Date(run.startedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  const duration = run.finishedAt ? formatMs(run.finishedAt - run.startedAt) : 'running'
  const cost = run.totalCostUsd > 0 ? `$${run.totalCostUsd.toFixed(4)}` : null
  const statusConfig =
    run.status === 'success' ? { bg: 'bg-green-500/15', fg: 'text-green-400', label: '✓' } :
    run.status === 'error' ? { bg: 'bg-red-500/15', fg: 'text-red-400', label: '✕' } :
    { bg: 'bg-blue-500/15', fg: 'text-blue-400', label: '●' }

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-6 py-2.5 flex items-center gap-3 hover:bg-bg-hover/50 transition-colors group"
    >
      <span className={`w-5 h-5 rounded-md flex items-center justify-center text-[11px] font-semibold ${statusConfig.bg} ${statusConfig.fg} shrink-0`}>
        {statusConfig.label}
      </span>
      <span className="text-[13px] text-text-primary shrink-0 w-[130px]">{time}</span>
      <span className="text-[12px] text-text-muted font-mono shrink-0 w-[70px]">{duration}</span>
      {cost && <span className="text-[12px] text-text-muted font-mono shrink-0">{cost}</span>}
      {run.resultSummary && (
        <span className="text-[12px] text-text-muted truncate flex-1 ml-2">{run.resultSummary}</span>
      )}
      {run.error && (
        <span className="text-[12px] text-red-400/80 truncate flex-1 ml-2">{run.error}</span>
      )}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-auto">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  )
}

// ── Permissions tab content ──────────────────────────────────────

interface PermissionsPanelProps {
  allowRules: string[]; denyRules: string[]
  onRemoveAllow: (idx: number) => void; onRemoveDeny: (idx: number) => void
  newRule: string; setNewRule: (v: string) => void
  ruleType: 'allow' | 'deny'; setRuleType: (v: 'allow' | 'deny') => void
  onAddRule: () => void; onAddTemplate: (t: string) => void
  globalPerms: InheritedPerms | null
  dirPerms: InheritedPerms | null
  permissionMode: string
  setPermissionMode: (v: 'default' | 'auto') => void
  isDirty: boolean; onSave: () => void
}

function PermissionsPanel(p: PermissionsPanelProps): React.JSX.Element {
  const {
    allowRules, denyRules, onRemoveAllow, onRemoveDeny,
    newRule, setNewRule, ruleType, setRuleType, onAddRule, onAddTemplate,
    globalPerms, dirPerms, permissionMode, setPermissionMode,
    isDirty, onSave,
  } = p

  return (
    <>
      <section className="px-6 py-5">
        <SectionHeader icon="shield">Mode</SectionHeader>
        <div className="flex gap-1.5">
          {PERMISSION_MODES.map((mode) => (
            <button
              key={mode.value}
              onClick={() => setPermissionMode(mode.value)}
              className={`flex-1 px-3 py-2 text-left text-xs rounded-md border transition-colors ${
                permissionMode === mode.value
                  ? 'bg-bg-hover border-text-accent/50 text-text-primary'
                  : 'border-border/40 text-text-muted hover:bg-bg-hover'
              }`}
            >
              <div className="font-semibold text-[13px]">{mode.label}</div>
              <div className="text-[11px] text-text-muted mt-0.5">{mode.description}</div>
            </button>
          ))}
        </div>
      </section>

      {(globalPerms || dirPerms) && (
        <section className="px-6 py-5 border-t border-border/30 space-y-2.5">
          <SectionHeader icon="link">Inherited</SectionHeader>
          {globalPerms && <InheritedBlock label="User settings" perms={globalPerms} />}
          {dirPerms && <InheritedBlock label="Project / local settings" perms={dirPerms} />}
        </section>
      )}

      <section className="px-6 py-5 border-t border-border/30">
        <SectionHeader icon="check">Allow</SectionHeader>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {allowRules.map((rule, idx) => (
            <Pill key={idx} variant="allow" onRemove={() => onRemoveAllow(idx)}>{rule}</Pill>
          ))}
          {allowRules.length === 0 && <span className="text-xs text-text-muted italic">No rules set</span>}
        </div>
      </section>

      <section className="px-6 py-5 border-t border-border/30">
        <SectionHeader icon="x">Deny</SectionHeader>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {denyRules.map((rule, idx) => (
            <Pill key={idx} variant="deny" onRemove={() => onRemoveDeny(idx)}>{rule}</Pill>
          ))}
          {denyRules.length === 0 && <span className="text-xs text-text-muted italic">No rules set</span>}
        </div>
      </section>

      <section className="px-6 py-5 border-t border-border/30">
        <SectionHeader icon="plus">Add rule</SectionHeader>
        <div className="flex gap-2 items-center">
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as 'allow' | 'deny')}
            className="bg-bg-tertiary border border-border/40 rounded-md px-2 py-1 text-xs text-text-primary"
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          <input
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAddRule()}
            className="flex-1 bg-bg-tertiary border border-border/40 rounded-md px-2.5 py-1 text-xs font-mono text-text-primary outline-none focus:border-text-accent/60"
            placeholder="e.g., Bash(command:*)"
            list="permission-templates"
          />
          <datalist id="permission-templates">
            {PERMISSION_TEMPLATES.map((t) => <option key={t} value={t} />)}
          </datalist>
          <button
            onClick={onAddRule}
            className="px-3 py-1 text-xs bg-bg-tertiary border border-border/40 rounded-md hover:bg-bg-hover transition-colors text-text-secondary"
          >
            Add
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-3">
          {PERMISSION_TEMPLATES.slice(0, 6).map((t) => {
            const isAllowed = allowRules.includes(t)
            const isDenied = denyRules.includes(t)
            if (isAllowed || isDenied) return null
            return (
              <button
                key={t}
                onClick={() => onAddTemplate(t)}
                className="px-2 py-0.5 text-[11px] font-mono rounded border border-border/40 text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors"
              >
                + {t}
              </button>
            )
          })}
        </div>
      </section>

      {/* Footer */}
      <div className="px-6 py-3.5 border-t border-border/30 flex items-center justify-between bg-bg-secondary sticky bottom-0">
        <button
          onClick={onSave}
          disabled={!isDirty}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border transition-colors ${
            isDirty
              ? 'bg-text-accent/15 border-text-accent/40 text-text-accent hover:bg-text-accent/25'
              : 'bg-bg-tertiary border-border/40 text-text-muted cursor-not-allowed opacity-50'
          }`}
        >
          {isDirty ? 'Save' : 'Saved'}
        </button>
      </div>
    </>
  )
}

// ── Shared helpers ────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{children}</span>
}

function SectionHeader({ icon, children }: { icon: 'clock' | 'folder' | 'bolt' | 'shield' | 'link' | 'check' | 'x' | 'plus'; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-4">
      <SectionIcon name={icon} />
      <SectionLabel>{children}</SectionLabel>
    </div>
  )
}

function SectionIcon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.ReactNode> = {
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
    bolt: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
      {paths[name]}
    </svg>
  )
}

function InspectorRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-5 mb-3 last:mb-0">
      <label className="text-[13px] text-text-secondary pt-1.5 w-24 shrink-0">{label}</label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-[13px] rounded-md transition-colors ${
        active ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`text-[12px] px-2.5 py-1 rounded transition-colors ${
        active ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}

function UnitDropdown({ value, onChange }: { value: IntervalUnit; onChange: (u: IntervalUnit) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const options: Array<{ value: IntervalUnit; label: string }> = [
    { value: 'minutes', label: 'min' },
    { value: 'hours', label: 'hr' },
    { value: 'days', label: 'day' },
  ]
  const current = options.find((o) => o.value === value)!

  return (
    <div ref={ref} className="relative flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 pl-2.5 pr-2 py-1 text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer outline-none rounded-r-md"
      >
        <span>{current.label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-24 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full flex items-center px-3 h-8 text-[12px] transition-colors text-left ${
                value === opt.value ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover/60'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Toggle({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span className={`relative inline-block w-7 h-4 rounded-full transition-colors ${on ? 'bg-green-500' : 'bg-gray-600'}`}>
      <span
        className="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform"
        style={{ transform: on ? 'translateX(12px)' : 'translateX(0)' }}
      />
    </span>
  )
}

function StatusInline({ status }: { status: StatusKind }): React.JSX.Element {
  const cfg = {
    running: { label: 'running', text: 'text-green-400', dot: 'bg-green-400 ring-2 ring-green-400/20' },
    active: { label: 'active', text: 'text-green-400/90', dot: 'bg-green-400' },
    disabled: { label: 'disabled', text: 'text-text-muted', dot: 'bg-gray-500' },
    failed: { label: 'failed', text: 'text-red-400', dot: 'bg-red-400' },
  }[status]
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      <span className={cfg.text}>{cfg.label}</span>
    </span>
  )
}

function Pill({ variant, onRemove, children }: { variant: 'allow' | 'deny'; onRemove: () => void; children: React.ReactNode }): React.JSX.Element {
  const cls = variant === 'allow'
    ? 'bg-green-500/10 border-green-500/20 text-green-400'
    : 'bg-red-500/10 border-red-500/20 text-red-400'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full border ${cls}`}>
      {children}
      <button onClick={onRemove} className="hover:text-text-primary ml-0.5 -mr-1 px-1" aria-label="Remove">&times;</button>
    </span>
  )
}

function InheritedBlock({ label, perms }: { label: string; perms: InheritedPerms }): React.JSX.Element {
  return (
    <div className="bg-bg-tertiary/40 rounded-md px-3 py-2 space-y-1.5">
      <span className="text-[10px] text-text-muted uppercase font-semibold tracking-wider">{label}</span>
      {perms.allow.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {perms.allow.map((rule, idx) => (
            <span key={idx} className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono rounded-full border bg-green-500/5 border-green-500/15 text-green-400/70">
              {rule}
            </span>
          ))}
        </div>
      )}
      {perms.deny.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {perms.deny.map((rule, idx) => (
            <span key={idx} className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono rounded-full border bg-red-500/5 border-red-500/15 text-red-400/70">
              {rule}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Format helpers ────────────────────────────────────────────────

function formatLastRunLine(automation: Automation, hasRunningRun: boolean): string | null {
  if (hasRunningRun) return 'running now'
  if (!automation.lastRunAt) return 'never run'
  const ago = formatRelative(automation.lastRunAt)
  const status = automation.lastRunStatus === 'error' ? 'failed' : 'succeeded'
  return `last ${status} ${ago}`
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function formatUpcoming(d: Date): string {
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
  return d.toLocaleString(undefined, opts)
}

function NextRunsRow({ runs, invalid }: { runs: Date[]; invalid: boolean }): React.JSX.Element | null {
  if (invalid) {
    return <div className="text-[11px] text-red-400/80">Invalid cron expression</div>
  }
  if (runs.length === 0) return null
  const next = runs[0]
  const diff = next.getTime() - Date.now()
  const inStr = diff < 60_000 ? 'soon' : diff < 3_600_000 ? `${Math.round(diff / 60_000)}m` : diff < 86_400_000 ? `${Math.round(diff / 3_600_000)}h` : `${Math.round(diff / 86_400_000)}d`
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">next in</span>
      <span className="text-[11px] font-mono text-green-400">{inStr}</span>
      <span className="text-border-bright mx-0.5">·</span>
      {runs.map((d, i) => (
        <span
          key={i}
          className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${
            i === 0
              ? 'bg-green-500/5 border-green-500/20 text-green-400/90'
              : 'border-border/30 text-text-muted'
          }`}
        >
          {formatUpcoming(d)}
        </span>
      ))}
    </div>
  )
}

// Keep type export for tests that import it
export type { ClaudePermissions }
