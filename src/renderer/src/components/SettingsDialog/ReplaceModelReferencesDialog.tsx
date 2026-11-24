/**
 * ReplaceModelReferencesDialog — what unticking a model in a provider's curation
 * opens when a setting still names that model (the orphan guard, ADR-074 §2).
 *
 * One row per reference: the setting's title and breadcrumb, the model being
 * replaced, and a themed picker of what it could use instead. Apply writes the
 * choices, then hands back to the container (`onResolved`), which performs the
 * untick it was asked for through its own writer.
 *
 * THE DIALOG ONLY RESOLVES REFERENCES. It never touches the curation list. Its
 * writes are the settings the rows stand for, and each file is written ONCE:
 *
 *  · `engines/<e>.json` through `patchEngineConfigFile` (a fresh read, every
 *    patch for that engine merged, one save);
 *  · `opencode.jsonc` through `saveOpencodeSettings(settings, snapshot)`, the
 *    way `OpencodeModelsSection` writes it, so only the change lands;
 *  · the store mirrors the settings rows keep (`setPiDefaultModel`,
 *    `setOpencodeDefaultModel`), then `reloadModels()` once.
 *
 * Writes run in order and the first failure stops the run: the dialog stays
 * open with the error and the untick is not performed. What was already written
 * stays written — each is a choice the user made.
 *
 * CANDIDATES are the engine's OWN models minus every value this untick removes
 * (per engine: a pi value and an opencode value share a namespace but not a
 * list). Judge and fallback-judge rows are narrowed again by the judge rules the
 * judge settings use (`judge-model-rules.ts`).
 *
 * DISPATCH ALLOWED MODELS: an empty list means "any model", so removing the last
 * entry WIDENS what a dispatching agent may request. "Remove from the list" is
 * therefore the pre-selected choice only while other entries remain; otherwise
 * the row starts undecided and the empty choice is labelled "Allow any model".
 */

import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type {
  ModelReference,
  ModelReferenceKind,
  ModelReferenceSources
} from '../../../../shared/model-references'
import type {
  EngineConfig,
  EngineId,
  EngineModelGroup,
  ModelInfo,
  OpencodeConfigSettings
} from '../../../../shared/types'
import type { SharedProviderAccountList } from '../../../../shared/shared-provider'
import { ModelPicker } from '../shared/InlinePickers'
import { useEscapeLayer } from '../shared/use-escape-layer'
import { selectedModelDisplay, toModelDisplays } from './settings-model-display'
import {
  DISPATCH_MODEL_DEFAULT_LABEL,
  FALLBACK_JUDGE_EMPTY_LABEL,
  JUDGE_MODEL_DEFAULT_LABEL,
  OPENCODE_MODEL_DEFAULT_LABEL,
  PI_MODEL_DEFAULT_LABEL
} from './model-default-labels'
import {
  FALLBACK_SAME_JUDGE_WARNING,
  fallbackJudgePatch,
  fallbackSameAsJudge,
  judgeCandidates,
  useJudgeModelSupport,
  type JudgeSupportMap,
  type JudgeSupportState
} from './judge-model-rules'
import { patchEngineConfigFile } from './use-engine-config'

const TID = 'ReplaceModelReferencesDialog'
const UNDECIDED = '__undecided__'
const REMOVE_LABEL = 'Remove from the list'
const ANY_LABEL = 'Allow any model'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Everything a container's reference scan reads, loaded fresh, plus the
 * discovered picker models. Shared by both containers so "re-read after the
 * dialog" is the same read as the first one.
 */
export async function loadReferenceSources(): Promise<{
  sources: ModelReferenceSources
  groups: EngineModelGroup[]
}> {
  const [opencode, groups, configs] = await Promise.all([
    window.api.loadOpencodeSettings().catch(() => ({}) as OpencodeConfigSettings),
    window.api.getEngineModels().catch((): EngineModelGroup[] => []),
    Promise.all(
      (['claude', 'opencode', 'pi'] as EngineId[]).map(
        async (id) =>
          [id, await window.api.loadEngineConfig(id).catch(() => ({}) as EngineConfig)] as const
      )
    )
  ])
  return { sources: { opencode, engines: Object.fromEntries(configs) }, groups }
}

