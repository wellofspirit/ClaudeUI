/**
 * Which model a pi subagent runs on, and how the model is told what exists
 * (ADR-089 messaging v2, S3). Pure: the catalog comes in as a parameter, so
 * nothing here discovers, spawns or reads config.
 *
 * `resolvePiAgentModel` turns what the model WROTE into a picker value
 * (`provider/id`): an exact value, a bare id, or a Claude Code alias (`opus`,
 * `sonnet`, `haiku`, `fable`) resolved to the newest matching model, so the
 * model need not guess ids. An explicit reference that does not resolve is an
 * error, never a substitution (owner ruling 2026-08-21). `formatPiModelList`
 * is the text of the `list_models` tool.
 */
import type { PiModel } from './pi-protocol'
import { splitPiModelValue } from '../../shared/pi-model-allowlist'

/** What the resolver and the listing need from a catalog row (a `PiModel` satisfies it). */
export type PiAgentModelEntry = Pick<
  PiModel,
  'provider' | 'id' | 'name' | 'contextWindow' | 'reasoning' | 'input' | 'cost'
>

export type PiAgentModelResolution = { ok: true; value: string } | { ok: false; error: string }

/** Claude Code's model aliases. */
export const PI_MODEL_ALIASES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable']

/** At most this many candidates are named in an ambiguity error. */
const MAX_CANDIDATES_LISTED = 10
/** `list_models` prints at most this many model lines. */
export const PI_MODEL_LIST_CAP = 100

const valueOf = (m: PiAgentModelEntry): string => `${m.provider}/${m.id}`

const UNKNOWN = (requested: string): PiAgentModelResolution => ({
  ok: false,
  error: `Unknown model "${requested}". Call list_models to see the models available to agents.`
})

/** An 8-digit date group such as `20251101`. */
const DATE_GROUP = /^\d{8}$/

/**
 * The version of an id: its PURELY numeric tokens (the id split on `-` `.` `/`
 * `:` `@` `_`), 8-digit dates excluded. `claude-opus-4-5-20251101` → [4, 5];
 * a variant suffix (`-1m`, `-v2`, `:thinking`) is not a token of its own, so
 * `claude-sonnet-4-5-1m` is [4, 5] — equal to the plain model, which the
 * undated / shortest-id tiebreaks then prefer.
 */
function versionOf(id: string): number[] {
  return id
    .split(/[-./:@_]/)
    .filter((t) => /^\d+$/.test(t) && !DATE_GROUP.test(t))
    .map(Number)
}

/** Element-wise, a missing element counting as 0. Positive when `a` is the newer. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const isDated = (id: string): boolean => (id.match(/\d+/g) ?? []).some((g) => DATE_GROUP.test(g))

/** The alias family as a hyphen / dot / slash delimited token of the id. */
function hasFamilyToken(id: string, family: string): boolean {
  return new RegExp(`(?:^|[-./])${family}(?:$|[-./])`, 'i').test(id)
}

/** Prefer the parent's provider when any candidate has it. */
function preferParentProvider(
  candidates: PiAgentModelEntry[],
  parentProvider: string | undefined
): PiAgentModelEntry[] {
  if (!parentProvider) return candidates
  const same = candidates.filter((m) => m.provider === parentProvider)
  return same.length > 0 ? same : candidates
}

const byValue = (a: PiAgentModelEntry, b: PiAgentModelEntry): number =>
  valueOf(a) < valueOf(b) ? -1 : valueOf(a) > valueOf(b) ? 1 : 0

/**
 * The model an `agent` call runs on. `requested` is the model's own text
 * (trimmed here); `parentModel` is the session's picker value (provider
 * preference only). Ladder:
 *
 *  1. an empty catalog (no auth, discovery failed) cannot validate → `requested` unchanged;
 *  2. an exact `provider/id` value, then a case-insensitive one;
 *  3. a bare id (case-insensitive, tried for any input that failed rule 2 —
 *     ids may contain `/`): one match wins; several prefer the parent's
 *     provider; still several → an error listing up to 10 candidates;
 *  4. an alias → the newest matching model, preferring the parent's provider;
 *  5. otherwise an unknown-model error.
 */
