/**
 * A second key for a catalog provider (ADR-074 slice 10) — the pure half.
 *
 * Each engine keys a credential by provider id, so a second OpenRouter key needs
 * a second id in both engines, and neither engine has a built-in provider by
 * that id. The second entry is therefore a CUSTOM definition: the vendor's
 * OpenAI-compatible endpoint, the models it will use declared one by one with
 * their details copied from the vendor's catalog entry, and `derivedFrom`
 * naming the vendor so the sheet can refresh those copies later.
 *
 * Everything here is a pure function of what the sheet already read, so the
 * rules — the id, the name, what a declared copy carries, how many models a
 * form takes — are testable without a sheet.
 */

import {
  validateSharedProviderId,
  type SharedProviderCuration,
  type SharedProviderModel,
  type SharedProviderProtocol
} from '../../../../shared/shared-provider'
import type { CurationModel } from './ModelCurationList'
import { LARGE_CATALOG } from './ModelCuration'

/**
 * The most models a second key's form declares (the anti-flood threshold,
 * ADR-074 §3). A declared model is projected into both engines' own config, so
 * copying a 382-model catalog wholesale is the flood the picker rule exists to
 * prevent — the form asks for the models the user actually uses.
 */
export const CLONE_MODEL_CAP = LARGE_CATALOG

/**
 * What a catalog read hands the form: the list's row facts, plus what a declared
 * copy needs (opencode's catalog carries all of it; pi's only the row facts).
 */
export interface CloneCatalogModel extends CurationModel {
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
  apiUrl?: string
  apiNpm?: string
}

/** `Work` → `work`, `Team A / EU` → `team-a-eu`: the label's part of the id. */
export function cloneSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * `openrouter` + `Work` → `openrouter-work`, shown as "OpenRouter (Work)". A
 * label with nothing to slug ("工作", "!!") takes the first free numbered id
 * instead (`openrouter-2`), and says so with `numbered`. An empty label has no
 * id at all.
 */
export function cloneIdentity(
  vendorId: string,
  vendorName: string,
  label: string,
  taken: ReadonlySet<string> = new Set()
): { id: string; name: string; numbered: boolean } {
  const name = `${vendorName} (${label.trim()})`
  const slug = cloneSlug(label)
  if (slug) return { id: `${vendorId}-${slug}`, name, numbered: false }
  if (!label.trim()) return { id: '', name, numbered: false }
  let n = 2
  while (taken.has(`${vendorId}-${n}`)) n++
  return { id: `${vendorId}-${n}`, name, numbered: true }
}

/**
 * Why the id cannot be used, or null. `taken` is every provider id ClaudeUI
 * already knows — a definition's, or an engine's own row — since the new entry
 * takes that id in both engines.
 */
export function cloneIdError(id: string, taken: ReadonlySet<string>): string | null {
  if (!id) return 'Give it a name — it becomes part of the provider id.'
  try {
    validateSharedProviderId(id)
  } catch {
    return 'The id may use lowercase letters, digits and hyphens, up to 63 characters.'
  }
  return taken.has(id) ? `"${id}" is already a provider. Choose another name.` : null
}

/**
 * The wire protocol of each AI SDK package opencode's catalog names. A package
 * not listed here speaks something ClaudeUI cannot declare for both engines, so
 * the form asks.
 */
const NPM_PROTOCOL: Readonly<Record<string, SharedProviderProtocol>> = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@openrouter/ai-sdk-provider': 'openai-completions',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/openai': 'openai-responses'
}

/**
 * Where the vendor's catalog says its models are served, and in which API —
 * each only when EVERY model that says agrees, and a URL only when it is a
 * plain one (`${ACCOUNT_ID}`-style placeholders are filled in by opencode from
 * the environment, which a declared copy cannot do). Whatever is missing, the
 * form asks for.
 */