/** The empty option each setting's own picker offers (the row's "no explicit choice"). */
function emptyLabel(kind: ModelReferenceKind, widening: boolean): string {
  switch (kind) {
    case 'opencodeDefault':
    case 'opencodeSmall':
      return OPENCODE_MODEL_DEFAULT_LABEL
    case 'piDefault':
      return PI_MODEL_DEFAULT_LABEL
    case 'judge':
      return JUDGE_MODEL_DEFAULT_LABEL
    case 'fallbackJudge':
      return FALLBACK_JUDGE_EMPTY_LABEL
    case 'dispatchDefault':
      return DISPATCH_MODEL_DEFAULT_LABEL
    case 'dispatchAllowed':
      return widening ? ANY_LABEL : REMOVE_LABEL
  }
}

const isJudgeKind = (kind: ModelReferenceKind): boolean =>
  kind === 'judge' || kind === 'fallbackJudge'

/** Apply the decided rows for one engine's file onto a fresh read of it. */
function applyEngineRows(
  cfg: EngineConfig,
  rows: Array<{ ref: ModelReference; value: string }>,
  support: JudgeSupportMap | null
): EngineConfig {
  let next = cfg
  for (const { ref, value } of rows) {
    switch (ref.kind) {
      case 'judge':
        next = { ...next, autoMode: { ...next.autoMode, judgeModel: value || undefined } }
        break
      case 'fallbackJudge':
        next = { ...next, autoMode: { ...next.autoMode, ...fallbackJudgePatch(value, support) } }
        break
      case 'dispatchDefault':
        next = { ...next, dispatch: { ...next.dispatch, defaultModel: value || undefined } }
        break
      case 'dispatchAllowed': {
        const list = next.dispatch?.allowedModels ?? []
        // A replacement already allowed just drops the old entry (no duplicate).
        const out =
          value === '' || list.includes(value)
            ? list.filter((m) => m !== ref.model)
            : list.map((m) => (m === ref.model ? value : m))
        // Empty and absent both mean "any model"; the absent form keeps the file clean.
        next = {
          ...next,
          dispatch: { ...next.dispatch, allowedModels: out.length > 0 ? out : undefined }
        }
        break
      }
      case 'piDefault':
        next = { ...next, piConfig: { ...next.piConfig, defaultModel: value || undefined } }
        break
    }
  }
  return next
}