export function resolvePiAgentModel(
  requested: string,
  catalog: readonly PiAgentModelEntry[],
  parentModel: string
): PiAgentModelResolution {
  if (catalog.length === 0) return { ok: true, value: requested }
  const wanted = requested.trim()
  const lower = wanted.toLowerCase()
  const parentProvider = splitPiModelValue(parentModel)?.provider

  // 2. exact value, then case-insensitive
  const exact = catalog.find((m) => valueOf(m) === wanted)
  if (exact) return { ok: true, value: valueOf(exact) }
  const ci = catalog.filter((m) => valueOf(m).toLowerCase() === lower)
  if (ci.length === 1) return { ok: true, value: valueOf(ci[0]) }

  // 3. bare id
  const bare = catalog.filter((m) => m.id.toLowerCase() === lower)
  if (bare.length > 0) {
    const preferred = preferParentProvider([...bare], parentProvider)
    if (preferred.length === 1) return { ok: true, value: valueOf(preferred[0]) }
    const listed = preferred.sort(byValue).slice(0, MAX_CANDIDATES_LISTED).map(valueOf)
    const more = preferred.length - listed.length
    return {
      ok: false,
      error:
        `Model "${wanted}" is ambiguous: it matches ${listed.join(', ')}` +
        `${more > 0 ? ` and ${more} more` : ''}. Use the provider/id form.`
    }
  }

  // 4. alias
  if (PI_MODEL_ALIASES.includes(lower)) {
    const family = catalog.filter((m) => hasFamilyToken(m.id, lower))
    if (family.length === 0) {
      return {
        ok: false,
        error: `No model matches the alias "${wanted}". Call list_models to see the models available to agents.`
      }
    }
    const best = preferParentProvider([...family], parentProvider).sort(
      (a, b) =>
        // newest version first, then undated, then the shortest id, then the
        // later id (a newer date suffix) — deterministic
        compareVersions(versionOf(b.id), versionOf(a.id)) ||
        Number(isDated(a.id)) - Number(isDated(b.id)) ||
        a.id.length - b.id.length ||
        byValue(b, a)
    )[0]
    return { ok: true, value: valueOf(best) }
  }

  // 5.
  return UNKNOWN(wanted)
}

/** A price per million tokens: trailing zeros dropped (`3`, `0.25`, `15`). */
const price = (n: number): string => String(Number(n.toFixed(4)))

/** One catalog row as a `list_models` line. */
function modelLine(m: PiAgentModelEntry): string {
  const cost =
    m.cost.input === 0 && m.cost.output === 0
      ? ''
      : ` · $${price(m.cost.input)}/$${price(m.cost.output)} per M tokens`
  return (
    `${valueOf(m)} — ${m.name || m.id} · ${Math.round(m.contextWindow / 1000)}k ctx${cost}` +
    `${m.reasoning ? ' · reasoning' : ''}${m.input.includes('image') ? ' · vision' : ''}`
  )
}

/**
 * The `list_models` result text. `query` is a case-insensitive substring over
 * the value and the display name. First line names the session's model; then
 * one line per model sorted by provider, then id, capped at
 * {@link PI_MODEL_LIST_CAP}.
 */
export function formatPiModelList(opts: {
  catalog: readonly PiAgentModelEntry[]
  query?: string
  currentModel: string
}): string {
  const head = `Current session model: ${opts.currentModel}`
  if (opts.catalog.length === 0) {
    return `${head}\nNo models could be listed (no provider is signed in, or the model list is unavailable); the agent tool's model is then passed to pi unchecked.`
  }
  const q = opts.query?.trim().toLowerCase()
  const matches = opts.catalog
    .filter((m) => !q || valueOf(m).toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
  if (matches.length === 0) {
    return `${head}\nNo model matches "${opts.query?.trim()}". Try a broader query, or omit it to list everything.`
  }
  const lines = matches.slice(0, PI_MODEL_LIST_CAP).map(modelLine)
  const more = matches.length - lines.length
  if (more > 0) lines.push(`… ${more} more — pass query to narrow.`)
  return [head, ...lines].join('\n')
}
