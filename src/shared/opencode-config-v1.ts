/**
 * opencode 1.x config entries → their opencode 2.x form (ADR-097 S8).
 *
 * opencode 2.x still READS a 1.x-shaped config: it normalizes it in memory
 * (`vendor/opencode-v2-src/packages/core/src/config/normalize.ts`) and keeps
 * the user's file as it is. ClaudeUI's writers emit 2.x keys only, and that
 * forces one rule on them: a map entry (`provider.<id>`, `agent.<name>`) must
 * live under ONE key. When the same id is under both the 1.x key and the 2.x
 * key, 2.x keeps the 2.x entry WHOLE (the 1.x one is dropped field by field
 * and a `conflict` diagnostic is logged). So before ClaudeUI edits an entry
 * that only exists in its 1.x form, it moves the whole entry to the 2.x key in
 * the form 2.x would have read it in — which is what this module computes.
 *
 * A port of upstream's own migration (`packages/core/src/v1/config/migrate.ts`
 * `ConfigMigrateV1`, `provider-options.ts`, `agent.ts` normalize) at v2.0.24,
 * EXACT: what it produces is what 2.x already runs on, so moving an entry
 * changes nothing at runtime (S8 review F4). In particular the 1.x model keys
 * 2.x drops ("omitted unsupported legacy setting": `attachment`, `reasoning`,
 * `temperature`, `release_date`, `experimental`) are dropped here too — they are
 * inert in 2.x today, and turning them into `capabilities.input` /
 * `variants: []` would override the models.dev base (pdf/audio input, the
 * generated effort variants). The writer writes those 2.x keys only for a
 * field the user edits in that save.
 *
 * Pure (no fs): the renderer uses it to show a 1.x entry in its 2.x form, the
 * main-process writers to migrate it.
 */

import { wildcardMatch } from './opencode-wildcard'

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Top-level 1.x keys 2.x drops with an "unsupported" diagnostic. */
export const V1_UNSUPPORTED_TOP_LEVEL = ['logLevel', 'server', 'subagent_depth', 'layout'] as const
/** 1.x keys 2.x still reads (migrating in memory) but never writes. */
export const V1_LEGACY_TOP_LEVEL = [
  'provider',
  'agent',
  'mode',
  'small_model',
  'disabled_providers',
  'enabled_providers',
  'permission',
  'tools',
  'plugin',
  'command',
  'reference',
  'autoupdate',
  'autoshare',
  'snapshot',
  'attachment'
] as const
/** 1.x model keys 2.x drops. */
export const V1_UNSUPPORTED_MODEL = [
  'release_date',
  'attachment',
  'reasoning',
  'temperature',
  'experimental'
] as const

/** The 2.x default input modalities (`Model.Capabilities.default()`). */
export const V2_DEFAULT_INPUT = ['text', 'image'] as const

// ── Small upstream helpers ───────────────────────────────────────────────────

/** `normalizeAction`: 1.x permission/tool keys → their renamed 2.x actions. */
export function normalizeActionV1(action: string): string {
  if (action === 'write' || action === 'patch') return 'edit'
  if (action === 'task') return 'subagent'
  if (action === 'bash') return 'shell'
  return action
}

/** `providerID`: retired 1.x provider ids 2.x renames. */
export function providerIdV1(input: string): string {
  if (input === 'azure-cognitive-services') return 'azure'
  if (input === 'google-vertex-anthropic') return 'google-vertex'
  return input
}

export interface ModelSelection {
  providerID: string
  model: string
  variant?: string
}

