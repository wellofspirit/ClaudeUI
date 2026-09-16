/**
 * Sleep row — Codex's `clock.sleep` item, lifted out of the card shell.
 *
 * The item carries ONE number. A full `ToolCard` — header, chevron, expandable
 * body, result area — is chrome around nothing, so it takes the one-line shape
 * `TodoToolBlock` already uses (tool-survey § 6, decision 2). Unresolved it
 * spins and reads `waiting 30 s`; resolved it reads `waited 2.5 s`.
 *
 * Purely presentational: props in, DOM out, no store and no IPC, so it stays
 * flat rather than splitting into a container and a View (component guide).
 */

import type { ContentBlock } from '../../../../shared/types'
import type { ToolView } from '../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type SleepView = Extract<ToolView, { kind: 'sleep' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  view: SleepView
}

/**
 * `2.5 s` / `1 m 30 s` / `340 ms`.
 *
 * Sub-second waits keep their milliseconds (a 300 ms sleep reading "0 s" is
 * worse than no row); anything past a minute splits so a five-minute wait does
 * not read as `300 s`.
 */
export function formatSleepDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '?'
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return rest ? `${minutes} m ${rest} s` : `${minutes} m`
}

export function SleepRow({ result, view }: Props): React.JSX.Element {
  const resolved = !!result
  const duration = formatSleepDuration(view.durationMs)

  return (
    <div
      data-testid="SleepRow"
      className="flex items-center gap-2 px-2 h-7 text-[12px] text-text-secondary rounded-md bg-bg-secondary/50"
    >
      {resolved ? (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-success shrink-0"
        >
          <polyline points="4 12 10 18 20 6" />
        </svg>
      ) : (
        <span className="w-[11px] h-[11px] rounded-full border-[1.5px] border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
      )}
      <span className="font-mono text-text-muted text-[11px]">Sleep</span>
      <span data-testid="SleepRow.duration" className="truncate">
        {resolved ? `waited ${duration}` : `waiting ${duration}…`}
      </span>
    </div>
  )
}
