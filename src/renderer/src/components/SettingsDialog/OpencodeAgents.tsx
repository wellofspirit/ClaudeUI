/**
 * OpencodeAgents — full CRUD UI for opencode custom and built-in agents.
 *
 * Renders inside the opencode page's Agents group. Self-gates on opencode
 * installation. Supports creating, editing, disabling, resetting, and
 * deleting agents with scope (global / project), mode, model, system
 * prompt, tool permissions, advanced params, and appearance settings.
 *
 * Two views share the group card: a LIST of agents (each a row of the ADR-065
 * vocabulary, drilling in on click) and an EDITOR. The editor scrolls with the
 * page rather than owning its own scroller — the settings shell is one scrolling
 * page now, so a nested `overflow-y-auto` would trap the form in a short box.
 */

import { useState, useEffect } from 'react'
import type {
  OpencodeAgentScope,
  OpencodeAgentSummary,
  OpencodeAgentDetail,
  OpencodeAgentInput,
  OpencodeAgentMode,
  ModelInfo
} from '../../../../shared/types'
import { useActiveSession } from '../../stores/session-store'
import {
  Button,
  NumberField,
  Segmented,
  SelectField,
  SettingRow,
  SettingsSlider,
  SettingsTextarea,
  SettingsToggle,
  TextField
} from './settings-controls'
import { useOpencodeInstalled } from './use-engine-installed'

// ── Shared look ──────────────────────────────────────────────────────

const TESTID = 'OpencodeAgentsSection'

/** The vocabulary's inline state badge (the shape `SettingRow` uses). */
const BADGE =
  'shrink-0 rounded-full px-[7px] text-[10.5px] leading-4 font-semibold tracking-[0.02em]'

/** A group sub-caption inside the card (11px / 600 / caps, as on the boards). */
const CAPTION = 'text-[11px] font-semibold uppercase tracking-[0.04em] text-text-secondary'

/** A disclosure summary — not a row, so it borrows the description's type. */
const FIELD_HELP = 'text-[12px] leading-4 text-text-secondary'

// ── View state machine ───────────────────────────────────────────────

type ViewState =
  { mode: 'list' } | { mode: 'edit'; name: string; scope: OpencodeAgentScope } | { mode: 'new' }

// ── Permission tool categories ───────────────────────────────────────

const PERM_CATS = [
  'bash',
  'edit',
  'read',
  'glob',
  'grep',
  'webfetch',
  'task',
  'websearch',
  'todowrite',
  'lsp',
  'skill'
] as const
type PermAction = 'allow' | 'ask' | 'deny'

// ── Preset colors ────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#f59e0b', // amber
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#4ade80', // green
  '#f87171', // red
  '#60a5fa' // blue
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
  permGrid: {}
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
    permGrid: { ...(detail.permission ?? {}) }
  }
}

/** An optional numeric draft field, kept as text so "unset" stays distinct from 0. */
const numDraft = (s: string): number | undefined => (s === '' ? undefined : Number(s))
const numText = (v: number | undefined): string => (v === undefined ? '' : String(v))

// ── List view ────────────────────────────────────────────────────────

function ModeBadge({ mode }: { mode: OpencodeAgentMode }): React.JSX.Element {
  // A subagent is the quieter of the two: it is only reachable through the task
  // tool, so it never competes with the primary agents for attention.
  const look =
    mode === 'subagent' ? 'bg-text-muted/20 text-text-secondary' : 'bg-accent/15 text-accent'
  return <span className={`${BADGE} ${look}`}>{mode}</span>
}

