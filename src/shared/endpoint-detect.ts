/**
 * endpoint-detect.ts — what the custom-endpoint form does with a Detect result.
 *
 * `shared-provider:probe` reads a self-hosted server's `/models` (and SGLang's
 * `/model_info`) host-side; everything after that is here, as pure functions,
 * so the form stays thin and every rule is unit-testable: filling blanks,
 * suggesting a max output the servers never report, telling a value the server
 * owns from one the user edited, and the Apply / Ignore diff a second Detect
 * produces.
 *
 * The one hard rule behind the suggestion: a context window must never be
 * filled without a max output. opencode reserves the max output out of the
 * context (`vendor/opencode-src/packages/opencode/src/session/overflow.ts:10-19`)
 * and falls back to 32,000 when none is declared, so a 32,768-token vLLM model
 * with only its context filled leaves ~768 tokens of prompt — compaction every
 * turn, and a 400 from vLLM once `max_tokens + input > max_model_len`.
 *
 * shared/ — pure, renderer-safe.
 */
import type {
  ConfigurableHarnessId,
  EndpointProbeDetected,
  EndpointProbeModel,
  EndpointServerKind,
  SharedProviderModel,
  SharedProviderModelDetected
} from './shared-provider'

/** The four per-model facts Detect can fill. */
export type DetectField = 'contextWindow' | 'maxTokens' | 'vision' | 'reasoning'

/** Where a model field's current value came from, for its provenance badge. */
export type FieldSource = 'server' | 'suggested' | 'manual' | 'default'

/** A probed value that differs from the model's current one — shown, never applied unasked. */
export interface ProbeChange {
  modelId: string
  field: DetectField
  from: number | boolean
  to: number | boolean
  /** The current value is the user's own edit (not the last Detect's value). */
  edited: boolean
}

export interface MergeOutcome {
  /** With blanks filled and detected baselines refreshed. */
  models: SharedProviderModel[]
  /** Differences NOT applied — for the Apply / Ignore banner. */
  changes: ProbeChange[]
  /** Served but not in the list (for "Import served models (N new)"). */
  newModelIds: string[]
  /** In the list but not served. */
  notServedIds: string[]
}

/**
 * The max output opencode uses when a model declares none (`limit.output: 0`):
 * `OUTPUT_TOKEN_MAX` (`vendor/opencode-src/packages/opencode/src/provider/transform.ts:18`),
 * applied by `maxOutputTokens` (same file, l.1469).
 */
export const OPENCODE_DEFAULT_MAX_OUTPUT = 32_000

/**
 * The max output pi's projection writes when a model declares none. The one
 * source: `PiSharedProviderAdapter`'s `DEFAULT_MAX_TOKENS` reads it, so the
 * warning measures exactly what pi is sent.
 */
export const PI_DEFAULT_MAX_OUTPUT = 16_384

const ENGINE_DEFAULT_MAX_OUTPUT: Record<ConfigurableHarnessId, number> = {
  opencode: OPENCODE_DEFAULT_MAX_OUTPUT,
  pi: PI_DEFAULT_MAX_OUTPUT
}

const FIELDS: readonly DetectField[] = ['contextWindow', 'maxTokens', 'vision', 'reasoning']

/**
 * The max output ClaudeUI suggests for a context window: a quarter of it, at
 * most 32,768 — room for a long answer without starving the prompt.
 */
export function suggestMaxOutput(context: number): number {
  return Math.min(32_768, Math.floor(context / 4))
}

/**
 * Where `model[field]` came from. `default` when it is unset (the engine's own
 * default applies); `server` — `suggested` for `maxTokens`, which no server
 * reports — while it still equals the last Detect's value; `manual` otherwise.
 */
export function fieldSource(model: SharedProviderModel, field: DetectField): FieldSource {
  const value = model[field]
  if (value === undefined) return 'default'
  const baseline = model.detected?.[field]
  if (baseline === undefined || baseline !== value) return 'manual'
  return field === 'maxTokens' ? 'suggested' : 'server'
}

/**
 * A new model row from one served model: every reported fact, a suggested max
 * output when the context is known, and a baseline holding exactly what it
 * filled.
 */
export function modelFromProbe(
  probed: EndpointProbeModel,
  server: EndpointServerKind,
  at: string
): SharedProviderModel {
  const values = probedValues(probed)
  const detected: SharedProviderModelDetected = { server, at }
  const model: SharedProviderModel = { id: probed.id }
  for (const field of FIELDS) {
    const value = values[field]
    if (value === undefined) continue
    setField(model, field, value)
    setField(detected, field, value)
  }
  return { ...model, detected }
}

/**
 * Fold a Detect result into the form's model list.
 *
 * Per existing model, matched by exact id, per field the probe (or the
 * suggestion) supplies: a blank is filled; an equal value refreshes the
 * baseline; a different value is left alone and reported as a change —
 * `edited` when the current value is the user's own rather than the server's
 * previous one. The suggestion is recomputed from the NEW context, so a
 * context the server changed carries its max output along in the diff — but
 * only while that max output is still a suggestion: one the user set is never
 * offered for replacement.
 *
 * A list holding only blank rows is the fresh Add draft: it becomes the served
 * models outright rather than asking to import them.
 */
