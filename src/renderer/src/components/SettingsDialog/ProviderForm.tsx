/**
 * ProviderForm — the shared vault's custom-endpoint definition, on the row
 * vocabulary (ADR-065 phase 6c).
 *
 * It is `SharedProviders`' `ProviderForm` re-dressed and moved here: same
 * fields, same normalisation, same required-field rule, because the definition
 * it produces is read by the two adapters that project it into pi's
 * `models.json` and opencode's config. What changed is where it lives — the
 * vault's own pane is gone, and BOTH sheets need this form:
 *
 *  · the Add sheet's CUSTOM ENDPOINT step declares a new one;
 *  · the Manage sheet's "Edit endpoint" changes one that exists.
 *
 * The id is LOCKED when editing. `providers.<id>` is the key both adapters
 * project under, so re-typing it would not rename a provider — it would declare
 * a second one and orphan the first (the vault has no rename verb).
 *
 * The API key is write-only in both hosts. It never travels inside the
 * definition (`shared-provider:save` is config, `shared-provider:set-key` is
 * the credential) and is never read back, which is why the field is blank even
 * when a key exists.
 *
 * Each model carries its limits and capabilities (ADR-086): context window,
 * max output, vision, reasoning — what both adapters project, and what opencode
 * reads as "nothing" for a declared model that states none. `Detect` fills them
 * from the endpoint through `shared-provider:probe`, host-side, so a stored key
 * never reaches this form. Every rule about what Detect may fill and what it may
 * only offer lives in `shared/endpoint-detect.ts`; this form renders the
 * outcome. Nothing it does is persisted until the host's own Save.
 */

import { useRef, useState } from 'react'
import type {
  ConfigurableHarnessId,
  EndpointProbeDetected,
  EndpointProbeFailed,
  EndpointProbeInput,
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderProtocol
} from '../../../../shared/shared-provider'
import {
  OPENCODE_DEFAULT_MAX_OUTPUT,
  PI_DEFAULT_MAX_OUTPUT,
  applyChanges,
  fieldSource,
  importModels,
  liveChanges,
  mergeProbe,
  outputWarning,
  type DetectField,
  type FieldSource,
  type ProbeChange
} from '../../../../shared/endpoint-detect'
import { formatTokenCount } from '../usage/usage-utils'
import {
  Button,
  ChipSet,
  NumberField,
  SelectField,
  SettingRow,
  TextField,
  ToggleSwitch
} from './settings-controls'
import { SheetGroup } from './SheetFrame'
import { useEngineRuns } from './harness-store'
import type { EngineRuns } from './harness-view'

/** Testid namespace (ADR-027 tier 1/2). */
const FORM = 'ProviderForm'

/** Wire protocols a custom shared provider can speak. First entry = the default. */
export const PROTOCOL_OPTIONS: { value: SharedProviderProtocol; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI completions' },
  { value: 'openai-responses', label: 'OpenAI responses' },
  { value: 'anthropic-messages', label: 'Anthropic messages' }
]

const HARNESSES: readonly ConfigurableHarnessId[] = ['pi', 'opencode']

/**
 * The harnesses a custom endpoint can be enabled for right now: the two it
 * supports, less any that does not run (ADR-082 §8). A hidden harness's saved
 * route is left as it is.
 */
export function endpointHarnesses(runs: EngineRuns): ConfigurableHarnessId[] {
  return HARNESSES.filter((harness) => runs(harness))
}

/** The message `SharedProviders` used, unchanged — it names all three fields. */
export const REQUIRED_FIELDS_MESSAGE = 'Provider id, name, and model id are required'

/**
 * A blank draft: one empty model row, a route on for each harness that runs
 * (both, unless told otherwise) — never one the user could not see to turn off.
 */
export function blankProviderDraft(runs: EngineRuns = () => true): SharedProviderDefinition {
  return {
    id: '',
    name: '',
    kind: 'custom',
    protocol: 'openai-completions',
    baseUrl: '',
    models: [{ id: '', name: '' }],
    routes: { pi: { enabled: runs('pi') }, opencode: { enabled: runs('opencode') } },
    managed: true
  }
}