function Chevron(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

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
      .then((list) => {
        if (!cancelled) {
          setAgents(list)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, refresh])

  const custom = agents.filter((a) => a.kind === 'custom')
  const builtin = agents.filter((a) => a.kind === 'builtin')

  if (loading) return <SettingRow description="Loading agents…" />

  const renderRow = (a: OpencodeAgentSummary): React.JSX.Element => (
    <SettingRow
      key={`${a.kind}-${a.name}`}
      as="button"
      testid={`${TESTID}.agentRow`}
      dataId={a.name}
      onClick={() => onEdit(a.name, a.scope ?? 'global')}
      label={a.name}
      labelClassName={a.disabled ? 'text-text-secondary line-through' : undefined}
      description={a.model || undefined}
      className="hover:bg-bg-hover/40 transition-colors"
      leading={
        <span
          className="w-2 h-2 shrink-0 rounded-full"
          style={{ backgroundColor: a.color || 'var(--color-text-muted)' }}
        />
      }
    >
      <ModeBadge mode={a.mode} />
      {a.kind === 'custom' && (
        <span
          className={`${BADGE} border border-border font-normal text-text-secondary`}
          data-id={a.scope ?? 'global'}
        >
          {a.scope ?? 'global'}
        </span>
      )}
      {a.overridden && <span className={`${BADGE} bg-success/15 text-success`}>overridden</span>}
      {a.disabled && <span className={`${BADGE} bg-danger/15 text-danger`}>disabled</span>}
      <Chevron />
    </SettingRow>
  )

  return (
    <>
      <div className="px-3.5 py-2 flex items-center justify-between gap-4">
        <span className={CAPTION}>Agents</span>
        <Button variant="tinted" testid={`${TESTID}.newAgent`} onClick={onNew}>
          + New agent
        </Button>
      </div>

      {custom.length > 0 && (
        <>
          <div className={`px-3.5 py-1.5 ${CAPTION}`}>Custom</div>
          {custom.map(renderRow)}
        </>
      )}

      {builtin.length > 0 && (
        <>
          <div className={`px-3.5 py-1.5 ${CAPTION}`}>Built-in</div>
          {builtin.map(renderRow)}
        </>
      )}

      {agents.length === 0 && (
        <SettingRow description="No agents found. Create a custom agent, or opencode has no built-in agents loaded." />
      )}
    </>
  )
}

// ── Permission grid ──────────────────────────────────────────────────

interface PermGridProps {
  grid: Partial<Record<string, PermAction>>
  onChange: (cat: string, action: PermAction) => void
}

function PermGrid({ grid, onChange }: PermGridProps): React.JSX.Element {
  const btnCls = (active: boolean, variant: PermAction): string => {
    const base = 'w-7 h-6 text-[12px] font-medium rounded transition-colors cursor-default'
    if (!active) return `${base} bg-bg-input text-text-muted hover:bg-bg-hover`
    if (variant === 'allow') return `${base} bg-success/15 text-success`
    if (variant === 'ask') return `${base} bg-warning/15 text-warning`
    return `${base} bg-danger/15 text-danger`
  }

  return (
    <div className="space-y-1">
      {PERM_CATS.map((cat) => {
        const current = grid[cat] ?? 'allow'
        return (
          <div key={cat} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[12px] text-text-secondary">{cat}</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className={btnCls(current === 'allow', 'allow')}
                onClick={() => onChange(cat, 'allow')}
                title="Allow"
              >
                A
              </button>
              <button
                type="button"
                className={btnCls(current === 'ask', 'ask')}
                onClick={() => onChange(cat, 'ask')}
                title="Ask"
              >
                ?
              </button>
              <button
                type="button"
                className={btnCls(current === 'deny', 'deny')}
                onClick={() => onChange(cat, 'deny')}
                title="Deny"
              >
                ✕
              </button>
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

  if (loading) return <SettingRow description="Loading agent…" />
  if (loadError) {
    return (
      <SettingRow description="Failed to load this agent.">
        <Button variant="link" onClick={onBack}>
          Go back
        </Button>
      </SettingRow>
    )
  }

  const isBuiltin = view.mode === 'edit' && detail?.kind === 'builtin'
  const isCustom = view.mode === 'edit' && detail?.kind === 'custom'

  // File path hint
  const scopeForHint = draft.scope
  const nameForHint = draft.name || '<name>'
  const filePath =
    scopeForHint === 'global'
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
        prompt: result.systemPrompt || draft.prompt
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
        mode: draft.mode
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
    } catch (_) {
      /* ignore */
    }
  }

  const handleReset = async (): Promise<void> => {
    if (view.mode !== 'edit') return
    try {
      await window.api.deleteOpencodeAgent(view.name, view.scope, cwd || undefined)
      onSaved()
    } catch (_) {
      /* ignore */
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (view.mode !== 'edit') return
    try {
      await window.api.deleteOpencodeAgent(view.name, view.scope, cwd || undefined)
      onSaved()
    } catch (_) {
      /* ignore */
    }
  }

  const modelOptions = [
    { value: '', label: 'Inherit (session model)' },
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value }))
  ]

  const projectDisabled = !cwd

  return (
    <div data-testid={`${TESTID}.editor`}>
      <div className="px-3.5 py-2">
        <Button variant="link" testid={`${TESTID}.back`} onClick={onBack}>
          ‹ Agents
        </Button>
      </div>

      {isBuiltin && (
        <SettingRow
          description={`Overriding the built-in ${view.mode === 'edit' ? view.name : ''} agent — fields left unset use opencode's defaults.`}
        />
      )}

      <SettingRow
        layout="stacked"
        label="Name"
        description="Lowercase letters, digits and dashes."
        keyText={filePath}
        error={nameError ?? undefined}
      >
        <TextField
          className="w-full"
          value={draft.name}
          disabled={isBuiltin}
          onChange={(v) => update({ name: v })}
          placeholder="my-agent"
        />
      </SettingRow>

      <SettingRow
        label="Scope"
        description={
          projectDisabled
            ? 'Open a project session to write a project-scoped agent.'
            : 'Global agents are available everywhere; project agents live in this working directory.'
        }
      >
        <Segmented
          value={draft.scope}
          onChange={(s) => update({ scope: s })}
          options={[
            { value: 'global' as OpencodeAgentScope, label: 'Global' },
            { value: 'project' as OpencodeAgentScope, label: 'Project', disabled: projectDisabled }
          ]}
        />
      </SettingRow>

      <SettingRow
        layout="stacked"
        label="Generate with AI"
        description="Describe what the agent should do and the model drafts its name, description and prompt."
        error={genError ?? undefined}
      >
        <span className="flex items-center gap-2">
          <TextField
            mono={false}
            className="flex-1 min-w-0"
            value={genDesc}
            onChange={setGenDesc}
            placeholder="Describe what this agent should do…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !generating) void handleGenerate()
            }}
          />
          <Button
            testid={`${TESTID}.generate`}
            onClick={() => void handleGenerate()}
            disabled={generating || !genDesc.trim()}
          >
            {generating ? 'Generating…' : 'Generate'}
          </Button>
        </span>
      </SettingRow>

      <SettingsTextarea
        label="Description"
        description="When the model should reach for this agent."
        value={draft.description}
        placeholder="When to use this agent…"
        rows={2}
        onChange={(v) => update({ description: v })}
      />

      <SettingRow
        label="Mode"
        description="A subagent is only reachable through the task tool; all is both."
      >
        <Segmented
          value={draft.mode}
          onChange={(m) => update({ mode: m })}
          options={[
            { value: 'primary' as OpencodeAgentMode, label: 'Primary' },
            { value: 'subagent' as OpencodeAgentMode, label: 'Subagent' },
            { value: 'all' as OpencodeAgentMode, label: 'All' }
          ]}
        />
      </SettingRow>

      <SettingRow layout="stacked" label="Model" description="Unset inherits the session's model.">
        <SelectField
          testid={`${TESTID}.model`}
          width="w-full"
          value={draft.model}
          onChange={(v) => update({ model: v })}
          options={modelOptions}
        />
      </SettingRow>

      <SettingsTextarea
        label="System prompt"
        description="Replaces opencode's own prompt for this agent."
        value={draft.prompt}
        placeholder="You are an agent that…"
        rows={5}
        monospace
        onChange={(v) => update({ prompt: v })}
      />

      <div>
        <SettingsToggle
          testid={`${TESTID}.permToggle`}
          label="Restrict tool permissions"
          description="Off inherits the session's autonomy mode and the auto gatekeeper."
          checked={draft.restrict}
          onChange={(v) => update({ restrict: v })}
        />
        {draft.restrict && (
          <div className="px-3.5 pb-2.5">
            <PermGrid
              grid={draft.permGrid}
              onChange={(cat, action) => update({ permGrid: { ...draft.permGrid, [cat]: action } })}
            />
          </div>
        )}
      </div>

      <details className="px-3.5 py-2">
        <summary className={`${FIELD_HELP} cursor-default select-none list-none`}>
          ▸ Advanced
        </summary>
        <div className="mt-1 -mx-3.5">
          <SettingsSlider
            label="Temperature"
            description="0 leaves it to the model's own default."
            value={draft.temperature ?? 0}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => update({ temperature: v > 0 ? v : null })}
            formatValue={(v) => v.toFixed(2)}
          />
          <SettingRow label="Top P" description="Nucleus sampling cutoff.">
            <NumberField
              value={numDraft(draft.topP)}
              min={0}
              max={1}
              step={0.01}
              placeholder="0.95"
              onChange={(v) => update({ topP: numText(v) })}
            />
          </SettingRow>
          <SettingRow label="Steps" description="Tool-call steps allowed in one turn.">
            <NumberField
              value={numDraft(draft.steps)}
              min={1}
              placeholder="unlimited"
              onChange={(v) => update({ steps: numText(v) })}
            />
          </SettingRow>
          <SettingRow label="Reasoning effort" description="Only for models that expose it.">
            <Segmented
              testid={`${TESTID}.reasoningEffort`}
              value={draft.reasoningEffort}
              onChange={(v) => update({ reasoningEffort: v })}
              options={[
                { value: '', label: 'Default' },
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' }
              ]}
            />
          </SettingRow>
        </div>
      </details>

      <details className="px-3.5 py-2">
        <summary className={`${FIELD_HELP} cursor-default select-none list-none`}>
          ▸ Appearance
        </summary>
        <div className="mt-1 -mx-3.5">
          <SettingRow label="Colour" description="Shown as the dot beside the agent's name.">
            <span className="flex items-center gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => update({ color: draft.color === c ? '' : c })}
                  className={`w-5 h-5 rounded-full transition-transform cursor-default ${
                    draft.color === c
                      ? 'ring-2 ring-offset-1 ring-offset-bg-secondary ring-accent'
                      : ''
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
              {draft.color && (
                <Button variant="link" onClick={() => update({ color: '' })}>
                  Clear
                </Button>
              )}
            </span>
          </SettingRow>
          <SettingsToggle
            label="Hidden"
            description="Keeps the agent out of the picker; it stays callable by name."
            checked={draft.hidden}
            onChange={(v) => update({ hidden: v })}
          />
        </div>
      </details>

      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isBuiltin && (
            <>
              <Button
                variant="danger"
                testid={`${TESTID}.disable`}
                onClick={() => void handleDisable()}
              >
                {detail?.disabled ? 'Re-enable' : 'Disable'}
              </Button>
              <Button variant="link" testid={`${TESTID}.reset`} onClick={() => void handleReset()}>
                Reset to default
              </Button>
            </>
          )}
          {isCustom && (
            <Button
              variant="danger"
              testid={`${TESTID}.delete`}
              onClick={() => void handleDelete()}
            >
              Delete
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {saveError && <span className="text-[12px] leading-4 text-danger">{saveError}</span>}
          <Button variant="link" onClick={onBack}>
            Cancel
          </Button>
          <Button
            variant="primary"
            testid={`${TESTID}.save`}
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
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

  if (installed === null) return <SettingRow testid={TESTID} description="Loading…" />

  if (!installed) {
    return (
      <SettingRow
        testid={TESTID}
        dimmed
        description="opencode is not installed. Agent settings apply to opencode sessions."
      />
    )
  }

  return (
    <div data-testid={TESTID} className="divide-y divide-border/55">
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
