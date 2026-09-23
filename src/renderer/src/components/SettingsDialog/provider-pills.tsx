/**
 * The pills a provider row carries (ADR-074 §7, mockups A and D): one per
 * engine, and a toned status pill.
 *
 * Shared by the Subscriptions cards' Engines row and the API providers list, so
 * "opencode 4 of 382" reads the same wherever a provider says which engines it
 * reaches. Each caller passes its own testid namespace (ADR-027).
 */

import { engineMeta } from '../../../../shared/engine-meta'
import type { ProviderEngineFacts } from '../../../../shared/provider-registry'
import type { EngineId } from '../../../../shared/types'

export type PillTone = 'ok' | 'warn' | 'bad' | 'plain'

/** A status pill: a dot and a word, in one of four tones. */
export function Pill({
  tone = 'plain',
  testid,
  dataId,
  children
}: {
  tone?: PillTone
  testid?: string
  dataId?: string
  children: React.ReactNode
}): React.JSX.Element {
  const look =
    tone === 'ok'
      ? 'border-success/30 bg-success/5 text-success'
      : tone === 'warn'
        ? 'border-warning/30 bg-warning/5 text-warning'
        : tone === 'bad'
          ? 'border-danger/30 bg-danger/5 text-danger'
          : 'border-border text-text-secondary'
  return (
    <span
      data-testid={testid}
      data-id={dataId}
      data-tone={tone}
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2 text-[11px] leading-[18px] whitespace-nowrap ${look}`}
    >
      {tone !== 'plain' && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** One engine pill: accent when the provider reaches it, dim "off" when not. */
export function EnginePill({
  engine,
  count,
  on,
  warn = false,
  testid
}: {
  engine: EngineId
  count?: string
  on: boolean
  warn?: boolean
  testid: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={engine}
      data-on={on}
      className={`inline-flex items-center gap-1 rounded-full border px-2 text-[11px] leading-[18px] whitespace-nowrap ${
        !on
          ? 'border-border text-text-muted opacity-60'
          : warn
            ? 'border-warning/30 bg-warning/5 text-warning'
            : 'border-accent/30 bg-accent/5 text-accent'
      }`}
    >
      {engineMeta(engine).label}
      {(count ?? (!on ? 'off' : undefined)) && (
        <span className="font-mono">{on ? count : 'off'}</span>
      )}
    </span>
  )
}

/**
 * The count an engine pill carries, from the registry's facts alone — no
 * catalog read: `4 of 382` when curated, `all 382` when not, and nothing when
 * no source could count.
 */
export function factsCount(facts: ProviderEngineFacts | undefined): string | undefined {
  if (!facts?.enabled || facts.modelCount === undefined) return undefined
  if (facts.curated) {
    return facts.catalogCount === undefined
      ? `${facts.modelCount}`
      : `${facts.modelCount} of ${facts.catalogCount}`
  }
  return `all ${facts.modelCount}`
}