/** `modelSelection`: a 1.x `provider/model` (+ variant) → the 2.x selection, or undefined. */
export function modelSelectionV1(input: unknown, variant?: unknown): ModelSelection | undefined {
  if (typeof input !== 'string' || !/^[^/#]+\/[^#]+$/.test(input)) return undefined
  const separator = input.indexOf('/')
  return {
    providerID: providerIdV1(input.slice(0, separator)),
    model: input.slice(separator + 1),
    ...(typeof variant === 'string' && variant.length > 0 && !variant.includes('#')
      ? { variant }
      : {})
  }
}

/** A 2.x model selection (`p/m`, `p/m#v`, or the explicit object) as ClaudeUI's `p/m[#v]` string. */
export function selectionToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (!isRecord(value)) return undefined
  if (typeof value.providerID !== 'string' || typeof value.model !== 'string') return undefined
  const variant = typeof value.variant === 'string' && value.variant ? `#${value.variant}` : ''
  return `${value.providerID}/${value.model}${variant}`
}

/** `Model.compatibility`: 1.x `interleaved` → 2.x `compatibility`. */
function compatibilityV1(input: unknown): JsonRecord | undefined {
  if (typeof input === 'string') return { reasoningField: input }
  if (!isRecord(input) || typeof input.field !== 'string') return undefined
  return { reasoningField: input.field }
}

/** `Provider.aisdk`: an npm package name → the 2.x `package` specifier. */
export function aisdkPackage(npm: string): string {
  return npm.startsWith('aisdk:') ? npm : `aisdk:${npm}`
}

/** The inverse ClaudeUI reads back: `aisdk:<npm>` → `<npm>`; anything else verbatim. */
export function packageToNpm(pkg: string): string {
  return pkg.startsWith('aisdk:') ? pkg.slice('aisdk:'.length) : pkg
}

/** Drop `undefined` values (recursively), as upstream's `plain` does. */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, plain(item)]]))
  )
}

function int(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? [...(value as string[])]
    : undefined
}

// ── Provider options (provider-options.ts) ───────────────────────────────────

function providerOptions(options: JsonRecord): {
  settings: JsonRecord
  headers?: Record<string, string>
  body?: JsonRecord
} {
  const settings = Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== 'headers' && key !== 'body')
  )
  const headers = isRecord(options.headers)
    ? (Object.fromEntries(
        Object.entries(options.headers).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>)
    : undefined
  const body = isRecord(options.body) ? { ...options.body } : undefined
  return { settings, headers, body }
}

// ── Model ────────────────────────────────────────────────────────────────────

function costV1(cost: unknown): unknown[] | undefined {
  if (!isRecord(cost)) return undefined
  const tier = (c: JsonRecord): JsonRecord => ({
    input: c.input,
    output: c.output,
    cache: plain({ read: c.cache_read, write: c.cache_write })
  })
  const rows: JsonRecord[] = [tier(cost)]
  if (isRecord(cost.context_over_200k))
    rows.push({ tier: { type: 'context', size: 200_000 }, ...tier(cost.context_over_200k) })
  return rows.map((row) => {
    const cache = row.cache as JsonRecord
    return plain(Object.keys(cache).length ? row : { ...row, cache: undefined }) as JsonRecord
  })
}