/**
 * Trim the draft into the definition to save, or return the required-field
 * message. One function, so the Add and Edit paths cannot disagree about what a
 * valid definition is.
 */
export function normalizeProviderDraft(
  draft: SharedProviderDefinition
): { definition: SharedProviderDefinition } | { error: string } {
  if (!draft.id.trim() || !draft.name.trim() || draft.models.some((model) => !model.id.trim())) {
    return { error: REQUIRED_FIELDS_MESSAGE }
  }
  return {
    definition: {
      ...draft,
      id: draft.id.trim(),
      name: draft.name.trim(),
      baseUrl: draft.baseUrl?.trim(),
      models: draft.models.map((model) => {
        const name = model.name?.trim()
        return { ...model, id: model.id.trim(), name: name || undefined }
      })
    }
  }
}

/**
 * The last Detect, as the form shows it. `error` is a probe the host never
 * answered at all (the call itself was refused); it renders as a failure.
 */
type DetectOutcome =
  | {
      result: EndpointProbeDetected
      changes: ProbeChange[]
      notServedIds: string[]
    }
  | { result: EndpointProbeFailed | { status: 'error'; message: string } }
type Detected = Extract<DetectOutcome, { changes: ProbeChange[] }>

const SERVER_LABEL: Record<EndpointProbeDetected['server'], string> = {
  vllm: 'vLLM',
  sglang: 'SGLang',
  'openai-compatible': 'OpenAI-compatible'
}

const FIELD_LABEL: Record<DetectField, string> = {
  contextWindow: 'context',
  maxTokens: 'max output',
  vision: 'vision',
  reasoning: 'reasoning'
}

