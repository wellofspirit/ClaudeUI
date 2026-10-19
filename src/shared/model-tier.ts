/**
 * Model tiers: which of four tiers a model id belongs to, by its family name.
 *
 * A tier is a coarse "how capable is this family" label, used to colour an
 * agent's name and the task card's model chip (the switch is in Settings, Agents
 * group). Only a curated list of families has one; every other model (an
 * open-weight, free, custom or unlisted one) has none and renders plain. There
 * is no price fallback and no per-model override.
 *
 *   top   fable, mythos, astra
 *   high  opus, sol
 *   mid   sonnet
 *   low   haiku, luna
 *
 * The match is on whole tokens, never substrings, so `solar-pro`, `lunaris`,
 * `console` and `opusplan` have no tier. The id is lowercased and split on
 * everything that is not a letter (digits, `-`, `_`, `.`, `/`, `:`, `@`, `#`, `[`
 * included), so `claude-opus-5-5`, `gpt-6.1-sol`, `requesty/gpt-6-sol@eu` and
 * `sonnet[1m]` each find their family. An id of the form `provider/model` is
 * judged by the model part: a provider's own name is not a family.
 */
export const MODEL_TIERS = ['top', 'high', 'mid', 'low'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

const FAMILY_TIER: Readonly<Record<string, ModelTier>> = {
  fable: 'top',
  mythos: 'top',
  astra: 'top',
  opus: 'high',
  sol: 'high',
  sonnet: 'mid',
  haiku: 'low',
  luna: 'low'
}

/** The tier of `model`, or undefined for an unlisted family, an empty id or no id. */
export function modelTier(model: string | undefined): ModelTier | undefined {
  if (!model) return undefined
  const slash = model.indexOf('/')
  const name = slash >= 0 ? model.slice(slash + 1) : model
  for (const token of name.toLowerCase().split(/[^a-z]+/)) {
    if (Object.hasOwn(FAMILY_TIER, token)) return FAMILY_TIER[token]
  }
  return undefined
}