/** One 1.x model entry → its 2.x entry (`migrateModel`, exact — module doc). */
export function migrateModelV1(info: JsonRecord): JsonRecord {
  const options = isRecord(info.options) ? { ...info.options } : undefined
  const modalities = isRecord(info.modalities) ? info.modalities : undefined
  const toolCall = bool(info.tool_call)
  const inputModalities = stringArray(modalities?.input)
  const outputModalities = stringArray(modalities?.output)
  const capabilities: JsonRecord | undefined =
    toolCall !== undefined || inputModalities !== undefined || outputModalities !== undefined
      ? {
          tools: toolCall ?? true,
          input: inputModalities ?? [...V2_DEFAULT_INPUT],
          output: outputModalities ?? ['text']
        }
      : undefined
  const provider = isRecord(info.provider) ? info.provider : undefined
  const settings =
    typeof provider?.api === 'string' ? { ...(options ?? {}), baseURL: provider.api } : options
  const limit = isRecord(info.limit)
    ? plain({
        context: int(info.limit.context),
        input: int(info.limit.input),
        output: int(info.limit.output)
      })
    : undefined
  const variants = isRecord(info.variants)
    ? Object.entries(info.variants).map(([id, overlay]) => ({
        id,
        settings: isRecord(overlay) ? { ...overlay } : {}
      }))
    : undefined
  return plain({
    modelID: str(info.id),
    family: str(info.family),
    name: str(info.name),
    compatibility: compatibilityV1(info.interleaved),
    package: typeof provider?.npm === 'string' ? aisdkPackage(provider.npm) : undefined,
    settings,
    capabilities,
    headers: isRecord(info.headers) ? { ...info.headers } : undefined,
    variants,
    cost: costV1(info.cost),
    disabled: info.status === 'deprecated' ? true : undefined,
    limit
  }) as JsonRecord
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * One 1.x provider entry → its 2.x entry (`migrateStandardProvider`). Throws for
 * the two retired ids 2.x RENAMES (`azure-cognitive-services`,
 * `google-vertex-anthropic`): moving those changes the id the user knows, so
 * ClaudeUI leaves them to the user.
 */
export function migrateProviderV1(id: string, info: JsonRecord): JsonRecord {
  if (providerIdV1(id) !== id)
    throw new Error(
      `opencode provider "${id}" is a retired 1.x id (2.x reads it as "${providerIdV1(id)}"); edit it in opencode's config file`
    )
  const options = isRecord(info.options) ? providerOptions(info.options) : undefined
  const settings =
    typeof info.api === 'string'
      ? { ...(options?.settings ?? {}), baseURL: info.api }
      : options?.settings
  return plain({
    name: str(info.name),
    env: stringArray(info.env),
    package: typeof info.npm === 'string' ? aisdkPackage(info.npm) : undefined,
    settings,
    headers: options?.headers,
    body: options?.body,
    models: isRecord(info.models)
      ? Object.fromEntries(
          Object.entries(info.models).map(([name, model]) => [
            name,
            migrateModelV1(isRecord(model) ? model : {})
          ])
        )
      : undefined
  }) as JsonRecord
}

// ── Permissions ──────────────────────────────────────────────────────────────

export interface PermissionRule {
  action: string
  resource: string
  effect: 'allow' | 'ask' | 'deny'
}

const isEffect = (v: unknown): v is PermissionRule['effect'] =>
  v === 'allow' || v === 'ask' || v === 'deny'

/** A 1.x `permission` value (bare action or key → action | {pattern → action}) as 2.x rules. */
export function permissionRulesV1(value: unknown): PermissionRule[] {
  if (isEffect(value)) return [{ action: '*', resource: '*', effect: value }]
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, rule]): PermissionRule[] => {
    const action = normalizeActionV1(key)
    if (isEffect(rule)) return [{ action, resource: '*', effect: rule }]
    if (!isRecord(rule)) return []
    return Object.entries(rule).flatMap(([resource, effect]) =>
      isEffect(effect) ? [{ action, resource, effect }] : []
    )
  })
}

/** The 1.x `tools` map as 2.x rules (`migrateTools`): `false` → deny, `true` → allow. */
export function toolRulesV1(value: unknown): PermissionRule[] {
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([action, enabled]): PermissionRule[] =>
    typeof enabled === 'boolean'
      ? [{ action: normalizeActionV1(action), resource: '*', effect: enabled ? 'allow' : 'deny' }]
      : []
  )
}

/** A 2.x `permissions` value: the well-formed rules only. */
export function permissionRulesV2(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((rule): PermissionRule[] =>
    isRecord(rule) &&
    typeof rule.action === 'string' &&
    typeof rule.resource === 'string' &&
    isEffect(rule.effect)
      ? [{ action: rule.action, resource: rule.resource, effect: rule.effect }]
      : []
  )
}

// ── Agent ────────────────────────────────────────────────────────────────────

