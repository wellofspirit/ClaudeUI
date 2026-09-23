/**
 * pi's ClaudeUI-private model allowlist (`engines/pi.json` →
 * `piConfig.modelAllowlist`), per provider (ADR-074 §1).
 *
 * The rule is opencode's, by KEY PRESENCE: no key → every model that provider
 * reports; `[]` → none; a list → only those bare model ids. Shared so the
 * config reader, model discovery, the provider registry and the pi engine page
 * cannot disagree on what a value means.
 */

import type { EngineConfig } from './types'

/** Provider id → bare model ids (no `<provider>/` prefix). */
export type PiModelAllowlist = Record<string, string[]>

/**
 * Split a pi picker value (`<provider>/<modelId>`) on its FIRST `/`: model ids
 * may contain `/` themselves (`openrouter/deepseek/deepseek-v4-flash-0731` →
 * provider `openrouter`, id `deepseek/deepseek-v4-flash-0731`). Null when the
 * value has no provider prefix.
 */
export function splitPiModelValue(value: string): { provider: string; modelId: string } | null {
  const separator = value.indexOf('/')
  if (separator < 1) return null
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) }
}

/** Whether the allowlist lets one of `provider`'s models into the picker. */
export function isPiModelAllowed(
  allowlist: Readonly<Record<string, readonly string[]>> | undefined,
  provider: string,
  modelId: string
): boolean {
  const listed = allowlist?.[provider]
  return listed === undefined || listed.includes(modelId)
}

/**
 * Read whatever `modelAllowlist` holds on disk as the per-provider record.
 *
 * - absent (or not a list/record) → `undefined`: every provider shows all.
 * - a record → itself, minus non-array values and non-string entries.
 * - the LEGACY `string[]` of `<provider>/<modelId>` values → grouped by
 *   provider on the first `/`; entries with no prefix are dropped. A provider
 *   the old list never named gets NO key, i.e. shows all (owner ruling): the old
 *   global list hid every provider added after it was written, which is the
 *   defect this shape exists to fix. So an old EMPTY list (`[]`, which meant
 *   "nothing anywhere") deliberately becomes `{}` — "everything everywhere".
 *
 * Pure; the file is never rewritten on read — the next save persists the shape.
 */
export function normalizePiModelAllowlist(raw: unknown): PiModelAllowlist | undefined {
  if (Array.isArray(raw)) {
    const grouped: PiModelAllowlist = {}
    for (const value of raw) {
      if (typeof value !== 'string') continue
      const split = splitPiModelValue(value)
      if (!split || !split.modelId) continue
      grouped[split.provider] = [...(grouped[split.provider] ?? []), split.modelId]
    }
    return grouped
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record: PiModelAllowlist = {}
  for (const [provider, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue
    record[provider] = ids.filter((id): id is string => typeof id === 'string')
  }
  return record
}

/**
 * `engines/pi.json` as read → the current shape, in place: the one read-time
 * migration `loadEngineConfig('pi')` applies. A `modelAllowlist` that
 * normalises to nothing is removed rather than kept as junk.
 */
export function normalizePiEngineConfig(config: EngineConfig): EngineConfig {
  const piConfig = config.piConfig
  if (typeof piConfig !== 'object' || piConfig === null || !('modelAllowlist' in piConfig)) {
    return config
  }
  const modelAllowlist = normalizePiModelAllowlist(piConfig.modelAllowlist)
  if (modelAllowlist === undefined) delete piConfig.modelAllowlist
  else piConfig.modelAllowlist = modelAllowlist
  return config
}
