/**
 * OpencodeAgents — full CRUD UI for opencode custom and built-in agents.
 *
 * Renders inside the Settings › Agents section. Self-gates on opencode
 * installation. Supports creating, editing, disabling, resetting, and
 * deleting agents with scope (global / project), mode, model, system
 * prompt, tool permissions, advanced params, and appearance settings.
 */

import { useState, useEffect } from 'react'
import type { OpencodeAgentScope, OpencodeAgentSummary, OpencodeAgentDetail, OpencodeAgentInput, OpencodeAgentMode, ModelInfo } from '../../../../shared/types'
import { useActiveSession } from '../../stores/session-store'
import { SettingsSlider } from './settings-controls'
import { SelectMenu } from '../shared/SelectMenu'

// ── useOpencodeInstalled ─────────────────────────────────────────────

function useOpencodeInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api
      .engineIsInstalled('opencode')
      .then((v) => { if (!cancelled) setInstalled(v) })
      .catch(() => { if (!cancelled) setInstalled(false) })
    return () => { cancelled = true }
  }, [])
  return installed
}

// ── Shared inputClass ────────────────────────────────────────────────

const inputClass =
  'bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

// ── View state machine ───────────────────────────────────────────────

type ViewState =
  | { mode: 'list' }
  | { mode: 'edit'; name: string; scope: OpencodeAgentScope }
  | { mode: 'new' }

// ── Permission tool categories ───────────────────────────────────────

const PERM_CATS = ['bash', 'edit', 'read', 'glob', 'grep', 'webfetch', 'task', 'websearch', 'todowrite', 'lsp', 'skill'] as const
type PermAction = 'allow' | 'ask' | 'deny'

// ── Preset colors ────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#f59e0b', // amber
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#4ade80', // green
  '#f87171', // red
  '#60a5fa', // blue
]

// ── Draft form state ─────────────────────────────────────────────────

interface Draft {
  name: string
  scope: OpencodeAgentScope
  mode: OpencodeAgentMode
  model: string // '' = inherit
  description: string
  prompt: string
  temperature: number | null
  topP: string // string input for optional number
  steps: string // string input for optional number
  reasoningEffort: string // '' = default
  color: string // '' = none
  hidden: boolean
  // permission
  restrict: boolean
  permGrid: Partial<Record<string, PermAction>>
}

const BLANK_DRAFT: Draft = {
  name: '',
  scope: 'global',
  mode: 'primary',
  model: '',
  description: '',
  prompt: '',
  temperature: null,
  topP: '',
  steps: '',
  reasoningEffort: '',
  color: '',
  hidden: false,
  restrict: false,
  permGrid: {},
}

function detailToDraft(detail: OpencodeAgentDetail): Draft {
  return {
    name: detail.name,
    scope: detail.scope ?? 'global',
    mode: detail.mode,
    model: detail.model ?? '',
    description: detail.description ?? '',
    prompt: detail.prompt ?? '',
    temperature: detail.temperature ?? null,
    topP: detail.topP !== undefined ? String(detail.topP) : '',
    steps: detail.steps !== undefined ? String(detail.steps) : '',
    reasoningEffort: detail.reasoningEffort ?? '',
    color: detail.color ?? '',
    hidden: detail.hidden ?? false,
    restrict: detail.restrict,
    permGrid: { ...(detail.permission ?? {}) },
  }
}

// ── Mode badge colors ────────────────────────────────────────────────