/** The fields a 1.x agent entry knows (`ConfigAgentV1` `KNOWN_KEYS`); anything else is an option. */
const V1_AGENT_KEYS = new Set([
  'name',
  'model',
  'variant',
  'temperature',
  'top_p',
  'prompt',
  'tools',
  'disable',
  'description',
  'mode',
  'hidden',
  'options',
  'color',
  'steps',
  'maxSteps',
  'permission'
])

/**
 * The keys a 2.x agent entry has (`ConfigAgent.Info`), plus `variant` which a
 * markdown agent may carry beside its model. A markdown file whose front matter
 * has ANY other key is decoded as a 1.x agent (`config/plugin/agent.ts`
 * `decode`), so a 2.x file must never carry one.
 */
export const V2_AGENT_KEYS: ReadonlySet<string> = new Set([
  'variant',
  'model',
  'request',
  'system',
  'description',
  'mode',
  'hidden',
  'color',
  'steps',
  'disabled',
  'permissions'
])

/** True when a markdown agent's front matter is read by 2.x as a 1.x agent. */
export function isLegacyAgentFrontmatter(data: JsonRecord): boolean {
  return Object.keys(data).some((key) => !V2_AGENT_KEYS.has(key))
}

const COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * One 1.x agent entry → its 2.x entry (`ConfigAgentV1` normalize +
 * `migrateAgent`): unknown keys and `options` go to `request.body` with
 * `temperature`/`top_p`; `tools` + `permission` become rules (tools first,
 * then the explicit permission over them, key-wise); `prompt` → `system`;
 * `disable` → `disabled`; `maxSteps` → `steps`; a non-hex colour → `#aaaaaa`.
 */
export function migrateAgentV1(info: JsonRecord): JsonRecord {
  const options: JsonRecord = isRecord(info.options) ? { ...info.options } : {}
  for (const [key, value] of Object.entries(info)) if (!V1_AGENT_KEYS.has(key)) options[key] = value
  // tools-derived keys first, the explicit permission over them (Object.assign).
  const permission: JsonRecord = {}
  if (isRecord(info.tools))
    for (const [tool, enabled] of Object.entries(info.tools)) {
      if (typeof enabled !== 'boolean') continue
      const action = enabled ? 'allow' : 'deny'
      permission[tool === 'write' || tool === 'edit' || tool === 'patch' ? 'edit' : tool] = action
    }
  const explicit = isEffect(info.permission) ? { '*': info.permission } : info.permission
  if (isRecord(explicit)) Object.assign(permission, explicit)
  const body: JsonRecord = {
    ...options,
    ...(typeof info.temperature === 'number' ? { temperature: info.temperature } : {}),
    ...(typeof info.top_p === 'number' ? { top_p: info.top_p } : {})
  }
  const steps =
    typeof info.steps === 'number'
      ? info.steps
      : typeof info.maxSteps === 'number'
        ? info.maxSteps
        : undefined
  const rules = permissionRulesV1(permission)
  const color = str(info.color)
  return plain({
    model: modelSelectionV1(info.model, info.variant),
    request: Object.keys(body).length ? { body } : undefined,
    system: str(info.prompt),
    description: str(info.description),
    mode:
      info.mode === 'primary' || info.mode === 'subagent' || info.mode === 'all'
        ? info.mode
        : undefined,
    hidden: bool(info.hidden),
    color: color === undefined ? undefined : COLOR.test(color) ? color : '#aaaaaa',
    steps,
    disabled: bool(info.disable),
    permissions: rules.length ? rules : undefined
  }) as JsonRecord
}

// ── Native views of a whole config ───────────────────────────────────────────

/**
 * The 2.x form of provider `id` in a config object: `providers.<id>` when it is
 * there (2.x keeps it whole), else the migrated `provider.<id>`, else undefined.
 */
