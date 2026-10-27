/**
 * Settings › Sessions & autonomy › Context pressure (session tools, slice 4, spec §6.6).
 *
 * The user picks when a long session should hand off: a mode (Off, Ask, Automatic) and up to
 * four thresholds, each a percent of the model's window. At the end of a turn in which a
 * session crossed one, ClaudeUI shows a banner above the composer (Ask) or tells the session
 * to wrap up and call session_hand_off (Automatic).
 *
 * The value lives in ClaudeUI's own settings (`contextPressure`) and travels through the normal
 * `update` write, so it replicates to every client like any other setting; the host checks it
 * again on save. A threshold above the point where the engine compacts by itself is flagged,
 * per engine and model among the open sessions: Claude Code compacts at the window minus 33k
 * tokens (83 % of a 200k window, 97 % of 1M), so a threshold past that is never reached.
 *
 * Controls are 32px tall and wrap, so the one body serves the desktop dialog, the browser and
 * the phone's settings view (no viewport units, ADR-093).
 */
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  MAX_THRESHOLDS,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  ceilingRows,
  normalizeContextPressure,
  thresholdAboveCeiling,
  type CeilingRow,
  type ContextPressureMode
} from '../../../../shared/context-pressure'
import { engineMeta } from '../../../../shared/engine-meta'
import type { EngineId } from '../../../../shared/types'
import { useSessionStore, type AppSettings } from '../../stores/session-store'
import { SettingRow } from './settings-controls'

const MODE_OPTIONS: { value: ContextPressureMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Never prompt about context.' },
  { value: 'ask', label: 'Ask', hint: 'Show a banner above the composer.' },
  { value: 'auto', label: 'Automatic', hint: 'Tell the session to hand off by itself.' }
]

const MODE_DESCRIPTION: Record<ContextPressureMode, string> = {
  off: 'Context fills up silently until the engine compacts it.',
  ask: 'When a session crosses a threshold, a banner above the composer offers to continue in a new session.',
  auto: 'When a session crosses a threshold, ClaudeUI tells it to finish or park its step and hand off to a new session.'
}

const windowLabel = (size: number): string =>
  size >= 1_000_000 ? `${size / 1_000_000}M` : `${Math.round(size / 1000)}k`

/**
 * The engine/model/window of every open session that reports a window. Selected as one flat array
 * of primitives (engine, model, size per session) so `useShallow` can tell nothing changed on a
 * store tick without building a string.
 */
function useOpenWindows(): CeilingRow[] {
  const flat = useSessionStore(
    useShallow((s) =>
      Object.values(s.sessions).flatMap((session) => {
        const size = session.statusLine?.contextWindow.size ?? 0
        return size > 0
          ? [session.selectedEngineId, session.status.model?.modelId ?? session.selectedModel, size]
          : []
      })
    )
  )
  return useMemo(() => {
    const open: { engine: EngineId; model: string; windowSize: number }[] = []
    for (let i = 0; i < flat.length; i += 3) {
      open.push({
        engine: flat[i] as EngineId,
        model: flat[i + 1] as string,
        windowSize: flat[i + 2] as number
      })
    }
    return ceilingRows(open)
  }, [flat])
}