export function ReplaceModelReferencesDialog({
  references,
  removals,
  awaitPendingWrites,
  onResolved,
  onCancel
}: {
  /** One row each, in the order given. */
  references: ModelReference[]
  /** The picker VALUES this untick removes, per engine. */
  removals: Partial<Record<EngineId, string[]>>
  /** Resolves once the container's own queued curation writes have landed. */
  awaitPendingWrites: () => Promise<void>
  /** Performs the untick; the container also closes the dialog. May reject. */
  onResolved: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [models, setModels] = useState<Partial<Record<EngineId, ModelInfo[]>>>({})
  const [configs, setConfigs] = useState<Partial<Record<EngineId, EngineConfig>>>({})
  const [accounts, setAccounts] = useState<SharedProviderAccountList | null>(null)
  const [choices, setChoices] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscapeLayer(onCancel, !busy)

  const engines = [...new Set(references.map((r) => r.engine))]
  const enginesKey = engines.join(',')
  const hasJudgeRows = references.some((r) => isJudgeKind(r.kind))

  useEffect(() => {
    let live = true
    for (const engine of enginesKey.split(',') as EngineId[]) {
      window.api
        .getEngineModels(engine)
        .catch((): EngineModelGroup[] => [])
        .then((groups) => {
          const own = groups.filter((g) => g.engineId === engine).flatMap((g) => g.models)
          if (live) setModels((prev) => ({ ...prev, [engine]: own }))
        })
      window.api
        .loadEngineConfig(engine)
        .catch(() => ({}) as EngineConfig)
        .then((cfg) => {
          if (live) setConfigs((prev) => ({ ...prev, [engine]: cfg }))
        })
    }
    return () => {
      live = false
    }
  }, [enginesKey])

  useEffect(() => {
    if (!hasJudgeRows) return
    let live = true
    window.api
      .listProviderAccounts('chatgpt')
      .then((list) => {
        if (live) setAccounts(list)
      })
      // No account list: the warning is judged without one, as the settings row does.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [hasJudgeRows])

  const loaded = engines.every((e) => models[e] !== undefined && configs[e] !== undefined)

  // One judge-support ask per engine, over that engine's FULL list. Fixed calls,
  // not a loop: the hook count must not depend on the references.
  const judgeModelsOf = (e: EngineId): ModelInfo[] =>
    references.some((r) => r.engine === e && isJudgeKind(r.kind)) ? (models[e] ?? []) : []
  const opencodeSupport = useJudgeModelSupport('opencode', judgeModelsOf('opencode'))
  const piSupport = useJudgeModelSupport('pi', judgeModelsOf('pi'))
  // The judge route only exists for opencode and pi; a claude file's judge rows stay unfiltered.
  const supportOf = (e: EngineId): JudgeSupportState =>
    e === 'opencode'
      ? opencodeSupport
      : e === 'pi'
        ? piSupport
        : { status: 'failed', support: null }

  /** Whether the allowed list for `e` would empty (= widen to "any model"). */
  const wideningOf = (e: EngineId): boolean => {
    const gone = new Set(removals[e] ?? [])
    return (configs[e]?.dispatch?.allowedModels ?? []).every((m) => gone.has(m))
  }

  /** A row's decision: the user's pick, else the safe default, else undecided. */
  const decisionOf = (index: number): string | undefined => {
    const picked = choices[index]
    if (picked !== undefined) return picked
    const ref = references[index]
    return ref.kind === 'dispatchAllowed' && loaded && !wideningOf(ref.engine) ? '' : undefined
  }

  const judgeBusy = (e: EngineId): boolean =>
    supportOf(e).status === 'loading' && judgeModelsOf(e).length > 0

  const candidatesOf = (ref: ModelReference): ModelInfo[] => {
    const gone = new Set(removals[ref.engine] ?? [])
    const rest = (models[ref.engine] ?? []).filter((m) => !gone.has(m.value))
    return isJudgeKind(ref.kind) ? judgeCandidates(rest, supportOf(ref.engine).support) : rest
  }

  /** Whether the judge and the fallback of `e` end up the same model on the same account. */
  const sameJudge = (e: EngineId): boolean => {
    const judgeAt = references.findIndex((r) => r.engine === e && r.kind === 'judge')
    const fallbackAt = references.findIndex((r) => r.engine === e && r.kind === 'fallbackJudge')
    if (judgeAt < 0 && fallbackAt < 0) return false
    const auto = configs[e]?.autoMode
    const judge = judgeAt < 0 ? (auto?.judgeModel ?? '') : decisionOf(judgeAt)
    const fallback = fallbackAt < 0 ? (auto?.fallbackJudgeModel ?? '') : decisionOf(fallbackAt)
    if (judge === undefined || fallback === undefined) return false
    const support = supportOf(e).support
    const patch = fallbackAt < 0 ? {} : fallbackJudgePatch(fallback, support)
    const fallbackAccount =
      'fallbackJudgeAccount' in patch
        ? (patch.fallbackJudgeAccount ?? '')
        : (auto?.fallbackJudgeAccount ?? '')
    return fallbackSameAsJudge({
      judge,
      fallback,
      fallbackAccount,
      activeAccountId: accounts?.activeId ?? null,
      support
    })
  }

  const allDecided = references.every((_, i) => decisionOf(i) !== undefined)

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    let wrote = false
    const store = useSessionStore.getState()
    try {
      await awaitPendingWrites()
      const rows = references.map((ref, i) => ({ ref, value: decisionOf(i) ?? '' }))
      for (const engine of engines) {
        const mine = rows.filter(
          ({ ref }) =>
            ref.engine === engine && ref.kind !== 'opencodeDefault' && ref.kind !== 'opencodeSmall'
        )
        if (mine.length === 0) continue
        await patchEngineConfigFile(engine, (fresh) =>
          applyEngineRows(fresh, mine, supportOf(engine).support)
        )
        wrote = true
        const pi = mine.find(({ ref }) => ref.kind === 'piDefault')
        if (pi) store.setPiDefaultModel(pi.value)
      }
      const native = rows.filter(
        ({ ref }) => ref.kind === 'opencodeDefault' || ref.kind === 'opencodeSmall'
      )
      if (native.length > 0) {
        const snapshot = await window.api.loadOpencodeSettings()
        const next: OpencodeConfigSettings = { ...snapshot }
        for (const { ref, value } of native) {
          if (ref.kind === 'opencodeDefault') next.model = value || undefined
          else next.smallModel = value || undefined
        }
        // Never the allowlist read here: the Manage sheet curates it through its own writer.
        const { modelAllowlist: _stale, ...settings } = next
        await window.api.saveOpencodeSettings(settings, snapshot)
        wrote = true
        const def = native.find(({ ref }) => ref.kind === 'opencodeDefault')
        if (def) store.setOpencodeDefaultModel(def.value)
      }
      if (wrote) store.reloadModels()
      await onResolved()
    } catch (e) {
      if (wrote) store.reloadModels()
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid={TID} className="fixed inset-0 z-[110] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={busy ? undefined : onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Replace models still in use"
        className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[520px] max-w-[calc(100%-2rem)] max-h-[90%] overflow-y-auto p-5 animate-fade-in"
      >
        <h3 className="text-[15px] font-medium text-text-primary mb-1">
          Replace models still in use
        </h3>
        <p className="text-[13px] leading-relaxed text-text-secondary mb-3">
          {references.length === 1
            ? 'A setting uses a model you are removing. Choose what it should use instead.'
            : 'These settings use models you are removing. Choose what each should use instead.'}
        </p>
        <div className="divide-y divide-border/55 border border-border rounded-lg">
          {references.map((ref, index) => {
            const own = models[ref.engine] ?? []
            const shown = own.find((m) => m.value === ref.model)?.displayName || ref.model
            const decision = decisionOf(index)
            const widening = ref.kind === 'dispatchAllowed' && wideningOf(ref.engine)
            const label = emptyLabel(ref.kind, widening)
            const candidates = candidatesOf(ref)
            const rowId = `${ref.kind}:${ref.engine}`
            const waiting = !loaded || (isJudgeKind(ref.kind) && judgeBusy(ref.engine))
            return (
              <div
                key={index}
                data-testid={`${TID}.row`}
                data-id={rowId}
                data-model={ref.model}
                className="px-3.5 py-3"
              >
                <div className="text-[13px] font-medium text-text-primary">{ref.title}</div>
                <div className="text-[11px] leading-4 text-text-muted">{ref.where}</div>
                <div className="mt-1 text-[12px] text-text-secondary">
                  Replacing <span className="text-text-primary">{shown}</span>
                  {shown !== ref.model && (
                    <span className="font-mono text-text-muted">{` (${ref.model})`}</span>
                  )}
                </div>
                <div className="mt-2">
                  {waiting ? (
                    <span className="text-[12px] text-text-muted">
                      {loaded ? 'Checking which models can judge…' : 'Loading models…'}
                    </span>
                  ) : (
                    <span
                      data-testid={`${TID}.picker`}
                      data-id={rowId}
                      data-value={decision ?? UNDECIDED}
                    >
                      <ModelPicker
                        variant="field"
                        placement="down"
                        emptyOption={{ label }}
                        models={toModelDisplays(candidates)}
                        selectedModel={
                          decision === undefined
                            ? {
                                value: UNDECIDED,
                                displayName: 'Choose a replacement…',
                                shortName: 'Choose a replacement…'
                              }
                            : selectedModelDisplay(candidates, decision, label)
                        }
                        onSelectModel={(v) => setChoices((prev) => ({ ...prev, [index]: v }))}
                      />
                    </span>
                  )}
                </div>
                {isJudgeKind(ref.kind) && sameJudge(ref.engine) && (
                  <div
                    data-testid={`${TID}.sameJudgeWarning`}
                    data-id={rowId}
                    className="mt-2 text-[12px] leading-4 text-warning"
                  >
                    {FALLBACK_SAME_JUDGE_WARNING}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {error && (
          <div
            data-testid={`${TID}.error`}
            className="mt-3 text-[12px] bg-red-500/10 border border-red-500/30 text-red-400 rounded px-3 py-2 break-all"
          >
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${TID}.cancel`}
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors cursor-default"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid={`${TID}.apply`}
            onClick={() => void apply()}
            disabled={busy || !loaded || !allDecided}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-accent hover:bg-accent-hover disabled:opacity-50 transition-colors cursor-default"
          >
            {busy ? 'Applying…' : 'Apply and remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