const SOURCE_CLASS: Record<FieldSource, string> = {
  server: 'bg-accent/15 text-accent',
  suggested: 'bg-warning/15 text-warning',
  manual: 'border border-border text-text-secondary',
  default: 'text-text-muted'
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
const exact = (n: number): string => n.toLocaleString('en-US')
const shownValue = (value: number | boolean): string =>
  typeof value === 'boolean' ? (value ? 'on' : 'off') : exact(value)

/** The same server: what a Detect result is about. */
function sameEndpoint(a: SharedProviderDefinition, b: SharedProviderDefinition): boolean {
  return (a.baseUrl ?? '').trim() === (b.baseUrl ?? '').trim() && a.protocol === b.protocol
}

/** `model` with `field` set — or removed when `value` is undefined, which means the engine default. */
function withField(
  model: SharedProviderModel,
  field: DetectField,
  value: number | boolean | undefined
): SharedProviderModel {
  const rest = { ...model }
  delete rest[field]
  return value === undefined ? rest : { ...rest, [field]: value }
}

export function ProviderForm({
  draft,
  onDraft,
  apiKey,
  onApiKey,
  error,
  idLocked = false
}: {
  draft: SharedProviderDefinition
  onDraft: (next: SharedProviderDefinition) => void
  apiKey: string
  onApiKey: (next: string) => void
  /** The last save's refusal — validation here, or the writer's own words. */
  error?: string | null
  /** Editing an existing definition: the id is its key in three stores. */
  idLocked?: boolean
}): React.JSX.Element {
  const set = (patch: Partial<SharedProviderDefinition>): void => onDraft({ ...draft, ...patch })
  const runs = useEngineRuns()
  const harnesses = endpointHarnesses(runs)
  // The output warning measures only harnesses that run: a hidden harness's
  // saved route is kept, but nothing is delivered into it (ADR-082 §8).
  const liveRoutes = {
    pi: { enabled: draft.routes.pi.enabled && runs('pi') },
    opencode: { enabled: draft.routes.opencode.enabled && runs('opencode') }
  }
  const setModel = (index: number, next: SharedProviderModel): void =>
    set({ models: draft.models.map((model, i) => (i === index ? next : model)) })

  const [running, setRunning] = useState(false)
  const [detect, setDetect] = useState<DetectOutcome | null>(null)
  // Row indices shown unfolded. A fresh Add draft's one blank row starts open;
  // a saved definition's rows start folded.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () => new Set(draft.models.length === 1 && !draft.models[0].id.trim() ? [0] : [])
  )
  // The probe answers after the user may have typed on: its result is merged
  // into the draft as it is THEN, not as it was when Detect was pressed.
  const latest = useRef(draft)
  latest.current = draft

  const baseUrl = (draft.baseUrl ?? '').trim()

  async function runDetect(): Promise<void> {
    if (!baseUrl || running) return
    const key = apiKey.trim()
    const input: EndpointProbeInput = {
      baseUrl,
      ...(draft.protocol ? { protocol: draft.protocol } : {}),
      ...(key ? { apiKey: key } : {}),
      // Editing: the host may use the stored key, which never comes here.
      ...(idLocked && draft.id ? { providerId: draft.id } : {})
    }
    setRunning(true)
    try {
      const result = await window.api.probeSharedEndpoint(input)
      const current = latest.current
      // The endpoint changed while the probe ran: its answer is about another
      // server, so it fills nothing and offers nothing.
      if (!sameEndpoint(current, draft)) return
      if (result.status === 'failed') {
        setDetect({ result })
        return
      }
      const fresh = current.models.every((model) => !model.id.trim()) && result.models.length > 0
      const outcome = mergeProbe(current.models, result, new Date().toISOString())
      onDraft({ ...current, models: outcome.models })
      if (fresh) setExpanded(new Set(outcome.models.length === 1 ? [0] : []))
      setDetect({
        result,
        changes: outcome.changes,
        notServedIds: outcome.notServedIds
      })
    } catch (e) {
      setDetect({
        result: { status: 'error', message: e instanceof Error ? e.message : String(e) }
      })
    } finally {
      setRunning(false)
    }
  }

  const detected: Detected | null = detect && 'changes' in detect ? detect : null
  const listed = new Set(draft.models.map((model) => model.id))
  // Live: what the last result serves minus what is listed now, so a removed
  // served model is offered again and one typed in by hand is not offered twice.
  const newIds = detected
    ? detected.result.models.map((served) => served.id).filter((id) => !listed.has(id))
    : []
  // Only what still holds: a line the user has since answered by hand drops out.
  const pending = detected ? liveChanges(draft.models, detected.changes) : []

  function toggleExpanded(index: number): void {
    const next = new Set(expanded)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setExpanded(next)
  }

  function removeModel(index: number): void {
    set({ models: draft.models.filter((_, i) => i !== index) })
    // The rows after it move up one.
    setExpanded(
      new Set([...expanded].filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)))
    )
  }

  function addModel(): void {
    const models = [...draft.models, { id: '', name: '' }]
    set({ models })
    if (models.length === 1) setExpanded(new Set([0]))
  }

  return (
    <div data-testid={FORM} data-id={draft.id || 'new'}>
      <SheetGroup testid={`${FORM}.group`} id="endpoint" label="Endpoint">
        <SettingRow
          testid={`${FORM}.field`}
          dataId="id"
          label="Provider id"
          description={
            idLocked
              ? 'The key each harness stores this provider under. Fixed after creation.'
              : 'The key each harness will store this provider under.'
          }
        >
          <TextField
            testid={`${FORM}.id`}
            value={draft.id}
            disabled={idLocked}
            onChange={(value) => set({ id: value })}
            placeholder="internal-gateway"
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow testid={`${FORM}.field`} dataId="name" label="Display name">
          <TextField
            testid={`${FORM}.name`}
            mono={false}
            value={draft.name}
            onChange={(value) => set({ name: value })}
            placeholder="Internal gateway"
            className="w-[180px]"
          />
        </SettingRow>
        <SettingRow
          testid={`${FORM}.field`}
          dataId="protocol"
          label="Protocol"
          description="The wire format this endpoint speaks."
        >
          <SelectField
            testid={`${FORM}.protocol`}
            value={draft.protocol ?? PROTOCOL_OPTIONS[0].value}
            options={PROTOCOL_OPTIONS}
            onChange={(value) => {
              set({ protocol: value as SharedProviderProtocol })
              setDetect(null)
            }}
          />
        </SettingRow>
        <SettingRow
          testid={`${FORM}.field`}
          dataId="baseUrl"
          layout="stacked"
          label="Base URL"
          description="Detect reads the served models and their limits."
        >
          <span className="block space-y-2">
            <span className="flex items-center gap-1.5">
              <TextField
                testid={`${FORM}.baseUrl`}
                value={draft.baseUrl ?? ''}
                onChange={(value) => {
                  set({ baseUrl: value })
                  // A result belongs to the URL it came from: Import must never
                  // pull an old server's models into a new endpoint.
                  setDetect(null)
                }}
                placeholder="https://llm.example/v1"
                className="flex-1 min-w-0"
              />
              {/* Button-only (ADR-086): probing on every keystroke would dial
                  half-typed hosts and fill fields nobody asked for. */}
              <Button
                testid={`${FORM}.detect`}
                disabled={running || !baseUrl}
                onClick={() => void runDetect()}
              >
                {running ? 'Detecting…' : 'Detect'}
              </Button>
            </span>
            {detect && (
              <DetectBanner outcome={detect} running={running} onAgain={() => void runDetect()} />
            )}
            {detected && pending.length > 0 && (
              <DetectChanges
                changes={pending}
                onApply={() => {
                  set({ models: applyChanges(draft.models, pending) })
                  setDetect({ ...detected, changes: [] })
                }}
                onIgnore={() => setDetect({ ...detected, changes: [] })}
              />
            )}
          </span>
        </SettingRow>
        {harnesses.length > 0 && (
          <SettingRow
            testid={`${FORM}.field`}
            dataId="routes"
            label="Enable for"
            description="One definition, projected into every enabled harness."
          >
            <ChipSet
              testid={`${FORM}.engines`}
              value={harnesses.filter((harness) => draft.routes[harness].enabled)}
              options={harnesses.map((harness) => ({ value: harness, label: harness }))}
              onToggle={(value) => {
                const harness = value as ConfigurableHarnessId
                set({
                  routes: {
                    ...draft.routes,
                    [harness]: { ...draft.routes[harness], enabled: !draft.routes[harness].enabled }
                  }
                })
              }}
            />
          </SettingRow>
        )}
        <SettingRow
          testid={`${FORM}.field`}
          dataId="key"
          label="API key"
          description="Optional. Held once by ClaudeUI and vended to each enabled harness; never read back, so this field starts empty even when a key is set. Detect uses it too."
        >
          <TextField
            type="password"
            testid={`${FORM}.key`}
            value={apiKey}
            onChange={onApiKey}
            placeholder={idLocked ? 'Set or replace the key' : 'API key (optional)'}
            className="w-[150px]"
          />
        </SettingRow>
      </SheetGroup>

      <SheetGroup
        testid={`${FORM}.group`}
        id="models"
        label="Models"
        trailing={
          detected && newIds.length > 0 ? (
            <Button
              variant="link"
              testid={`${FORM}.importModels`}
              onClick={() => {
                set({
                  models: importModels(
                    draft.models,
                    detected.result,
                    newIds,
                    new Date().toISOString()
                  )
                })
              }}
            >
              Import served models ({newIds.length} new)
            </Button>
          ) : undefined
        }
      >
        <SettingRow
          testid={`${FORM}.field`}
          dataId="models"
          description="What this endpoint serves. Every delivered model stays available unless a harness’s own list restricts it."
          error={error ?? undefined}
          errorTestid={`${FORM}.error`}
        />
        {draft.models.map((model, index) => (
          <ModelRow
            key={index}
            index={index}
            model={model}
            open={expanded.has(index)}
            notServed={!!detected?.notServedIds.includes(model.id)}
            reasoningParser={
              detected?.result.models.find((served) => served.id === model.id)?.reasoningParser
            }
            warning={outputWarning(model, liveRoutes)}
            onToggle={() => toggleExpanded(index)}
            onChange={(next) => setModel(index, next)}
            onRemove={() => removeModel(index)}
          />
        ))}
        <div className="px-3.5 py-2">
          <Button variant="link" testid={`${FORM}.addModel`} onClick={addModel}>
            + Add model
          </Button>
        </div>
      </SheetGroup>
    </div>
  )
}