export function ContextPressureSettings({
  settings,
  update
}: {
  settings: AppSettings
  update: (p: Partial<AppSettings>) => void
}): React.JSX.Element {
  const value = normalizeContextPressure(settings.contextPressure)
  const rows = useOpenWindows()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const write = (next: Partial<typeof value>): void =>
    update({ contextPressure: { ...value, ...next } })

  const add = (): void => {
    const text = draft.trim()
    const n = Number(text)
    if (text === '' || !Number.isInteger(n) || n < THRESHOLD_MIN || n > THRESHOLD_MAX) {
      setError(`Use a whole number from ${THRESHOLD_MIN} to ${THRESHOLD_MAX}.`)
      return
    }
    if (value.thresholds.includes(n)) {
      setError(`${n} % is already in the list.`)
      return
    }
    if (value.thresholds.length >= MAX_THRESHOLDS) {
      setError(`At most ${MAX_THRESHOLDS} thresholds. Remove one first.`)
      return
    }
    setError(null)
    setDraft('')
    write({ thresholds: [...value.thresholds, n].sort((a, b) => a - b) })
  }

  return (
    <div data-testid="ContextPressureSettings" className="divide-y divide-border/55">
      <SettingRow
        testid="ContextPressureSettings.modeRow"
        label="When a session's context fills up"
        description={MODE_DESCRIPTION[value.mode]}
        layout="stacked"
        modified={settings.contextPressure !== undefined}
        onReset={() => update({ contextPressure: undefined })}
      >
        <span
          role="radiogroup"
          aria-label="Context pressure mode"
          data-testid="ContextPressureSettings.mode"
          className="inline-flex flex-wrap items-center gap-1"
        >
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value.mode === option.value}
              data-testid="ContextPressureSettings.mode.option"
              data-id={option.value}
              title={option.hint}
              onClick={() => write({ mode: option.value })}
              className={`min-h-8 px-3 rounded-md border text-[12px] transition-colors cursor-default ${
                value.mode === option.value
                  ? 'border-accent/50 bg-accent/15 text-accent font-medium'
                  : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {option.label}
            </button>
          ))}
        </span>
      </SettingRow>

      <SettingRow
        testid="ContextPressureSettings.thresholdsRow"
        label="Thresholds"
        description={`Percent of the model's window, ${THRESHOLD_MIN} to ${THRESHOLD_MAX}, up to ${MAX_THRESHOLDS}. Acted on at the end of a turn, once per crossing.`}
        layout="stacked"
        dimmed={value.mode === 'off'}
        error={error ?? undefined}
        errorTestid="ContextPressureSettings.error"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          {value.thresholds.map((t) => (
            <span
              key={t}
              data-testid="ContextPressureSettings.threshold"
              data-id={String(t)}
              className="inline-flex items-center min-h-8 rounded-md border border-border pl-3 text-[12px] text-text-primary"
            >
              {t} %
              <button
                type="button"
                data-testid="ContextPressureSettings.remove"
                data-id={String(t)}
                aria-label={`Remove ${t} %`}
                disabled={value.thresholds.length <= 1}
                title={
                  value.thresholds.length <= 1 ? 'At least one threshold stays' : `Remove ${t} %`
                }
                onClick={() => {
                  setError(null)
                  write({ thresholds: value.thresholds.filter((x) => x !== t) })
                }}
                className="min-h-8 min-w-8 inline-flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-40 cursor-default"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
          <input
            type="text"
            inputMode="numeric"
            data-testid="ContextPressureSettings.input"
            aria-label="New threshold, percent"
            placeholder="%"
            value={draft}
            maxLength={3}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            className="h-8 w-16 rounded-md border border-border bg-bg-input px-2 text-[12px] text-text-primary outline-none focus:border-accent/60"
          />
          <button
            type="button"
            data-testid="ContextPressureSettings.add"
            onClick={add}
            className="min-h-8 px-3 rounded-md border border-border text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-default"
          >
            Add
          </button>
        </span>
      </SettingRow>

      <SettingRow
        testid="ContextPressureSettings.ceilingRow"
        label="Where each model compacts"
        description="From the sessions open now. Claude Code compacts a session by itself at its window minus 33k tokens; a threshold past that point is never reached."
        layout="stacked"
      >
        {rows.length === 0 ? (
          <span
            data-testid="ContextPressureSettings.ceilingEmpty"
            className="block text-[12px] leading-4 text-text-muted"
          >
            Open a session to see its model here.
          </span>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[12px] leading-4">
            {rows.map((row) => {
              const never = value.thresholds.filter((t) =>
                thresholdAboveCeiling(t, row.ceilingPercent)
              )
              return (
                <li
                  key={`${row.engine}:${row.model}:${row.windowSize}`}
                  data-testid="ContextPressureSettings.ceiling"
                  data-engine={row.engine}
                  className="break-words text-text-secondary"
                >
                  <span className="text-text-primary">
                    {engineMeta(row.engine).label} · {row.model}
                  </span>{' '}
                  · {windowLabel(row.windowSize)} window ·{' '}
                  <span data-testid="ContextPressureSettings.ceilingValue">
                    {row.ceilingPercent === null
                      ? 'compaction point unknown'
                      : `compacts at ${Math.floor(row.ceilingPercent)} %`}
                  </span>
                  {never.length > 0 && (
                    <span
                      data-testid="ContextPressureSettings.never"
                      className="block text-warning"
                    >
                      {never.map((t) => `${t} %`).join(', ')} never reached: Claude compacts first.
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SettingRow>
    </div>
  )
}