function ModeBadge({ mode }: { mode: OpencodeAgentMode }): React.JSX.Element {
  const colors: Record<OpencodeAgentMode, string> = {
    primary: 'bg-amber-500/15 text-amber-400',
    subagent: 'bg-blue-500/15 text-blue-400',
    all: 'bg-purple-500/15 text-purple-400',
  }
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide ${colors[mode]}`}>
      {mode}
    </span>
  )
}

// ── List view ────────────────────────────────────────────────────────

interface ListViewProps {
  cwd: string
  refresh: number
  onEdit: (name: string, scope: OpencodeAgentScope) => void
  onNew: () => void
}

function ListView({ cwd, refresh, onEdit, onNew }: ListViewProps): React.JSX.Element {
  const [agents, setAgents] = useState<OpencodeAgentSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .listOpencodeAgents(cwd || undefined)
      .then((list) => { if (!cancelled) { setAgents(list); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cwd, refresh])

  const custom = agents.filter((a) => a.kind === 'custom')
  const builtin = agents.filter((a) => a.kind === 'builtin')

  if (loading) {
    return <div className="px-3 py-2 text-[12px] text-text-muted">Loading agents…</div>
  }

  const renderRow = (a: OpencodeAgentSummary): React.JSX.Element => (
    <button
      key={`${a.kind}-${a.name}`}
      data-testid="OpencodeAgentsSection.agentRow"
      data-id={a.name}
      onClick={() => onEdit(a.name, a.scope ?? 'global')}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover rounded transition-colors cursor-default ${a.disabled ? 'opacity-55' : ''}`}
    >
      {/* Color dot */}
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: a.color || '#6b7280' }}
      />

      {/* Name */}
      <span className={`text-[12px] text-text-secondary flex-1 min-w-0 truncate ${a.disabled ? 'line-through' : ''}`}>
        {a.name}
      </span>

      {/* Badges */}
      <span className="flex items-center gap-1 shrink-0">
        <ModeBadge mode={a.mode} />

        {a.kind === 'custom' && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide ${
            (a.scope ?? 'global') === 'global'
              ? 'bg-gray-500/15 text-gray-400'
              : 'bg-purple-500/15 text-purple-400'
          }`}>
            {a.scope ?? 'global'}
          </span>
        )}

        {a.overridden && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-green-500/15 text-green-400 uppercase tracking-wide">
            overridden
          </span>
        )}

        {a.disabled && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-red-500/15 text-red-400 uppercase tracking-wide">
            disabled
          </span>
        )}
      </span>

      {/* Model sub-text */}
      {a.model && (
        <span className="text-[10px] text-text-muted/60 shrink-0 max-w-[80px] truncate">
          {a.model}
        </span>
      )}

      {/* Chevron */}
      <span className="text-text-muted/40 text-[10px] shrink-0">›</span>
    </button>
  )

  return (
    <div className="space-y-1">
      {/* New agent button */}
      <div className="px-3 py-1.5 flex items-center justify-between">
        <span className="text-[11px] text-text-muted/60 uppercase tracking-wide">Agents</span>
        <button
          data-testid="OpencodeAgentsSection.newAgent"
          onClick={onNew}
          className="text-[11px] text-accent hover:text-accent/80 transition-colors"
        >
          + New agent
        </button>
      </div>

      {custom.length > 0 && (
        <div>
          <div className="px-3 py-1 text-[10px] text-text-muted/50 uppercase tracking-wide">Custom</div>
          {custom.map(renderRow)}
        </div>
      )}

      {builtin.length > 0 && (
        <div>
          <div className="px-3 py-1 text-[10px] text-text-muted/50 uppercase tracking-wide">Built-in</div>
          {builtin.map(renderRow)}
        </div>
      )}

      {agents.length === 0 && (
        <div className="px-3 py-2 text-[12px] text-text-muted/60">
          No agents found. Create a custom agent or opencode has no built-in agents loaded.
        </div>
      )}
    </div>
  )
}

// ── Permission grid ──────────────────────────────────────────────────

interface PermGridProps {
  grid: Partial<Record<string, PermAction>>
  onChange: (cat: string, action: PermAction) => void
}

function PermGrid({ grid, onChange }: PermGridProps): React.JSX.Element {
  const btnCls = (active: boolean, variant: 'allow' | 'ask' | 'deny'): string => {
    const base = 'w-6 h-5 text-[9px] font-medium rounded transition-colors cursor-default'
    if (!active) return `${base} bg-bg-primary/30 text-text-muted/40 hover:bg-bg-hover`
    if (variant === 'allow') return `${base} bg-green-500/20 text-green-400`
    if (variant === 'ask') return `${base} bg-amber-500/20 text-amber-400`
    return `${base} bg-red-500/20 text-red-400`
  }

  return (
    <div className="space-y-1 mt-1">
      {PERM_CATS.map((cat) => {
        const current = grid[cat] ?? 'allow'
        return (
          <div key={cat} className="flex items-center gap-2">
            <span className="text-[11px] text-text-muted w-24 shrink-0">{cat}</span>
            <div className="flex items-center gap-0.5">
              <button className={btnCls(current === 'allow', 'allow')} onClick={() => onChange(cat, 'allow')} title="Allow">A</button>
              <button className={btnCls(current === 'ask', 'ask')} onClick={() => onChange(cat, 'ask')} title="Ask">?</button>
              <button className={btnCls(current === 'deny', 'deny')} onClick={() => onChange(cat, 'deny')} title="Deny">✕</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Editor view ──────────────────────────────────────────────────────

interface EditorViewProps {
  view: { mode: 'edit'; name: string; scope: OpencodeAgentScope } | { mode: 'new' }
  cwd: string
  onBack: () => void
  onSaved: () => void
}

function EditorView({ view, cwd, onBack, onSaved }: EditorViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT)
  const [detail, setDetail] = useState<OpencodeAgentDetail | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(view.mode === 'edit')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  // Generate-with-AI state
  const [genDesc, setGenDesc] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  useEffect(() => {
    // Load models
    window.api
      .getEngineModels()
      .then((groups) => {
        const oc = groups.filter((g) => g.engineId === 'opencode')
        setModels(oc.flatMap((g) => g.models))
      })
      .catch(() => {})

    // Load detail for edit mode
    if (view.mode === 'edit') {
      window.api
        .readOpencodeAgent(view.name, view.scope, cwd || undefined)
        .then((d) => {
          if (d) {
            setDetail(d)
            setDraft(detailToDraft(d))
          } else {
            setLoadError(true)
          }
          setLoading(false)
        })
        .catch(() => {
          setLoadError(true)
          setLoading(false)
        })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return <div className="px-3 py-2 text-[12px] text-text-muted">Loading agent…</div>
  }
  if (loadError) {
    return (
      <div className="px-3 py-2 text-[12px] text-text-muted/70">
        Failed to load agent.{' '}
        <button onClick={onBack} className="text-accent hover:underline">Go back</button>
      </div>
    )
  }

  const isBuiltin = view.mode === 'edit' && (detail?.kind === 'builtin')
  const isCustom = view.mode === 'edit' && detail?.kind === 'custom'

  // File path hint
  const scopeForHint = draft.scope
  const nameForHint = draft.name || '<name>'
  const filePath = scopeForHint === 'global'
    ? `~/.config/opencode/agents/${nameForHint}.md`
    : `${cwd || '<cwd>'}/.opencode/agents/${nameForHint}.md`

  const update = (patch: Partial<Draft>): void => setDraft((prev) => ({ ...prev, ...patch }))

  const handleGenerate = async (): Promise<void> => {
    if (!genDesc.trim()) return
    setGenerating(true)
    setGenError(null)
    try {
      const result = await window.api.generateOpencodeAgent(genDesc.trim(), cwd || undefined)
      update({
        name: result.identifier || draft.name,
        description: result.whenToUse || draft.description,
        prompt: result.systemPrompt || draft.prompt,
      })
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    // Validate name
    if (!draft.name.trim()) {
      setNameError('Name is required')
      return
    }
    if (!/^[a-z0-9-]+$/.test(draft.name.trim())) {
      setNameError('Name must match [a-z0-9-]+')
      return
    }
    setNameError(null)
    setSaving(true)
    setSaveError(null)

    try {
      const input: OpencodeAgentInput = {
        name: draft.name.trim(),
        scope: draft.scope,
        mode: draft.mode,
      }
      if (draft.model) input.model = draft.model
      if (draft.description) input.description = draft.description
      if (draft.prompt) input.prompt = draft.prompt
      if (draft.temperature !== null) input.temperature = draft.temperature
      const topPNum = draft.topP !== '' ? Number(draft.topP) : NaN
      if (!isNaN(topPNum)) input.topP = topPNum
      const stepsNum = draft.steps !== '' ? Number(draft.steps) : NaN
      if (!isNaN(stepsNum)) input.steps = stepsNum
      if (draft.reasoningEffort) input.reasoningEffort = draft.reasoningEffort
      if (draft.color) input.color = draft.color
      if (draft.hidden) input.hidden = draft.hidden

      // Only include permission when restrict is ON
      if (draft.restrict) {
        const perm: Record<string, PermAction> = {}
        for (const cat of PERM_CATS) {
          perm[cat] = draft.permGrid[cat] ?? 'allow'
        }
        input.permission = perm
      }

      await window.api.saveOpencodeAgent(input, cwd || undefined)
      onSaved()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async (): Promise<void> => {
    if (view.mode !== 'edit') return
    try {
      await window.api.setOpencodeAgentDisabled(
        view.name,
        view.scope,
        cwd || undefined,
        !detail?.disabled
      )
      onSaved()
    } catch (_) { /* ignore */ }
  }

  const handleReset = async (): Promise<void> => {
    if (view.mode !== 'edit') return
    try {
      await window.api.deleteOpencodeAgent(view.name, view.scope, cwd || undefined)
      onSaved()
    } catch (_) { /* ignore */ }
  }

  const handleDelete = async (): Promise<void> => {
    if (view.mode !== 'edit') return
    try {
      await window.api.deleteOpencodeAgent(view.name, view.scope, cwd || undefined)
      onSaved()
    } catch (_) { /* ignore */ }
  }

  const modelOptions = [
    { value: '', label: 'Inherit (session model)' },
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value })),
  ]

  const projectDisabled = !cwd

  return (
    <div className="flex flex-col h-full" data-testid="OpencodeAgentsSection.editor">
      {/* Back link */}
      <div className="px-3 py-1.5 flex items-center gap-1 shrink-0">
        <button
          data-testid="OpencodeAgentsSection.back"
          onClick={onBack}
          className="text-[11px] text-text-muted/60 hover:text-text-secondary transition-colors cursor-default"
        >
          ‹ Agents
        </button>
      </div>

      {/* Scrollable form area */}
      <div className="flex-1 overflow-y-auto space-y-1 pb-2">
        {/* Built-in banner */}
        {isBuiltin && (
          <div className="mx-3 px-2 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded text-[11px] text-amber-400/80 leading-relaxed">
            Overriding built-in <strong>{view.mode === 'edit' ? view.name : ''}</strong> — unset fields use opencode&apos;s defaults.
          </div>
        )}

        {/* Name */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1">Name</div>
          <input
            type="text"
            value={draft.name}
            readOnly={isBuiltin}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="my-agent"
            className={`${inputClass} w-full ${isBuiltin ? 'opacity-60 cursor-default' : ''}`}
          />
          {nameError && (
            <div className="text-[10px] text-red-400 mt-0.5">{nameError}</div>
          )}
          <div className="text-[10px] text-text-muted/50 mt-1 font-mono truncate">{filePath}</div>
        </div>

        {/* Scope */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1">Scope</div>
          <div className="flex items-center gap-0.5 bg-bg-primary/50 rounded-md p-0.5">
            {(['global', 'project'] as OpencodeAgentScope[]).map((s) => (
              <button
                key={s}
                disabled={s === 'project' && projectDisabled}
                onClick={() => update({ scope: s })}
                className={`flex-1 text-[11px] py-1 rounded transition-colors ${
                  draft.scope === s
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {s === 'global' ? 'Global' : 'Project'}
              </button>
            ))}
          </div>
          {draft.scope === 'project' && !cwd && (
            <div className="text-[10px] text-text-muted/50 mt-0.5">Open a project session to use project scope</div>
          )}
        </div>

        {/* Generate with AI */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1 text-[11px] text-text-muted/70 uppercase tracking-wide">Generate with AI</div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={genDesc}
              onChange={(e) => setGenDesc(e.target.value)}
              placeholder="Describe what this agent should do…"
              className={`${inputClass} flex-1`}
              onKeyDown={(e) => { if (e.key === 'Enter' && !generating) void handleGenerate() }}
            />
            <button
              data-testid="OpencodeAgentsSection.generate"
              onClick={() => void handleGenerate()}
              disabled={generating || !genDesc.trim()}
              className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
          {genError && (
            <div className="text-[10px] text-red-400 mt-0.5">{genError}</div>
          )}
        </div>

        {/* Description */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1">Description</div>
          <textarea
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="When to use this agent…"
            rows={2}
            spellCheck={false}
            className={`${inputClass} w-full resize-none`}
          />
        </div>

        {/* Mode */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1">Mode</div>
          <div className="flex items-center gap-0.5 bg-bg-primary/50 rounded-md p-0.5">
            {(['primary', 'subagent', 'all'] as OpencodeAgentMode[]).map((m) => (
              <button
                key={m}
                onClick={() => update({ mode: m })}
                className={`flex-1 text-[11px] py-1 rounded transition-colors capitalize ${
                  draft.mode === m
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
                }`}
              >
                {m === 'primary' ? 'Primary' : m === 'subagent' ? 'Subagent' : 'All'}
              </button>
            ))}
          </div>
          {draft.mode === 'subagent' && (
            <div className="text-[10px] text-text-muted/50 mt-0.5">Subagent → callable via the task tool.</div>
          )}
        </div>

        {/* Model */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1">Model</div>
          <SelectMenu
            testid="OpencodeAgentsSection.model"
            value={draft.model}
            onChange={(v) => update({ model: v })}
            options={modelOptions}
            triggerClassName={`${inputClass} w-full`}
          />
        </div>

        {/* System prompt */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <div className="mb-1">System prompt</div>
          <textarea
            value={draft.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            placeholder="You are an agent that…"
            rows={5}
            spellCheck={false}
            className={`${inputClass} w-full resize-y font-mono`}
          />
        </div>

        {/* Tool permissions collapsible */}
        <div className="px-3 py-1.5 text-[13px] text-text-secondary">
          <button
            data-testid="OpencodeAgentsSection.permToggle"
            onClick={() => update({ restrict: !draft.restrict })}
            className="w-full flex items-center justify-between py-1 cursor-default"
          >
            <span className="text-[12px]">Restrict tool permissions</span>
            <span className={`w-7 h-4 rounded-full relative transition-colors ${draft.restrict ? 'bg-accent' : 'bg-text-muted/30'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${draft.restrict ? 'left-3.5' : 'left-0.5'}`} />
            </span>
          </button>
          {draft.restrict ? (
            <PermGrid
              grid={draft.permGrid}
              onChange={(cat, action) =>
                update({ permGrid: { ...draft.permGrid, [cat]: action } })
              }
            />
          ) : (
            <div className="text-[10px] text-text-muted/50 mt-0.5">
              Inherits from the session&apos;s autonomy mode + auto gatekeeper
            </div>
          )}
        </div>

        {/* Advanced collapsible */}
        <details className="px-3 py-1">
          <summary className="text-[12px] text-text-muted/70 cursor-default select-none list-none flex items-center gap-1">
            <span className="text-[9px]">▸</span> Advanced
          </summary>
          <div className="mt-1.5 space-y-1">
            <SettingsSlider
              label="Temperature"
              value={draft.temperature ?? 0}
              min={0}
              max={2}
              step={0.05}
              onChange={(v) => update({ temperature: v > 0 ? v : null })}
              formatValue={(v) => v.toFixed(2)}
            />
            <div className="py-1.5 text-[13px] text-text-secondary">
              <div className="mb-1 text-[11px]">Top P</div>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={draft.topP}
                onChange={(e) => update({ topP: e.target.value })}
                placeholder="0.95"
                className={`${inputClass} w-full`}
              />
            </div>
            <div className="py-1.5 text-[13px] text-text-secondary">
              <div className="mb-1 text-[11px]">Steps</div>
              <input
                type="number"
                min={1}
                value={draft.steps}
                onChange={(e) => update({ steps: e.target.value })}
                placeholder="unlimited"
                className={`${inputClass} w-full`}
              />
            </div>
            <div className="py-1.5 text-[13px] text-text-secondary">
              <div className="mb-1 text-[11px]">Reasoning effort</div>
              <SelectMenu
                testid="OpencodeAgentsSection.reasoningEffort"
                value={draft.reasoningEffort}
                onChange={(v) => update({ reasoningEffort: v })}
                options={[
                  { value: '', label: 'Default' },
                  { value: 'low', label: 'Low' },
                  { value: 'high', label: 'High' }
                ]}
                triggerClassName={`${inputClass} w-full`}
              />
            </div>
          </div>
        </details>

        {/* Appearance collapsible */}
        <details className="px-3 py-1">
          <summary className="text-[12px] text-text-muted/70 cursor-default select-none list-none flex items-center gap-1">
            <span className="text-[9px]">▸</span> Appearance
          </summary>
          <div className="mt-1.5 space-y-2">
            <div className="text-[13px] text-text-secondary">
              <div className="mb-1 text-[11px]">Color</div>
              <div className="flex items-center gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => update({ color: draft.color === c ? '' : c })}
                    className={`w-5 h-5 rounded-full transition-transform hover:scale-110 cursor-default ${
                      draft.color === c ? 'ring-2 ring-offset-1 ring-offset-bg-primary ring-accent scale-110' : ''
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
                {draft.color && (
                  <button
                    onClick={() => update({ color: '' })}
                    className="text-[10px] text-text-muted/60 hover:text-text-secondary transition-colors ml-1"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <button
              onClick={() => update({ hidden: !draft.hidden })}
              className="w-full flex items-center justify-between py-1 text-[13px] text-text-secondary cursor-default"
            >
              <span className="text-[11px]">Hidden</span>
              <span className={`w-7 h-4 rounded-full relative transition-colors ${draft.hidden ? 'bg-accent' : 'bg-text-muted/30'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${draft.hidden ? 'left-3.5' : 'left-0.5'}`} />
              </span>
            </button>
          </div>
        </details>

        {saveError && (
          <div className="mx-3 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded text-[11px] text-red-400">
            {saveError}
          </div>
        )}
      </div>

      {/* Pinned footer */}
      <div className="shrink-0 px-3 py-2 border-t border-border/30 flex items-center justify-between gap-2">
        {/* Left side: destructive actions */}
        <div className="flex items-center gap-2">
          {isBuiltin && (
            <>
              <button
                data-testid="OpencodeAgentsSection.disable"
                onClick={() => void handleDisable()}
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-default"
              >
                {detail?.disabled ? 'Re-enable' : 'Disable'}
              </button>
              <button
                data-testid="OpencodeAgentsSection.reset"
                onClick={() => void handleReset()}
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-default"
              >
                Reset to default
              </button>
            </>
          )}
          {isCustom && (
            <button
              data-testid="OpencodeAgentsSection.delete"
              onClick={() => void handleDelete()}
              className="text-[11px] text-red-400 hover:text-red-300 transition-colors cursor-default"
            >
              Delete
            </button>
          )}
        </div>

        {/* Right side: cancel + save */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onBack}
            className="px-3 py-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors rounded cursor-default"
          >
            Cancel
          </button>
          <button
            data-testid="OpencodeAgentsSection.save"
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-3 py-1 text-[11px] bg-accent/20 hover:bg-accent/30 text-accent rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-default"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── OpencodeAgentsSection ────────────────────────────────────────────

export function OpencodeAgentsSection(): React.JSX.Element {
  const installed = useOpencodeInstalled()
  const cwd = useActiveSession((s) => s.cwd)
  const [view, setView] = useState<ViewState>({ mode: 'list' })
  const [refresh, setRefresh] = useState(0)

  const handleSaved = (): void => {
    setRefresh((n) => n + 1)
    setView({ mode: 'list' })
  }

  if (installed === null) {
    return (
      <div data-testid="OpencodeAgentsSection" className="px-3 py-1.5 text-[13px] text-text-muted">
        Loading…
      </div>
    )
  }

  if (!installed) {
    return (
      <div data-testid="OpencodeAgentsSection" className="px-3 py-2 text-[12px] text-text-muted/70 leading-relaxed">
        opencode is not installed. Agent settings apply to opencode sessions.
      </div>
    )
  }

  return (
    <div data-testid="OpencodeAgentsSection" className="flex flex-col min-h-0">
      {view.mode === 'list' && (
        <ListView
          cwd={cwd}
          refresh={refresh}
          onEdit={(name, scope) => setView({ mode: 'edit', name, scope })}
          onNew={() => setView({ mode: 'new' })}
        />
      )}
      {(view.mode === 'edit' || view.mode === 'new') && (
        <EditorView
          view={view}
          cwd={cwd}
          onBack={() => setView({ mode: 'list' })}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