export function nativeProviderEntry(config: JsonRecord, id: string): JsonRecord | undefined {
  const native = isRecord(config.providers) ? config.providers[id] : undefined
  if (isRecord(native)) return native
  const legacy = isRecord(config.provider) ? config.provider[id] : undefined
  if (!isRecord(legacy)) return undefined
  try {
    return migrateProviderV1(id, legacy)
  } catch {
    return undefined
  }
}

/** Whether provider `id` lives ONLY under the 1.x `provider` key. */
export function providerIsLegacyOnly(config: JsonRecord, id: string): boolean {
  return (
    !(isRecord(config.providers) && isRecord(config.providers[id])) &&
    isRecord(config.provider) &&
    isRecord(config.provider[id])
  )
}

// ── Built-in tool switches (top-level rules) ─────────────────────────────────

/**
 * The 2.x built-in tool actions the Tools pane can switch off. A switched-off
 * tool is a top-level `{action, resource:"*", effect:"deny"}` rule. 2.x
 * appends top-level rules to every agent BEFORE a config-defined agent's own
 * rules (`config/plugin/agent.ts`), so such an agent's own allow overrides it
 * (`agentsOverridingSwitch`).
 */
export const OPENCODE_SWITCHABLE_TOOLS = [
  'shell',
  'read',
  'glob',
  'grep',
  'edit',
  'webfetch',
  'websearch',
  'subagent',
  'skill',
  'question'
] as const

/** The document's top-level rules in 2.x order: 1.x `tools`, 1.x `permission`, `permissions`. */
export function topLevelRules(config: JsonRecord): PermissionRule[] {
  return [
    ...toolRulesV1(config.tools),
    ...permissionRulesV1(config.permission),
    ...permissionRulesV2(config.permissions)
  ]
}

/**
 * Upstream's `whollyDisabled` (`core/src/tool.ts`): the LAST rule whose action
 * matches decides, and the tool is hidden only when that rule is a `"*"` deny.
 * A later narrower rule (`shell "git *" allow`) keeps the tool offered.
 */
export function whollyDisabled(
  action: string,
  rules: readonly PermissionRule[],
  platform: string
): boolean {
  for (let i = rules.length - 1; i >= 0; i--)
    if (wildcardMatch(action, rules[i].action, platform))
      return rules[i].resource === '*' && rules[i].effect === 'deny'
  return false
}

/** Whether the document's top-level rules alone hide `action` (`whollyDisabled`). */
export function toolDisabledIn(config: JsonRecord, action: string, platform: string): boolean {
  return whollyDisabled(action, topLevelRules(config), platform)
}

/**
 * Of the agents whose OWN rules are given, the ones that still offer `action`
 * with a top-level `{action,*,deny}` in force: their rules come after it.
 */
export function agentsOverridingSwitch(
  action: string,
  agents: readonly { name: string; rules: readonly PermissionRule[] }[],
  platform: string
): string[] {
  const deny: PermissionRule = { action, resource: '*', effect: 'deny' }
  return agents
    .filter((agent) => !whollyDisabled(action, [deny, ...agent.rules], platform))
    .map((agent) => agent.name)
}

/** The own rules of the agents a config document defines (`agents`, 1.x `agent`/`mode`). */
export function configAgentRules(config: JsonRecord): { name: string; rules: PermissionRule[] }[] {
  const out = new Map<string, PermissionRule[]>()
  for (const key of ['agent', 'mode'])
    if (isRecord(config[key]))
      for (const [name, entry] of Object.entries(config[key] as JsonRecord))
        if (isRecord(entry)) out.set(name, permissionRulesV2(migrateAgentV1(entry).permissions))
  if (isRecord(config.agents))
    for (const [name, entry] of Object.entries(config.agents))
      if (isRecord(entry)) out.set(name, permissionRulesV2(entry.permissions))
  return [...out].filter(([, rules]) => rules.length).map(([name, rules]) => ({ name, rules }))
}