/** What the last Detect found, in the words of mockup `3fdf1efe` ("What Detect shows"). */
function DetectBanner({
  outcome,
  running,
  onAgain
}: {
  outcome: DetectOutcome
  running: boolean
  onAgain: () => void
}): React.JSX.Element {
  const { result } = outcome
  const lines: React.ReactNode[] = []
  let state: string
  if (result.status === 'detected') {
    state = result.server
    const served = plural(result.models.length, 'model')
    const lead = <b className="font-semibold">{SERVER_LABEL[result.server]}</b>
    if (result.server === 'sglang') {
      lines.push(
        <>
          {lead} · {served} ·{' '}
          {result.modelInfoUnavailable
            ? 'context read from the server.'
            : 'context, vision, reasoning read from the server.'}{' '}
          Max output suggested.
        </>
      )
      if (result.modelInfoUnavailable)
        lines.push('Couldn’t read /model_info — set vision and reasoning by hand.')
      if (result.toolCallParser === null)
        lines.push(
          <span className="text-warning">
            SGLang: this server has no tool-call parser (<code>--tool-call-parser</code>), so agents
            can’t call tools through it.
          </span>
        )
    } else if (result.server === 'vllm') {
      lines.push(
        <>
          {lead} · {served} · context read from the server. Vision and reasoning aren’t reported;
          set them by hand.
        </>
      )
    } else {
      lines.push(
        <>
          {lead} · {served} · this server reports model ids only. Import them, then fill limits by
          hand.
        </>
      )
    }
  } else {
    state = 'failed'
    lines.push(result.message)
    if (result.status === 'failed') {
      if (result.reason === 'unauthorized')
        lines.push('Enter the API key above, then Detect again.')
      else if (result.reason === 'unreachable' || result.reason === 'timeout')
        lines.push('Check the URL, or skip Detect and fill limits by hand.')
      if (result.keyWithheld)
        lines.push(
          'The saved key is only sent to the saved address — type the key to detect against this one.'
        )
    }
  }
  const failed = state === 'failed'
  return (
    <span
      data-testid={`${FORM}.detectResult`}
      data-state={state}
      className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-[12px] leading-4 ${failed ? 'bg-danger/10' : 'bg-success/10'}`}
    >
      <span
        className={`mt-1 w-1.5 h-1.5 shrink-0 rounded-full ${failed ? 'bg-danger' : 'bg-success'}`}
      />
      <span className="flex-1 min-w-0 text-text-primary">
        {lines.map((line, i) => (
          <span key={i} className={`block ${i > 0 ? 'mt-0.5 text-text-secondary' : ''}`}>
            {line}
          </span>
        ))}
      </span>
      <Button variant="link" testid={`${FORM}.detectAgain`} disabled={running} onClick={onAgain}>
        Detect again
      </Button>
    </span>
  )
}

/** A later Detect's differences: offered, never applied unasked. */
function DetectChanges({
  changes,
  onApply,
  onIgnore
}: {
  changes: ProbeChange[]
  onApply: () => void
  onIgnore: () => void
}): React.JSX.Element {
  return (
    <span
      data-testid={`${FORM}.detectChanges`}
      className="block rounded-md bg-warning/10 px-2.5 py-2 text-[12px] leading-4 text-text-primary"
    >
      <span className="block">
        Detect found {plural(changes.length, 'change')}. Fields you edited are never overwritten
        without asking.
      </span>
      {changes.map((change) => (
        <span
          key={`${change.modelId}:${change.field}`}
          data-testid={`${FORM}.detectChange`}
          data-id={`${change.modelId}:${change.field}`}
          className="block mt-0.5 text-text-secondary"
        >
          <span className="font-mono">{change.modelId}</span> {FIELD_LABEL[change.field]}{' '}
          {shownValue(change.from)} → {shownValue(change.to)}
          {change.edited && ' (you edited this)'}
        </span>
      ))}
      <span className="flex gap-3 mt-1">
        <Button variant="link" testid={`${FORM}.applyChanges`} onClick={onApply}>
          Apply
        </Button>
        <Button variant="link" testid={`${FORM}.ignoreChanges`} onClick={onIgnore}>
          Ignore
        </Button>
      </span>
    </span>
  )
}

/** Where a field's value came from (ADR-086): read, suggested, typed, or left to the engine. */
function SourceBadge({
  model,
  field
}: {
  model: SharedProviderModel
  field: DetectField
}): React.JSX.Element {
  const source = fieldSource(model, field)
  return (
    <span
      data-testid={`${FORM}.source`}
      data-id={field}
      data-source={source}
      className={`shrink-0 rounded-full px-[7px] text-[10.5px] leading-4 ${SOURCE_CLASS[source]}`}
    >
      {source}
    </span>
  )
}

function Chip({
  children,
  muted = false
}: {
  children: React.ReactNode
  muted?: boolean
}): React.JSX.Element {
  return (
    <span
      className={`border border-border rounded-full px-[7px] text-[11px] leading-4 ${muted ? 'text-text-muted' : 'text-text-secondary'}`}
    >
      {children}
    </span>
  )
}

/**
 * One model: id, display name and Remove on the first line, as before. Folded,
 * a chip line says what it is; unfolded, its four facts, each with a badge
 * saying where its value came from.
 */
function ModelRow({
  index,
  model,
  open,
  notServed,
  reasoningParser,
  warning,
  onToggle,
  onChange,
  onRemove
}: {
  index: number
  model: SharedProviderModel
  open: boolean
  notServed: boolean
  reasoningParser?: string
  warning: { suggested: number; output: number } | null
  onToggle: () => void
  onChange: (next: SharedProviderModel) => void
  onRemove: () => void
}): React.JSX.Element {
  const id = String(index)
  // NumberField clamps to `min`; the repository refuses anything but a positive integer.
  const setNumber = (field: 'contextWindow' | 'maxTokens', value: number | undefined): void =>
    onChange(withField(model, field, value === undefined ? undefined : Math.round(value)))
  const flip = (field: 'vision' | 'reasoning'): void =>
    onChange(withField(model, field, !model[field]))
  const notServedChip = notServed && (
    <span data-testid={`${FORM}.notServed`} data-id={id}>
      <Chip muted>not served by this endpoint</Chip>
    </span>
  )

  return (
    <div data-testid={`${FORM}.model`} data-id={id} className="px-3.5 py-2.5">
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid={`${FORM}.modelToggle`}
          data-id={id}
          aria-expanded={open}
          aria-label={open ? 'Hide model details' : 'Show model details'}
          onClick={onToggle}
          className={`w-4 shrink-0 text-text-secondary transition-transform cursor-default ${open ? 'rotate-90' : ''}`}
        >
          ›
        </button>
        <TextField
          testid={`${FORM}.modelId`}
          dataId={id}
          value={model.id}
          onChange={(value) => onChange({ ...model, id: value })}
          placeholder="Model ID"
          className="flex-1 min-w-0"
        />
        <TextField
          testid={`${FORM}.modelName`}
          dataId={id}
          mono={false}
          value={model.name ?? ''}
          onChange={(value) => onChange({ ...model, name: value })}
          placeholder="Display name (optional)"
          className="flex-1 min-w-0"
        />
        <Button variant="link" testid={`${FORM}.removeModel`} dataId={id} onClick={onRemove}>
          Remove
        </Button>
      </span>

      {!open && (
        <span
          data-testid={`${FORM}.modelSummary`}
          data-id={id}
          className="flex flex-wrap gap-1.5 mt-1.5 pl-[22px]"
        >
          <Chip>
            {model.contextWindow !== undefined
              ? `${formatTokenCount(model.contextWindow)} context`
              : 'context: default'}
          </Chip>
          <Chip>
            {model.maxTokens !== undefined
              ? `${formatTokenCount(model.maxTokens)} output`
              : 'output: default'}
          </Chip>
          <Chip>{model.vision ? 'vision' : 'text only'}</Chip>
          {model.reasoning && <Chip>reasoning</Chip>}
          {notServedChip}
        </span>
      )}

      {open && (
        <div
          data-testid={`${FORM}.modelDetails`}
          data-id={id}
          className="mt-1.5 ml-[22px] border-l border-border/55"
        >
          {notServedChip && <span className="block px-3.5 pt-1">{notServedChip}</span>}
          <SettingRow
            testid={`${FORM}.detail`}
            dataId="contextWindow"
            label="Context window"
            labelBadge={<SourceBadge model={model} field="contextWindow" />}
            description="Prompt + output, in tokens."
          >
            <NumberField
              testid={`${FORM}.contextWindow`}
              dataId={id}
              value={model.contextWindow}
              onChange={(value) => setNumber('contextWindow', value)}
              placeholder="default"
              min={1}
            />
          </SettingRow>
          <SettingRow
            testid={`${FORM}.detail`}
            dataId="maxTokens"
            label="Max output"
            labelBadge={<SourceBadge model={model} field="maxTokens" />}
            description={`Blank uses the harness default (opencode ${exact(OPENCODE_DEFAULT_MAX_OUTPUT)}, pi ${exact(PI_DEFAULT_MAX_OUTPUT)}).`}
          >
            <NumberField
              testid={`${FORM}.maxTokens`}
              dataId={id}
              value={model.maxTokens}
              onChange={(value) => setNumber('maxTokens', value)}
              placeholder="default"
              min={1}
            />
          </SettingRow>
          <SettingRow
            as="button"
            testid={`${FORM}.detail`}
            dataId="vision"
            ariaPressed={model.vision === true}
            onClick={() => flip('vision')}
            label="Vision"
            labelBadge={<SourceBadge model={model} field="vision" />}
            description="Accepts image attachments."
            className="hover:bg-bg-hover/40 transition-colors"
          >
            <ToggleSwitch checked={model.vision === true} />
          </SettingRow>
          <SettingRow
            as="button"
            testid={`${FORM}.detail`}
            dataId="reasoning"
            ariaPressed={model.reasoning === true}
            onClick={() => flip('reasoning')}
            label="Reasoning"
            labelBadge={<SourceBadge model={model} field="reasoning" />}
            description={
              reasoningParser ? (
                <>
                  Server runs reasoning parser <code>{reasoningParser}</code>.
                </>
              ) : (
                'Thinks before it answers.'
              )
            }
            className="hover:bg-bg-hover/40 transition-colors"
          >
            <ToggleSwitch checked={model.reasoning === true} />
          </SettingRow>
        </div>
      )}

      {warning && model.contextWindow !== undefined && (
        <span
          data-testid={`${FORM}.outputWarning`}
          data-id={id}
          className="flex items-start gap-2 mt-2 rounded-md bg-warning/10 px-2.5 py-2 text-[12px] leading-4 text-text-primary"
        >
          <span className="mt-1 w-1.5 h-1.5 shrink-0 rounded-full bg-warning" />
          <span className="flex-1 min-w-0">
            <span className="font-mono">{model.id || 'This model'}</span>:{' '}
            {formatTokenCount(model.contextWindow)} context with{' '}
            {model.maxTokens !== undefined ? 'a max output' : 'the default max output'} of{' '}
            {exact(warning.output)} leaves{' '}
            {model.contextWindow > warning.output
              ? `~${exact(model.contextWindow - warning.output)} tokens for the prompt before the harness compacts.`
              : 'no room for the prompt.'}{' '}
            Set Max output to about {formatTokenCount(warning.suggested)}.
          </span>
          <Button
            variant="link"
            testid={`${FORM}.applySuggestedOutput`}
            dataId={id}
            onClick={() =>
              // The badge must read "suggested", so the baseline holds the value
              // too. A model Detect never saw has no baseline to hold it in.
              onChange({
                ...model,
                maxTokens: warning.suggested,
                ...(model.detected
                  ? { detected: { ...model.detected, maxTokens: warning.suggested } }
                  : {})
              })
            }
          >
            Set {exact(warning.suggested)}
          </Button>
        </span>
      )}
    </div>
  )
}