export function mergeProbe(
  models: SharedProviderModel[],
  probe: EndpointProbeDetected,
  at: string
): MergeOutcome {
  if (models.every((model) => !model.id.trim())) {
    // A server that serves nothing leaves the draft as it is, blank row included.
    if (!probe.models.length) return { models, changes: [], newModelIds: [], notServedIds: [] }
    return {
      models: probe.models.map((probed) => modelFromProbe(probed, probe.server, at)),
      changes: [],
      newModelIds: [],
      notServedIds: []
    }
  }

  const served = new Map(probe.models.map((probed) => [probed.id, probed] as const))
  const changes: ProbeChange[] = []
  const notServedIds: string[] = []
  const merged = models.map((model) => {
    const probed = served.get(model.id)
    if (!probed) {
      if (model.id.trim()) notServedIds.push(model.id)
      return model
    }
    const values = probedValues(probed)
    const next: SharedProviderModel = { ...model }
    const detected: SharedProviderModelDetected = {
      ...model.detected,
      server: probe.server,
      at
    }
    for (const field of FIELDS) {
      const to = values[field]
      if (to === undefined) continue
      const from = model[field]
      if (from === undefined) {
        setField(next, field, to)
        setField(detected, field, to)
      } else if (from === to) {
        setField(detected, field, to)
      } else if (field !== 'maxTokens' || fieldSource(model, field) === 'suggested') {
        // The baseline stays what it was, so ignoring the change keeps the
        // badge honest: a server-owned value still reads "server". A max
        // output is only ever ClaudeUI's suggestion, so it is re-offered only
        // over a value that is still the old suggestion (the context moved);
        // the user's own never enters the diff — the output warning covers it.
        changes.push({
          modelId: model.id,
          field,
          from,
          to,
          edited: fieldSource(model, field) === 'manual'
        })
      }
    }
    return { ...next, detected }
  })

  const listed = new Set(models.map((model) => model.id))
  return {
    models: merged,
    changes,
    newModelIds: probe.models.map((probed) => probed.id).filter((id) => !listed.has(id)),
    notServedIds
  }
}

/**
 * The changes of an earlier Detect that still hold against `models` as they
 * are now. A diff waits for Apply while the user keeps editing: a change whose
 * value has since moved away from its `from` is stale — the user answered it by
 * hand — and drops out. `edited` is recomputed on the current model, and a max
 * output that has become the user's own drops out too (a suggestion is never
 * offered over it).
 */
export function liveChanges(models: SharedProviderModel[], changes: ProbeChange[]): ProbeChange[] {
  return changes.flatMap((change) => {
    const model = models.find((candidate) => candidate.id === change.modelId)
    if (!model || model[change.field] !== change.from) return []
    const edited = fieldSource(model, change.field) === 'manual'
    if (change.field === 'maxTokens' && edited) return []
    return [{ ...change, edited }]
  })
}

/**
 * Accept a Detect diff: each value becomes the probed one, and so does its
 * baseline. A stale change — the value no longer what it was offered over —
 * is skipped, so Apply can never overwrite an edit made after the diff.
 */
export function applyChanges(
  models: SharedProviderModel[],
  changes: ProbeChange[]
): SharedProviderModel[] {
  return models.map((model) => {
    const own = changes.filter(
      (change) => change.modelId === model.id && model[change.field] === change.from
    )
    if (!own.length) return model
    const next: SharedProviderModel = { ...model }
    const detected = model.detected ? { ...model.detected } : undefined
    for (const change of own) {
      setField(next, change.field, change.to)
      if (detected) setField(detected, change.field, change.to)
    }
    return detected ? { ...next, detected } : next
  })
}

/** Append rows for served models the list does not have yet. */
export function importModels(
  models: SharedProviderModel[],
  probe: EndpointProbeDetected,
  ids: string[],
  at: string
): SharedProviderModel[] {
  const listed = new Set(models.map((model) => model.id))
  const wanted = new Set(ids)
  return [
    ...models,
    ...probe.models
      .filter((probed) => wanted.has(probed.id) && !listed.has(probed.id))
      .map((probed) => modelFromProbe(probed, probe.server, at))
  ]
}

/**
 * A max output that would starve the prompt: more than half the context
 * window. Blank means the largest default among the ENABLED engines, since
 * that is what the busiest of them will reserve. Null when the context is
 * unknown (nothing to measure against) or nothing would use the value.
 * `output` is the value it measured, so the warning can name it.
 */
export function outputWarning(
  model: SharedProviderModel,
  routes: Record<ConfigurableHarnessId, { enabled: boolean }>
): { suggested: number; output: number } | null {
  const context = model.contextWindow
  if (context === undefined) return null
  const defaults = (Object.keys(ENGINE_DEFAULT_MAX_OUTPUT) as ConfigurableHarnessId[])
    .filter((engine) => routes[engine]?.enabled)
    .map((engine) => ENGINE_DEFAULT_MAX_OUTPUT[engine])
  const effective = model.maxTokens ?? (defaults.length ? Math.max(...defaults) : undefined)
  if (effective === undefined || effective <= context / 2) return null
  const suggested = suggestMaxOutput(context)
  return suggested > 0 ? { suggested, output: effective } : null
}

/** The values one served model supplies, the max output suggestion included. */
function probedValues(probed: EndpointProbeModel): Partial<Record<DetectField, number | boolean>> {
  const values: Partial<Record<DetectField, number | boolean>> = {}
  if (probed.contextWindow !== undefined) {
    values.contextWindow = probed.contextWindow
    // A context below four tokens suggests 0, which no model may declare.
    const suggested = suggestMaxOutput(probed.contextWindow)
    if (suggested > 0) values.maxTokens = suggested
  }
  if (probed.vision !== undefined) values.vision = probed.vision
  if (probed.reasoning !== undefined) values.reasoning = probed.reasoning
  return values
}

/** Numbers go to the numeric fields and booleans to the flags; a change always pairs them. */
function setField(
  target: Pick<SharedProviderModel, DetectField>,
  field: DetectField,
  value: number | boolean
): void {
  if (field === 'contextWindow' || field === 'maxTokens') target[field] = value as number
  else target[field] = value as boolean
}
