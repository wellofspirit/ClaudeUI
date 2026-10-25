/**
 * The text of ClaudeUI's hosted `claudeui_list_models` tool (ADR-111): the
 * models a subagent may run on, i.e. what the model may pass as the `subagent`
 * tool's `model` parameter. Pi's `list_models` is the model for it
 * (`pi-agent-model.ts` `formatPiModelList`).
 *
 * opencode's own `models` tool lists every model opencode has and is a Code
 * Mode tool, unreachable while ClaudeUI hides `execute`; its `subagent`
 * description still points at it. This one lists ClaudeUI's own discovery
 * (`discoverOpencodeModels`), which the model allowlist has already filtered,
 * so a model on this list is one the plugin's gate accepts. Pure: no discovery,
 * no I/O.
 */
import type { EngineModelGroup } from '../../shared/types'

/** Most models one result lists; the rest are summarised and a `query` narrows. */
export const OPENCODE_MODEL_LIST_CAP = 100

export const OPENCODE_MODEL_LIST_EMPTY =
  'No model list is available (opencode reported no models, or could not be asked). ' +
  'Omit the model parameter to use your own model.'

/**
 * The result text. `query` is a case-insensitive substring over the model value
 * and its display name. Models are grouped by provider (sorted by provider id,
 * then model id); each line is `provider/id`, its display name, and the
 * reasoning variants it accepts as `#variant`.
 */
export function formatOpencodeModelList(
  groups: readonly EngineModelGroup[],
  query?: string
): string {
  const all = groups.flatMap((group) => group.models.map((model) => ({ group, model })))
  if (all.length === 0) return OPENCODE_MODEL_LIST_EMPTY
  const head =
    "Models a subagent may run on, for the subagent tool's model parameter " +
    '(provider/id, or provider/id#variant where a model lists variants). ' +
    'Only pass a model when the user asks for one; omit it to use your own model.'
  const q = query?.trim().toLowerCase()
  const matches = all
    .filter(
      ({ model }) =>
        !q || model.value.toLowerCase().includes(q) || model.displayName.toLowerCase().includes(q)
    )
    .sort(
      (a, b) => compare(a.group.vendorId, b.group.vendorId) || compare(a.model.value, b.model.value)
    )
  if (matches.length === 0) {
    return `${head}\nNo model matches "${query?.trim()}". Try a broader query, or omit it to list everything.`
  }
  const lines: string[] = []
  let provider: string | undefined
  for (const { group, model } of matches.slice(0, OPENCODE_MODEL_LIST_CAP)) {
    if (group.vendorId !== provider) {
      provider = group.vendorId
      lines.push(
        group.vendorName === group.vendorId ? `${provider}:` : `${provider} (${group.vendorName}):`
      )
    }
    const variants = model.reasoningVariants?.length
      ? ` · variants: ${model.reasoningVariants.map((v) => `#${v}`).join(' ')}`
      : ''
    const name =
      model.displayName && model.displayName !== model.value ? ` — ${model.displayName}` : ''
    lines.push(`  ${model.value}${name}${variants}${model.free ? ' · free' : ''}`)
  }
  const more = matches.length - Math.min(matches.length, OPENCODE_MODEL_LIST_CAP)
  if (more > 0) lines.push(`… ${more} more — pass query to narrow.`)
  return [head, ...lines].join('\n')
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
