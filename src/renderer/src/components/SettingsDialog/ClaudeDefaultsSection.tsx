import { useMemo, useState } from 'react'
import type { AppSettings } from '../../stores/session-store'
import { useSessionStore } from '../../stores/session-store'
import type { EngineConfig, ModelInfo, VendorConfig } from '../../../../shared/types'
import {
  claudeEffortKey,
  modelDefaultEffort,
  modelSupportedEffortLevels,
  type EffortLevel
} from '../../../../shared/model-capabilities'
import { effectiveModelOverride } from '../../../../shared/model-override'
import { dedupeResolvedModels } from '../chat/InputBox/utils'
import { ModelPicker } from '../shared/InlinePickers'
import { toModelDisplays, selectedModelDisplay, StaleModelNotice } from './settings-model-display'
import { Button, SelectField, SettingRow } from './settings-controls'
import type { SettingsTarget } from './settings-target'

/**
 * Models & providers › Default models › Claude (ADR-074 §8, mockup C left).
 *
 * Two settings, both built from the live `supportedModels()` list cli.js reports
 * for the signed-in account rather than a list baked into this file — which is
 * how the old table came to lack the model `opus` actually resolves to:
 *
 *  - **Start new sessions on** — `engines/claude.json#claudeConfig.defaultModel`,
 *    ClaudeUI's own file, so the terminal `claude` keeps its default. Blank is
 *    Claude's `default` alias, i.e. today's behaviour; the store resolves a
 *    configured value that has vanished to "Select a model" + banner (ADR-059).
 *  - **Starting effort per model** — `settings.modelEffortDefaults`, one row per
 *    distinct `claudeEffortKey`: the key the composer reads at spawn, so an alias
 *    row and the model it resolves to share one setting. The aliases that reach
 *    a row are listed beside it instead of being explained in a footer.
 *
 * A saved effort for a model the account no longer offers is listed, folded,
 * with Remove — not dropped, and not hidden. When Claude › Model mapping pins
 * one model or renames aliases, a banner says so, since either overrides what
 * this card configures.
 */

/** Testid namespace (ADR-027). */
const T = 'ClaudeDefaultsSection'

const EFFORT_LEVEL_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** cli.js's "follow what Claude recommends for this account" row. */
const DEFAULT_ALIAS = 'default'

/** One table row: every catalog row that shares an effort key. */
export interface ClaudeEffortRow {
  key: string
  name: string
  /** Picker values that reach this model under another name. */
  aliases: string[]
  /** Every catalog value in the group, the key itself included when listed. */
  values: string[]
  levels: EffortLevel[]
  fallback: EffortLevel
}

/**
 * Group the Claude catalog by `claudeEffortKey`, in cli.js's own order.
 *
 * The NAME comes from the concrete row (`value` is a `claude-…` id) when the
 * group has one, else from the first row that is not `default` — whose display
 * name is "Default (recommended)", which says nothing about the model. Levels
 * come from the same row's `supportedEffortLevels`, falling back to the id
 * heuristic for the key.
 */
export function buildClaudeEffortRows(models: ModelInfo[]): ClaudeEffortRow[] {
  const groups = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const key = claudeEffortKey(m)
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), m])
  }
  return [...groups.entries()].map(([key, rows]) => {
    const rep =
      rows.find((r) => r.value.toLowerCase().startsWith('claude-')) ??
      rows.find((r) => r.value !== DEFAULT_ALIAS) ??
      rows[0]
    // The row's capability flags, judged against the KEY: an alias value is
    // opaque to the id heuristic the fallback uses.
    const probe = {
      value: key,
      supportsEffort: rep.supportsEffort,
      supportedEffortLevels: rep.supportedEffortLevels
    }
    return {
      key,
      name: rep.displayName || rep.value,
      aliases: rows.map((r) => r.value).filter((v) => v !== key),
      values: rows.map((r) => r.value),
      levels: modelSupportedEffortLevels(probe),
      fallback: modelDefaultEffort(probe)
    }
  })
}

