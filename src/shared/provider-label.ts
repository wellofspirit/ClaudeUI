/**
 * provider-label.ts — which PROVIDER a metered bucket belongs to, and what a
 * person calls it (ADR-071 §8).
 *
 * The dashboard's top grouping is the provider, not the vendor and not the
 * engine: one ChatGPT subscription is spent through Codex, opencode and pi
 * under three different vendor ids, and the owner asks one question of it.
 * `providerIdForBucket` is that rule and `providerLabel` names its answer.
 *
 * The rule reads the SUBSCRIPTION out of the account key first, because that is
 * what a plan's limits and its bill belong to (ADR-071 §3). Only a row with no
 * subscription in its key — an API key, an engine's own credentials, or history
 * from before attribution — falls back to the vendor it was billed through.
 *
 * shared/ — pure string mapping, renderer-safe. The dashboard query groups by
 * this and the renderer colours by it, so both must read the same function:
 * a provider that split in two between them would be two colours with one name.
 */

/** The `anthropic:<org>:<account>` key prefix, and the provider id it means. */
const ANTHROPIC_PROVIDER = 'anthropic'
/** Every id that names OpenAI: the `chatgpt:` key prefix and the vendor ids. */
const OPENAI_PROVIDER = 'openai'

/**
 * Vendor and key prefixes that are the SAME provider under different names —
 * `chatgpt` from an account key, `openai` from opencode and Codex,
 * `openai-codex` from pi. Canonicalised so a subscription and an API key under
 * one provider land in one group rather than in two identically-labelled ones.
 */
const OPENAI_ALIASES = new Set(['chatgpt', 'openai', 'openai-codex'])

/** The provider id for an account key + vendor pair — the dashboard's grouping key. */
export function providerIdForBucket(accountKey: string, vendorId: string): string {
  const prefix = accountKey.split(':')[0]
  if (prefix === ANTHROPIC_PROVIDER) return ANTHROPIC_PROVIDER
  if (OPENAI_ALIASES.has(prefix)) return OPENAI_PROVIDER
  // No subscription in the key: an API key (`<vendor>:key:<digest>`), an
  // engine's own credentials (`<engine>:<vendor>:native`), or `unknown`. What
  // it was billed through is the only provider fact left.
  return canonicalProviderId(vendorId)
}

/** The one id a provider is known by, whichever of its aliases came in. */
export function canonicalProviderId(providerId: string): string {
  return OPENAI_ALIASES.has(providerId) ? OPENAI_PROVIDER : providerId
}

/**
 * What a person calls a provider. An id with no name is shown verbatim rather
 * than prettified: a vendor id we have never heard of is a fact, and guessing
 * its capitalisation would make two spellings of the same thing.
 */
export function providerLabel(providerId: string): string {
  switch (canonicalProviderId(providerId)) {
    case ANTHROPIC_PROVIDER:
      return 'Anthropic'
    case OPENAI_PROVIDER:
      return 'OpenAI'
    default:
      return providerId
  }
}