export function catalogEndpoint(catalog: readonly CloneCatalogModel[]): {
  baseUrl?: string
  protocol?: SharedProviderProtocol
} {
  const one = (values: (string | undefined)[]): string | undefined => {
    const set = new Set(values.filter((value): value is string => !!value))
    return set.size === 1 ? [...set][0] : undefined
  }
  const url = one(catalog.map((model) => model.apiUrl))
  const npm = one(catalog.map((model) => model.apiNpm))
  return {
    ...(url && !endpointUrlError(url) ? { baseUrl: url } : {}),
    ...(npm && NPM_PROTOCOL[npm] ? { protocol: NPM_PROTOCOL[npm] } : {})
  }
}

/** Why a base URL cannot be declared, or null. */
export function endpointUrlError(url: string): string | null {
  if (url.includes('${')) return 'The URL holds a placeholder; enter the full address.'
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? null
      : 'Enter an http:// or https:// address.'
  } catch {
    return 'Enter an http:// or https:// address.'
  }
}

/** Today as a calendar date, `YYYY-MM-DD`, in local time — a copy's `copiedAt`. */
export function today(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-09-23` → `23 Sep 2026`, read off the string (never through `Date`'s UTC). */
export function formatCopiedAt(date: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  const month = match && MONTHS[Number(match[2]) - 1]
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : undefined
}

/**
 * The models the ORIGINAL entry currently picks, in the ids both engines share
 * (a catalog provider's are the same in each): the linked list when there is
 * one, else every curating engine's picks combined. `undefined` is All models —
 * also when any engine is on All.
 */
export function originPicks(
  curation: SharedProviderCuration | undefined,
  lists: Readonly<Partial<Record<'opencode' | 'pi', readonly string[] | undefined>>>,
  engines: readonly ('opencode' | 'pi')[]
): string[] | undefined {
  if (curation?.linked) return curation.models ? [...curation.models] : undefined
  const picked = new Set<string>()
  for (const engine of engines) {
    const list = lists[engine]
    if (list === undefined) return undefined
    for (const id of list) picked.add(id)
  }
  return engines.length === 0 ? undefined : [...picked]
}

/**
 * What the form starts with: the original's picks that the catalog still lists,
 * or — on All models — the whole catalog when it is small enough to declare.
 * Never more than {@link CLONE_MODEL_CAP}.
 */
export function seedClonePicks(
  picks: readonly string[] | undefined,
  catalog: readonly CloneCatalogModel[]
): string[] {
  if (picks === undefined)
    return catalog.length <= CLONE_MODEL_CAP ? catalog.map((model) => model.id) : []
  const listed = new Set(catalog.map((model) => model.id))
  return picks.filter((id) => listed.has(id)).slice(0, CLONE_MODEL_CAP)
}

/**
 * A form's selection may grow up to {@link CLONE_MODEL_CAP}, and may always
 * shrink — a refresh of an entry declared past the cap by hand is not refused.
 */
export function withinCap(next: readonly string[], current: readonly string[]): boolean {
  return next.length <= CLONE_MODEL_CAP || next.length <= current.length
}

/**
 * The declared models for `ids`, in that order. A model the catalog lists gets
 * the details the catalog STATES copied over its declaration (name, context
 * window, max tokens, reasoning, vision) — which is what a refresh re-does. A
 * fact the catalog does not state (a pi-only read has no limits; a zero limit is
 * opencode's "unknown") leaves the declared one as it is, and so do the
 * per-engine overrides. One the catalog no longer lists is kept untouched.
 */
export function declareModels(
  ids: readonly string[],
  catalog: readonly CloneCatalogModel[],
  existing: readonly SharedProviderModel[] = []
): SharedProviderModel[] {
  const byId = new Map(catalog.map((model) => [model.id, model]))
  const declared = new Map(existing.map((model) => [model.id, model]))
  return ids.map((id) => {
    const source = byId.get(id)
    const next: SharedProviderModel = { ...(declared.get(id) ?? { id }) }
    if (!source) return next
    if (source.name && source.name !== id) next.name = source.name
    for (const flag of ['reasoning', 'vision'] as const) {
      if (source[flag] === true) next[flag] = true
      else if (source[flag] === false) delete next[flag]
    }
    if (positive(source.contextWindow)) next.contextWindow = source.contextWindow
    if (positive(source.maxTokens)) next.maxTokens = source.maxTokens
    return next
  })
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