export function ClaudeDefaultsSection({
  settings,
  update,
  engineConfig,
  updateEngineConfig,
  vendorConfig,
  navigate
}: {
  settings: AppSettings
  update: (p: Partial<AppSettings>) => void
  engineConfig: EngineConfig
  updateEngineConfig: (p: Partial<EngineConfig>) => void
  vendorConfig: VendorConfig
  navigate?: (target: SettingsTarget) => void
}): React.JSX.Element {
  const availableModels = useSessionStore((s) => s.availableModels)
  const claude = useMemo(
    () => availableModels.filter((m) => (m.engineId ?? 'claude') === 'claude'),
    [availableModels]
  )
  const rows = useMemo(() => buildClaudeEffortRows(claude), [claude])
  const [orphansOpen, setOrphansOpen] = useState(false)

  const claudeConfig = engineConfig.claudeConfig ?? {}
  const defaultModel = claudeConfig.defaultModel ?? ''
  const efforts = settings.modelEffortDefaults ?? {}

  // `default` is the empty option's job, so it is not offered twice; the
  // concrete row it collapses with (`opus[1m]`) then survives the dedupe.
  const pickable = useMemo(
    () =>
      dedupeResolvedModels(
        claude.filter((m) => m.value !== DEFAULT_ALIAS),
        defaultModel
      ),
    [claude, defaultModel]
  )
  const defaultRow = rows.find((r) => r.values.includes(DEFAULT_ALIAS))
  const emptyLabel = defaultRow
    ? `Default (recommended) → ${defaultRow.name}`
    : 'Default (recommended)'
  const startsHere = rows.find((r) => r.values.includes(defaultModel || DEFAULT_ALIAS))?.key

  const saveDefaultModel = (value: string): void => {
    // Blank DELETES the key rather than writing '': unset is the whole meaning.
    const next = { ...claudeConfig }
    if (value) next.defaultModel = value
    else delete next.defaultModel
    updateEngineConfig({ claudeConfig: next })
    // Mirror into the store so sessions created later in THIS app run pick the
    // change up without a restart — the same rule `setPiDefaultModel` follows.
    useSessionStore.getState().setClaudeDefaultModel(value)
  }
  const saveEffort = (key: string, next: EffortLevel | undefined): void => {
    const map = { ...efforts }
    if (next === undefined) delete map[key]
    else map[key] = next
    update({ modelEffortDefaults: map })
  }

  const override = effectiveModelOverride(vendorConfig.modelOverride)
  const renames = (
    [
      ['sonnet', override.sonnet],
      ['opus', override.opus],
      ['haiku', override.haiku]
    ] as const
  ).filter((pair): pair is readonly ['sonnet' | 'opus' | 'haiku', string] => pair[1] !== null)
  const openMapping = navigate
    ? (): void => navigate({ page: 'claude', group: 'model-mapping' })
    : undefined

  const tableKeys = new Set(rows.map((r) => r.key))
  const orphans = Object.entries(efforts).filter(
    (entry): entry is [string, EffortLevel] => !tableKeys.has(entry[0]) && !!entry[1]
  )
  const loaded = claude.length > 0

  return (
    <div data-testid={T} className="divide-y divide-border/55">
      {override.pin ? (
        <Banner testid={`${T}.pinBanner`} onOpen={openMapping}>
          Every Claude session is pinned to <span className="font-mono">{override.pin}</span> on
          Claude › Endpoint — the default model and the picker are ignored until that is turned off.
        </Banner>
      ) : renames.length > 0 ? (
        <Banner testid={`${T}.renameBanner`} onOpen={openMapping}>
          The gateway renames aliases (Claude › Endpoint):{' '}
          {renames.map(([alias, to], i) => (
            <span key={alias}>
              {i > 0 && ', '}
              <AliasChip>{alias}</AliasChip> → <span className="font-mono">{to}</span>
            </span>
          ))}
          . Efforts below still apply by alias.
        </Banner>
      ) : null}

      <div>
        <SettingRow
          testid={`${T}.defaultModelRow`}
          label="Start new sessions on"
          description="“Default” follows what Claude recommends for your account."
          keyText="engines/claude.json · claudeConfig.defaultModel"
          dimmed={!!override.pin}
          modified={defaultModel !== ''}
          onReset={() => saveDefaultModel('')}
        >
          <span data-testid={`${T}.defaultModel`} data-value={defaultModel}>
            <ModelPicker
              variant="field"
              placement="down"
              emptyOption={{ label: emptyLabel }}
              models={toModelDisplays(pickable)}
              selectedModel={selectedModelDisplay(claude, defaultModel, emptyLabel)}
              onSelectModel={saveDefaultModel}
            />
          </span>
        </SettingRow>
        <StaleModelNotice testid={`${T}.defaultModel`} models={claude} value={defaultModel} />
      </div>

      <div>
        <SettingRow
          testid={`${T}.effortHeader`}
          label="Starting effort per model"
          trailing={
            <span className="text-[12px] text-text-secondary">
              from Claude ·{' '}
              <Button
                testid={`${T}.refresh`}
                variant="link"
                onClick={() => useSessionStore.getState().reloadModels()}
              >
                Refresh
              </Button>
            </span>
          }
        />
        {loaded ? (
          <div className="overflow-x-auto">
            <table data-testid={`${T}.effortTable`} className="w-full border-collapse text-left">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.06em] text-text-muted">
                  <th className="font-semibold px-3.5 py-2 border-b border-border/55">Model</th>
                  <th className="font-semibold px-3.5 py-2 border-b border-border/55">Picked as</th>
                  <th className="font-semibold px-3.5 py-2 border-b border-border/55 text-right">
                    Starts at
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/55">
                {rows.map((row) => {
                  const current = efforts[row.key]
                  return (
                    <tr key={row.key} data-testid={`${T}.effortRow`} data-id={row.key}>
                      <td className="px-3.5 py-2 align-middle">
                        <span className="flex items-center gap-2 text-[13px] text-text-primary">
                          {row.name}
                          {row.key === startsHere && (
                            <span
                              data-testid={`${T}.startsHere`}
                              className="shrink-0 border border-accent/40 bg-accent/10 text-accent rounded-full px-[7px] text-[10.5px] leading-4"
                            >
                              starts here
                            </span>
                          )}
                        </span>
                        <span className="block font-mono text-[11px] leading-4 text-text-muted">
                          {row.key}
                        </span>
                      </td>
                      <td
                        data-testid={`${T}.aliases`}
                        data-id={row.key}
                        className="px-3.5 py-2 align-middle"
                      >
                        {row.aliases.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {row.aliases.map((a) => (
                              <AliasChip key={a}>{a}</AliasChip>
                            ))}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3.5 py-2 align-middle">
                        <span className="flex items-center justify-end gap-2">
                          {row.levels.length > 0 ? (
                            <>
                              <SelectField
                                testid={`${T}.effort`}
                                dataId={row.key}
                                value={current ?? ''}
                                onChange={(v) =>
                                  saveEffort(row.key, v === '' ? undefined : (v as EffortLevel))
                                }
                                options={[
                                  {
                                    value: '',
                                    label: `Default (${EFFORT_LEVEL_LABEL[row.fallback]})`
                                  },
                                  ...row.levels.map((lvl) => ({
                                    value: lvl,
                                    label: EFFORT_LEVEL_LABEL[lvl]
                                  }))
                                ]}
                              />
                              {current && (
                                <Button
                                  testid={`${T}.effortReset`}
                                  dataId={row.key}
                                  variant="link"
                                  onClick={() => saveEffort(row.key, undefined)}
                                >
                                  reset
                                </Button>
                              )}
                            </>
                          ) : (
                            <span
                              data-testid={`${T}.noEffort`}
                              data-id={row.key}
                              className="text-[12px] text-text-secondary"
                            >
                              No effort control
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <SettingRow
            testid={`${T}.notLoaded`}
            description="Claude's model list isn't loaded yet — it arrives when Claude starts, or Refresh."
          />
        )}
      </div>

      {orphans.length > 0 && (
        <div data-testid={`${T}.orphans`}>
          <button
            type="button"
            data-testid={`${T}.orphansToggle`}
            aria-expanded={orphansOpen}
            onClick={() => setOrphansOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left text-[12px] text-warning hover:bg-bg-hover/40 transition-colors cursor-default"
          >
            <span aria-hidden>{orphansOpen ? '▾' : '▸'}</span>
            {/* Without a loaded list nothing is known to be gone — just saved. */}
            {loaded
              ? `${orphans.length} saved ${orphans.length === 1 ? 'setting' : 'settings'} for a model this account no longer offers`
              : `${orphans.length} saved effort ${orphans.length === 1 ? 'setting' : 'settings'}`}
          </button>
          {orphansOpen &&
            orphans.map(([key, level]) => (
              <SettingRow
                key={key}
                testid={`${T}.orphan`}
                dataId={key}
                indent
                label={key}
                labelClassName="font-mono text-[12px] text-text-primary"
                description={`starts at ${EFFORT_LEVEL_LABEL[level] ?? level}`}
              >
                <Button
                  testid={`${T}.orphanRemove`}
                  dataId={key}
                  variant="link"
                  onClick={() => saveEffort(key, undefined)}
                >
                  Remove
                </Button>
              </SettingRow>
            ))}
        </div>
      )}

      <SettingRow
        testid={`${T}.note`}
        description="The effort chip in the composer always wins for the session you are in."
      />
    </div>
  )
}

function AliasChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="font-mono text-[11px] leading-4 px-1.5 rounded-[5px] bg-bg-primary border border-border text-text-secondary">
      {children}
    </span>
  )
}

/** The warning strip for a Claude › Model mapping setting that overrides this card. */
function Banner({
  testid,
  onOpen,
  children
}: {
  testid: string
  onOpen?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="px-3.5 py-3">
      <div
        data-testid={testid}
        className="border-l-2 border-warning bg-warning/5 rounded-r-md px-3 py-2 text-[12px] leading-4 text-text-secondary"
      >
        {children}{' '}
        {onOpen && (
          <Button testid={`${testid}.open`} variant="link" onClick={onOpen}>
            Open ›
          </Button>
        )}
      </div>
    </div>
  )
}
