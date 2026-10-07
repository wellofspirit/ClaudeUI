/**
 * opencode-config.ts
 *
 * Owns reading and writing opencode's OWN global config file in place,
 * comment-safe (jsonc-parser leaf edits). Mirrors the role that
 * claude-settings.ts plays for Claude's ~/.claude/settings.json.
 *
 * opencode 2.x (ADR-093 S8). The file may be in either shape: 2.x reads a
 * 1.x-shaped file by normalizing it in memory
 * (`vendor/opencode-v2-src/packages/core/src/config/normalize.ts`). So the
 * READER accepts both and projects what 2.x would use, and the WRITER emits
 * 2.x keys only:
 *
 *   ClaudeUI field      2.x key (written)                       1.x key (read, migrated on edit)
 *   model               model ("p/m" string)                    model
 *   smallModel          agents.title.model                      small_model, agent.title.model
 *   disabledProviders   experimental.policies provider.use deny disabled_providers
 *   enabledProviders    experimental.policies `*` deny + allows enabled_providers
 *   providers.<id>      providers.<id> (package, settings.baseURL,
 *                       models.<m>.capabilities/variants/limit) provider.<id> (npm, options.baseURL, …)
 *   agents.<n>          agents.<n>.model / .request.body.temperature  agent.<n>.model / .temperature
 *
 * Write policy for a 1.x-shaped file: ClaudeUI moves an entry ONLY when it
 * edits it, and then moves it WHOLE (`shared/opencode-config-v1.ts`, upstream's
 * own migration): 2.x keeps a 2.x entry whole over a 1.x entry of the same id
 * and logs a conflict, so a 2.x entry written beside the 1.x one would drop the
 * user's 1.x fields. Untouched 1.x keys stay as they are (2.x still reads them);
 * a 1.x container a move empties stays as `{}` (deleting it would take the
 * comments written above it; 2.x reads an empty map silently). The file therefore never
 * gains a key 2.x warns about.
 *
 * Keys that stay ClaudeUI-private and are NEVER written here:
 *   modelAllowlist (picker filter, opencode doesn't understand it)
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as jsoncParse } from 'jsonc-parser'
import { loadEngineConfig, saveEngineConfig } from '../services/ui-config'
import { JsoncDoc, safeRead, writeIfChanged } from './opencode-jsonc-io'
import {
  V2_DEFAULT_INPUT,
  aisdkPackage,
  isRecord,
  migrateAgentV1,
  migrateProviderV1,
  modelSelectionV1,
  packageToNpm,
  selectionToString,
  type JsonRecord
} from '../../shared/opencode-config-v1'
import { wildcardMatch } from '../../shared/opencode-wildcard'
import { OPENCODE_SWITCHABLE_TOOLS, toolDisabledIn } from '../../shared/opencode-config-v1'
import type {
  OpencodeConfigSettings,
  OpencodeProviderModelSettings,
  OpencodeProviderSettings
} from '../../shared/types'

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the opencode config directory, honouring the same env vars that
 * opencode itself uses (2.x `Global.Path.config`, `OPENCODE_CONFIG_DIR` first).
 *   OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME/opencode > ~/.config/opencode
 */
export function opencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdg, 'opencode')
}

/**
 * Resolve the highest-precedence opencode config file that exists (2.x loads
 * `opencode.json` then `opencode.jsonc`, the later winning):
 *   opencode.jsonc > opencode.json > (create opencode.json)
 *
 * Returns the path AND whether the file existed on disk. We ALWAYS write back
 * to this exact path so we never create a lower-precedence sibling file.
 */
export function resolveOpencodeConfigFile(): { path: string; existed: boolean } {
  const dir = opencodeConfigDir()
  const jsonc = path.join(dir, 'opencode.jsonc')
  if (fs.existsSync(jsonc)) return { path: jsonc, existed: true }
  const json = path.join(dir, 'opencode.json')
  if (fs.existsSync(json)) return { path: json, existed: true }
  // Neither exists — we'll create opencode.json on first write.
  return { path: json, existed: false }
}

// ─── Write notification ──────────────────────────────────────────────────────

const writeListeners = new Set<(reason: string) => void>()

/**
 * Subscribe to "ClaudeUI wrote opencode's config" (any writer in this module,
 * the raw writer, the agent files). The boot seam wires the reload
 * (`opencode-config-reload.ts`) here, which keeps this module free of the
 * server manager.
 */
export function onOpencodeConfigWritten(cb: (reason: string) => void): () => void {
  writeListeners.add(cb)
  return () => {
    writeListeners.delete(cb)
  }
}

/** Tell the listeners a write happened (only call it when the file changed). */
export function notifyOpencodeConfigWritten(reason: string): void {
  for (const cb of [...writeListeners]) {
    try {
      cb(reason)
    } catch {
      // a listener's failure never fails the write
    }
  }
}

// ─── Native ↔ ClaudeUI shape transforms ─────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? [...(value as string[])]
    : undefined
}

/** `{context, output}` when both are numbers (a half-declared limit is not read). */
function readLimit(limit: unknown): { context: number; output: number } | undefined {
  if (!isRecord(limit)) return undefined
  return typeof limit.context === 'number' && typeof limit.output === 'number'
    ? { context: limit.context, output: limit.output }
    : undefined
}

/** A 1.x model entry → settings (the 1.x leaves verbatim). */
function legacyModelToSettings(modelId: string, entry: JsonRecord): OpencodeProviderModelSettings {
  const m: OpencodeProviderModelSettings = { id: modelId }
  if (str(entry.name)) m.name = entry.name as string
  if (typeof entry.reasoning === 'boolean') m.reasoning = entry.reasoning
  if (typeof entry.attachment === 'boolean') m.attachment = entry.attachment
  if (typeof entry.tool_call === 'boolean') m.toolCall = entry.tool_call
  const input = stringArray(isRecord(entry.modalities) ? entry.modalities.input : undefined)
  if (input) m.inputModalities = input
  const limit = readLimit(entry.limit)
  if (limit) m.limit = limit
  return m
}

/**
 * A 2.x model entry → settings, in the same FIXED key order (the
 * shared-provider adapter compares projections as JSON):
 *   reasoning   — `variants: []` → false (no reasoning variants), a non-empty
 *                 list → true, absent → unknown (2.x generates variants from
 *                 the package for a config-only model)
 *   attachment  — `capabilities.input` has `image`
 *   toolCall / inputModalities — `capabilities.tools` / `.input`
 */
function nativeModelToSettings(modelId: string, entry: JsonRecord): OpencodeProviderModelSettings {
  const m: OpencodeProviderModelSettings = { id: modelId }
  if (str(entry.name)) m.name = entry.name as string
  if (Array.isArray(entry.variants)) m.reasoning = entry.variants.length > 0
  const caps = isRecord(entry.capabilities) ? entry.capabilities : {}
  const input = stringArray(caps.input)
  if (input) m.attachment = input.includes('image')
  if (typeof caps.tools === 'boolean') m.toolCall = caps.tools
  if (input) m.inputModalities = input
  const limit = readLimit(entry.limit)
  if (limit) m.limit = limit
  return m
}

function legacyProviderToSettings(entry: JsonRecord): OpencodeProviderSettings {
  const result: OpencodeProviderSettings = {}
  if (str(entry.name)) result.name = entry.name as string
  if (str(entry.npm)) result.npm = entry.npm as string
  const options = isRecord(entry.options) ? entry.options : {}
  if (str(options.baseURL)) result.baseURL = options.baseURL as string
  else if (str(entry.api)) result.baseURL = entry.api as string
  if (isRecord(entry.models))
    result.models = Object.entries(entry.models).map(([id, v]) =>
      legacyModelToSettings(id, isRecord(v) ? v : {})
    )
  return result
}

function nativeProviderToSettings(entry: JsonRecord): OpencodeProviderSettings {
  const result: OpencodeProviderSettings = {}
  if (str(entry.name)) result.name = entry.name as string
  if (str(entry.package)) result.npm = packageToNpm(entry.package as string)
  const settings = isRecord(entry.settings) ? entry.settings : {}
  if (str(settings.baseURL)) result.baseURL = settings.baseURL as string
  if (isRecord(entry.models))
    result.models = Object.entries(entry.models).map(([id, v]) =>
      nativeModelToSettings(id, isRecord(v) ? v : {})
    )
  return result
}

/** The 2.x `capabilities.input` a model's settings ask for, or undefined. */
function inputFor(
  m: OpencodeProviderModelSettings,
  current?: readonly string[]
): string[] | undefined {
  if (m.inputModalities) return [...m.inputModalities]
  if (m.attachment === undefined) return undefined
  const input = new Set(current ?? V2_DEFAULT_INPUT)
  if (m.attachment) input.add('image')
  else input.delete('image')
  return [...input]
}

/** One model's settings → its 2.x entry (a model being ADDED; kept ones are leaf-edited). */
function settingsModelToNative(m: OpencodeProviderModelSettings): JsonRecord {
  const entry: JsonRecord = {}
  if (m.name) entry.name = m.name
  const capabilities: JsonRecord = {}
  if (m.toolCall !== undefined) capabilities.tools = m.toolCall
  const input = inputFor(m)
  if (input) capabilities.input = input
  if (Object.keys(capabilities).length) entry.capabilities = capabilities
  if (m.reasoning === false) entry.variants = []
  if (m.limit) entry.limit = { context: m.limit.context, output: m.limit.output }
  return entry
}

/** ClaudeUI's provider settings → a 2.x `providers.<id>` entry. */
function settingsProviderToNative(p: OpencodeProviderSettings): JsonRecord {
  const entry: JsonRecord = {}
  if (p.name) entry.name = p.name
  if (p.npm) entry.package = aisdkPackage(p.npm)
  if (p.baseURL) entry.settings = { baseURL: p.baseURL }
  if (p.models && p.models.length > 0)
    entry.models = Object.fromEntries(p.models.map((m) => [m.id, settingsModelToNative(m)]))
  return entry
}

// ─── Provider policies (disabled / enabled providers) ───────────────────────

/**
 * Every `experimental.policies`-equivalent rule of one config document, in the
 * order 2.x evaluates them (`normalizeExperimental`): `enabled_providers`
 * (`*` deny, then one allow per id; an EMPTY list denies everything), then
 * `disabled_providers` (one deny per id), then the native policies.
 */
export interface PolicyRule {
  action: string
  resource: string
  effect: 'allow' | 'deny'
}

function legacyPolicyRules(config: JsonRecord): PolicyRule[] {
  const rules: PolicyRule[] = []
  const enabled = config.enabled_providers
  if (Array.isArray(enabled)) {
    const ids = enabled.filter((v): v is string => typeof v === 'string')
    if (enabled.length === 0 || ids.length) {
      rules.push({ action: 'provider.use', resource: '*', effect: 'deny' })
      for (const id of ids) rules.push({ action: 'provider.use', resource: id, effect: 'allow' })
    }
  }
  if (Array.isArray(config.disabled_providers))
    for (const id of config.disabled_providers)
      if (typeof id === 'string')
        rules.push({ action: 'provider.use', resource: id, effect: 'deny' })
  return rules
}

function nativePolicyRules(config: JsonRecord): unknown[] {
  const experimental = isRecord(config.experimental) ? config.experimental : {}
  return Array.isArray(experimental.policies) ? [...experimental.policies] : []
}

function asPolicy(rule: unknown): PolicyRule | undefined {
  if (!isRecord(rule)) return undefined
  if (typeof rule.action !== 'string' || typeof rule.resource !== 'string') return undefined
  if (rule.effect !== 'allow' && rule.effect !== 'deny') return undefined
  return { action: rule.action, resource: rule.resource, effect: rule.effect }
}

const isLiteral = (resource: string): boolean => !/[*?]/.test(resource)

/** The effect the LAST `provider.use` rule matching `id` gives it (2.x `findLast`). */
function providerEffect(rules: readonly unknown[], id: string): 'allow' | 'deny' | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = asPolicy(rules[i])
    if (rule?.action === 'provider.use' && wildcardMatch(id, rule.resource, process.platform))
      return rule.effect
  }
  return undefined
}

/** The disabled / enabled provider ids one document's policies amount to. */
function projectProviderPolicies(config: JsonRecord): {
  disabled?: string[]
  enabled?: string[]
} {
  const rules = [...legacyPolicyRules(config), ...nativePolicyRules(config)]
  const policies = rules.map(asPolicy)
  const disabled: string[] = []
  for (const rule of policies)
    if (
      rule?.action === 'provider.use' &&
      rule.effect === 'deny' &&
      isLiteral(rule.resource) &&
      !disabled.includes(rule.resource) &&
      providerEffect(rules, rule.resource) === 'deny'
    )
      disabled.push(rule.resource)
  let lastStarDeny = -1
  policies.forEach((rule, i) => {
    if (rule?.action === 'provider.use' && rule.resource === '*' && rule.effect === 'deny')
      lastStarDeny = i
  })
  const enabled: string[] = []
  if (lastStarDeny >= 0)
    for (const rule of policies.slice(lastStarDeny + 1))
      if (
        rule?.action === 'provider.use' &&
        rule.effect === 'allow' &&
        isLiteral(rule.resource) &&
        !enabled.includes(rule.resource) &&
        providerEffect(rules, rule.resource) === 'allow'
      )
        enabled.push(rule.resource)
  return {
    ...(disabled.length ? { disabled } : {}),
    // A `*` deny with no allows (1.x `enabled_providers: []`) denies EVERY
    // provider: an empty allowlist, not "no restriction" (S8 review F9).
    ...(lastStarDeny >= 0 ? { enabled } : {})
  }
}

/**
 * Rewrite the document's provider policies so it disables exactly
 * `disabled` and (when given) allows only `enabled`, as 2.x
 * `experimental.policies`. The 1.x lists, when present, move into the policy
 * list first, in 2.x's own order (the meaning is unchanged), and are deleted.
 * Re-enabling an id removes ClaudeUI-shaped literal denies of it; an id a
 * wildcard still denies gets a literal allow after it (last match wins).
 * Policies of other actions (`permission`) stay where they are.
 */
function writeProviderPolicies(
  doc: JsoncDoc,
  disabled: readonly string[],
  enabled: readonly string[] | undefined
): void {
  const config = doc.value()
  const current = projectProviderPolicies(config)
  let rules: unknown[] = [...legacyPolicyRules(config), ...nativePolicyRules(config)]
  const isProviderRule = (rule: unknown, resource: string, effect: string): boolean => {
    const p = asPolicy(rule)
    return p?.action === 'provider.use' && p.resource === resource && p.effect === effect
  }
  if (!arraysEqual(enabled ? [...enabled] : undefined, current.enabled)) {
    const old = current.enabled ?? []
    rules = rules.filter(
      (rule) =>
        !isProviderRule(rule, '*', 'deny') && !old.some((id) => isProviderRule(rule, id, 'allow'))
    )
    if (enabled)
      rules = [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        ...enabled.map((id) => ({ action: 'provider.use', resource: id, effect: 'allow' })),
        ...rules
      ]
  }
  for (const id of current.disabled ?? []) {
    if (disabled.includes(id)) continue
    rules = rules.filter((rule) => !isProviderRule(rule, id, 'deny'))
    if (providerEffect(rules, id) === 'deny')
      rules.push({ action: 'provider.use', resource: id, effect: 'allow' })
  }
  // A literal deny even where a wildcard already denies: the list stays readable.
  for (const id of disabled)
    if (providerEffect(rules, id) !== 'deny' || !rules.some((r) => isProviderRule(r, id, 'deny')))
      rules.push({ action: 'provider.use', resource: id, effect: 'deny' })
  doc.del(['enabled_providers'])
  doc.del(['disabled_providers'])
  if (rules.length) doc.set(['experimental', 'policies'], rules)
  else doc.del(['experimental', 'policies'])
}

// ─── Moving a 1.x entry to its 2.x key ──────────────────────────────────────

/**
 * Make provider `id` live under `providers.<id>`: when it only exists as
 * `provider.<id>`, write its 2.x form and delete the 1.x entry. A 1.x entry beside a 2.x one is dead in 2.x (the 2.x entry wins
 * whole, with a conflict warning) and is deleted. Exported for the raw writer.
 */
export function moveProviderToNative(doc: JsoncDoc, id: string): void {
  const legacy = doc.get(['provider', id])
  if (!isRecord(legacy)) return
  // Deleting a property takes its comments with it: carry them over (F4).
  const comments = doc.commentsOf(['provider', id])
  const moved = !isRecord(doc.get(['providers', id]))
  if (moved) doc.set(['providers', id], migrateProviderV1(id, legacy))
  doc.del(['provider', id])
  if (moved) doc.insertCommentsBefore(['providers', id], comments)
}

/**
 * The 2.x entry 2.x makes of agent `name`'s 1.x keys (`normalize.ts`): a 1.x
 * `mode.<name>` (a primary agent) REPLACES `agent.<name>` whole; the 1.x
 * `small_model` is the `title` agent's model unless `agent.title` names one.
 * Undefined when there is no 1.x source for it.
 */
export function legacyAgentEntry(config: JsonRecord, name: string): JsonRecord | undefined {
  const legacy = isRecord(config.agent) ? config.agent[name] : undefined
  const modeEntry = isRecord(config.mode) ? config.mode[name] : undefined
  if (isRecord(modeEntry)) return migrateAgentV1({ ...modeEntry, mode: 'primary' })
  const small = name === 'title' ? modelSelectionV1(config.small_model) : undefined
  if (!isRecord(legacy) && !small) return undefined
  const migrated = isRecord(legacy) ? migrateAgentV1(legacy) : {}
  return migrated.model === undefined && small ? { model: small, ...migrated } : migrated
}

/**
 * The same for agent `name` (`agent.<name>` / `mode.<name>` → `agents.<name>`,
 * plus the 1.x `small_model` for `title`), in the form `legacyAgentEntry`
 * computes. Comments of the moved properties are carried over.
 */
export function moveAgentToNative(doc: JsoncDoc, name: string): void {
  const config = doc.value()
  const entry = legacyAgentEntry(config, name)
  if (!entry) return
  const comments = [...doc.commentsOf(['agent', name]), ...doc.commentsOf(['mode', name])]
  const moved = !isRecord(doc.get(['agents', name]))
  if (moved) doc.set(['agents', name], entry)
  doc.del(['agent', name])
  doc.del(['mode', name])
  if (name === 'title') doc.del(['small_model'])
  if (moved) doc.insertCommentsBefore(['agents', name], comments)
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export type NativeOpencodeFields = Pick<
  OpencodeConfigSettings,
  'model' | 'smallModel' | 'providers' | 'disabledProviders' | 'enabledProviders' | 'agents'
>

/**
 * Project a parsed opencode config object (either shape) down to ClaudeUI's
 * managed fields: what 2.x would use. The SINGLE source of the read mapping —
 * the public reader and the diff-driven writer both project through it.
 *
 * Deliberately LOSSY: it models only `{name?, npm?, baseURL?, models:{id,
 * name?, reasoning?, attachment?, toolCall?, inputModalities?, limit?}[]}` per
 * provider and `{model?, temperature?}` per agent — which is why the writer
 * never round-trips a whole subtree from it.
 */
function projectNativeToFields(native: JsonRecord): NativeOpencodeFields {
  const result: NativeOpencodeFields = {}

  const model = selectionToString(native.model)
  if (model) result.model = model

  const nativeAgents = isRecord(native.agents) ? native.agents : {}
  // Every agent as 2.x reads it: the 2.x entry, else what its 1.x keys
  // (`agent`, `mode`, `small_model`) amount to (legacyAgentEntry).
  const agentNames = new Set([
    ...Object.keys(isRecord(native.agent) ? native.agent : {}),
    ...Object.keys(isRecord(native.mode) ? native.mode : {}),
    ...(native.small_model !== undefined ? ['title'] : []),
    ...Object.keys(nativeAgents)
  ])
  const agentView = (name: string): JsonRecord | undefined =>
    isRecord(nativeAgents[name])
      ? (nativeAgents[name] as JsonRecord)
      : legacyAgentEntry(native, name)
  const smallModel = selectionToString(agentView('title')?.model)
  if (smallModel) result.smallModel = smallModel

  const { disabled, enabled } = projectProviderPolicies(native)
  if (disabled) result.disabledProviders = disabled
  if (enabled) result.enabledProviders = enabled

  const providers: Record<string, OpencodeProviderSettings> = {}
  const legacyProviders = isRecord(native.provider) ? native.provider : {}
  const nativeProviders = isRecord(native.providers) ? native.providers : {}
  // A 1.x entry reads as what 2.x makes of it (its migration), so moving it
  // on an edit never changes what ClaudeUI sees.
  for (const [id, entry] of Object.entries(legacyProviders)) {
    if (!isRecord(entry)) continue
    try {
      providers[id] = nativeProviderToSettings(migrateProviderV1(id, entry))
    } catch {
      providers[id] = legacyProviderToSettings(entry) // a retired id 2.x renames
    }
  }
  for (const [id, entry] of Object.entries(nativeProviders))
    if (isRecord(entry)) providers[id] = nativeProviderToSettings(entry)
  if (Object.keys(providers).length > 0) result.providers = providers

  const agents: Record<string, { model?: string; temperature?: number }> = {}
  // `title` is the small model's agent (smallModel), never an override here.
  for (const name of agentNames) {
    const entry = name === 'title' ? undefined : agentView(name)
    if (!entry) continue
    const ag: { model?: string; temperature?: number } = {}
    const m = selectionToString(entry.model)
    if (m) ag.model = m
    const body = isRecord(entry.request) && isRecord(entry.request.body) ? entry.request.body : {}
    if (typeof body.temperature === 'number') ag.temperature = body.temperature
    agents[name] = ag
  }
  if (Object.keys(agents).length > 0) result.agents = agents

  return result
}

/**
 * Read opencode's config file and project ClaudeUI's managed fields. Returns
 * {} if the file is absent or unparseable. NEVER creates the file.
 */
export function readOpencodeNativeConfig(): NativeOpencodeFields {
  const parsed = readResolvedNative()
  return parsed ? projectNativeToFields(parsed) : {}
}

function readResolvedNative(): JsonRecord | null {
  const { path: filePath, existed } = resolveOpencodeConfigFile()
  if (!existed) return null
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = jsoncParse(text) ?? {}
    return isRecord(parsed) ? parsed : {}
  } catch {
    return null
  }
}

/**
 * The union of provider ids declared in BOTH global config files
 * (`opencode.jsonc` AND `opencode.json`), under the 2.x `providers` key and
 * the 1.x `provider` key alike.
 *
 * Why not readOpencodeNativeConfig()? That reader (and the writer) operate on
 * ONE resolved file, for read/write symmetry. opencode loads both global files
 * (each a config document of its own), so a user with a split layout can
 * declare providers in the file ClaudeUI does not resolve. Read-side guards
 * ("is this id a declared custom provider?") must union both files.
 *
 * Missing or unparseable files contribute nothing. Never creates files.
 */
export function readDeclaredProviderIds(): string[] {
  const dir = opencodeConfigDir()
  const ids = new Set<string>()
  for (const fileName of ['opencode.jsonc', 'opencode.json']) {
    const text = safeRead(path.join(dir, fileName))
    if (text === undefined) continue
    let native: unknown
    try {
      native = jsoncParse(text)
    } catch {
      continue
    }
    if (!isRecord(native)) continue
    for (const key of ['provider', 'providers'])
      if (isRecord(native[key])) for (const id of Object.keys(native[key])) ids.add(id)
  }
  return [...ids]
}

// ─── Write ────────────────────────────────────────────────────────────────────

/** Normalise a scalar to undefined when it is an empty string. */
function normScalar(v: string | undefined): string | undefined {
  return v ? v : undefined
}

/** Normalise a string[] to undefined when it is empty. */
function normArray(v: string[] | undefined): string[] | undefined {
  return v && v.length > 0 ? v : undefined
}

/** Order-sensitive array equality (undefined-tolerant). */
function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/** The leaf edits a kept model needs, against its CURRENT 2.x entry. */
function modelEdits(
  doc: JsoncDoc,
  at: string[],
  im: OpencodeProviderModelSettings,
  cm: OpencodeProviderModelSettings
): void {
  const inName = normScalar(im.name)
  if (inName !== normScalar(cm.name)) {
    if (inName === undefined) doc.del([...at, 'name'])
    else doc.set([...at, 'name'], inName)
  }
  // Capability leaves: set when given and changed, never deleted.
  if (im.toolCall !== undefined && im.toolCall !== cm.toolCall)
    doc.set([...at, 'capabilities', 'tools'], im.toolCall)
  const input = inputFor(im, cm.inputModalities)
  if (input && !arraysEqual(input, cm.inputModalities))
    doc.set([...at, 'capabilities', 'input'], input)
  // Only where no list exists: a hand-written non-empty one is the user's (F8).
  if (im.reasoning === false && cm.reasoning === undefined) doc.set([...at, 'variants'], [])
  if (im.reasoning === true && cm.reasoning === false) doc.del([...at, 'variants'])
  if (im.limit && im.limit.context !== cm.limit?.context)
    doc.set([...at, 'limit', 'context'], im.limit.context)
  if (im.limit && im.limit.output !== cm.limit?.output)
    doc.set([...at, 'limit', 'output'], im.limit.output)
}

/** Whether `modelEdits` would change anything (decides whether a 1.x entry must move). */
function modelNeedsEdit(
  im: OpencodeProviderModelSettings,
  cm: OpencodeProviderModelSettings
): boolean {
  return (
    normScalar(im.name) !== normScalar(cm.name) ||
    (im.toolCall !== undefined && im.toolCall !== cm.toolCall) ||
    (im.inputModalities !== undefined && !arraysEqual(im.inputModalities, cm.inputModalities)) ||
    (im.inputModalities === undefined &&
      im.attachment !== undefined &&
      im.attachment !== cm.attachment) ||
    (im.reasoning === false && cm.reasoning === undefined) ||
    (im.reasoning === true && cm.reasoning === false) ||
    (!!im.limit && (im.limit.context !== cm.limit?.context || im.limit.output !== cm.limit?.output))
  )
}

function providerNeedsEdit(
  incoming: OpencodeProviderSettings,
  cur: OpencodeProviderSettings
): boolean {
  if (normScalar(incoming.name) !== normScalar(cur.name)) return true
  if (normScalar(incoming.npm) !== normScalar(cur.npm)) return true
  if (normScalar(incoming.baseURL) !== normScalar(cur.baseURL)) return true
  const inModels = new Map((incoming.models ?? []).map((m) => [m.id, m]))
  const curModels = new Map((cur.models ?? []).map((m) => [m.id, m]))
  for (const id of new Set([...inModels.keys(), ...curModels.keys()])) {
    const im = inModels.get(id)
    const cm = curModels.get(id)
    if (!im || !cm) return true
    if (modelNeedsEdit(im, cm)) return true
  }
  return false
}

// ─── Conflict-aware writes (S8 review F11) ──────────────────────────────────

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** `cur`, with the keys `next` changed relative to `base` taken from `next` (key-wise). */
function rebaseRecord<T extends object>(base: T, next: T, cur: T): T {
  const out = { ...cur } as Record<string, unknown>
  const b = base as Record<string, unknown>
  const n = next as Record<string, unknown>
  for (const key of new Set([...Object.keys(b), ...Object.keys(n)])) {
    if (same(b[key], n[key])) continue
    if (n[key] === undefined) delete out[key]
    else out[key] = n[key]
  }
  return out as T
}

/** A list of ids: what `next` added to / removed from `base`, applied to `cur`. */
function rebaseSet(
  base: string[] | undefined,
  next: string[] | undefined,
  cur: string[] | undefined
): string[] | undefined {
  const b = base ?? []
  const n = next ?? []
  const out = (cur ?? []).filter((id) => !(b.includes(id) && !n.includes(id)))
  for (const id of n) if (!b.includes(id) && !out.includes(id)) out.push(id)
  return out.length ? out : undefined
}

function rebaseProvider(
  base: OpencodeProviderSettings | undefined,
  next: OpencodeProviderSettings,
  cur: OpencodeProviderSettings | undefined
): OpencodeProviderSettings {
  const b = base ?? {}
  const c = cur ?? {}
  const { models: bm, ...bRest } = b
  const { models: nm, ...nRest } = next
  const { models: cm, ...cRest } = c
  const out: OpencodeProviderSettings = rebaseRecord(bRest, nRest, cRest)
  const baseModels = new Map((bm ?? []).map((m) => [m.id, m]))
  const nextModels = new Map((nm ?? []).map((m) => [m.id, m]))
  const models = new Map((cm ?? []).map((m) => [m.id, m]))
  for (const id of new Set([...baseModels.keys(), ...nextModels.keys()])) {
    const bModel = baseModels.get(id)
    const nModel = nextModels.get(id)
    if (same(bModel, nModel)) continue
    if (!nModel) models.delete(id)
    else models.set(id, rebaseRecord(bModel ?? { id }, nModel, models.get(id) ?? { id }))
  }
  if (models.size || cm) out.models = [...models.values()]
  return out
}

/**
 * The fields to write when the caller's `next` was edited from a snapshot
 * `base` that may be STALE: start from what the file holds now (`cur`) and
 * apply only the leaves `next` changed relative to `base`. Anything added to
 * the file since the snapshot (a hand-added provider, a disabled id) stays;
 * nothing absent from the snapshot is deleted.
 */
export function rebaseFields(
  base: NativeOpencodeFields,
  next: NativeOpencodeFields,
  cur: NativeOpencodeFields
): NativeOpencodeFields {
  const out: NativeOpencodeFields = { ...cur }
  for (const key of ['model', 'smallModel'] as const)
    if (base[key] !== next[key]) out[key] = next[key]
  if (!same(base.enabledProviders, next.enabledProviders))
    out.enabledProviders = next.enabledProviders
  if (!same(base.disabledProviders, next.disabledProviders))
    out.disabledProviders = rebaseSet(
      base.disabledProviders,
      next.disabledProviders,
      cur.disabledProviders
    )
  const providers = { ...(cur.providers ?? {}) }
  for (const id of new Set([
    ...Object.keys(base.providers ?? {}),
    ...Object.keys(next.providers ?? {})
  ])) {
    const b = base.providers?.[id]
    const n = next.providers?.[id]
    if (same(b, n)) continue
    if (!n) delete providers[id]
    else providers[id] = rebaseProvider(b, n, providers[id])
  }
  out.providers = Object.keys(providers).length ? providers : undefined
  const agents = { ...(cur.agents ?? {}) }
  for (const name of new Set([
    ...Object.keys(base.agents ?? {}),
    ...Object.keys(next.agents ?? {})
  ])) {
    const b = base.agents?.[name]
    const n = next.agents?.[name]
    if (same(b, n)) continue
    if (!n) delete agents[name]
    else agents[name] = rebaseRecord(b ?? {}, n, agents[name] ?? {})
  }
  out.agents = Object.keys(agents).length ? agents : undefined
  return out
}

/**
 * Write (reconcile) ClaudeUI's managed fields into opencode's config file via
 * DIFF-DRIVEN leaf merges (ADR-031), on 2.x keys (module doc), leaving every
 * other key AND every field ClaudeUI doesn't model byte-preserved.
 *
 * The incoming `fields` are diffed against the projection of the CURRENT file
 * and only CHANGED leaves are written:
 *
 *   - model: set when changed, delete when emptied.
 *   - smallModel: `agents.title.model` (the 1.x `small_model` / `agent.title`
 *     moved there first).
 *   - disabled / enabled providers: `experimental.policies` (writeProviderPolicies).
 *   - providers: per id — add (2.x shape), remove (delete the subtree under
 *     both keys: removing IS the user's intent), or keep with leaf edits
 *     (name, package, settings.baseURL, models per id). A model's capability
 *     leaves are SET when given and changed, never deleted. Never touches
 *     unmodelled fields (settings.apiKey, headers, model cost/settings/…).
 *   - agents: per name — add/remove/keep; keep touches only model and
 *     request.body.temperature.
 *
 * With `base` (the snapshot the caller edited) the write is conflict-aware
 * (`rebaseFields`). Writes are atomic (temp file + rename, mode kept).
 *
 * A no-op save produces ZERO edits and no write (byte-compare gate).
 */
export function writeOpencodeNativeConfig(
  incoming: NativeOpencodeFields,
  base?: NativeOpencodeFields
): void {
  const { path: filePath, existed } = resolveOpencodeConfigFile()
  const originalText = existed ? safeRead(filePath) : undefined
  const doc = new JsoncDoc(originalText ?? '{}')
  const current = projectNativeToFields(doc.value())
  // A caller holding a snapshot (a settings pane) sends it as `base`: only what
  // it changed relative to that snapshot lands on the file as it is NOW (F11).
  const fields = base ? rebaseFields(base, incoming, current) : incoming

  // ── model ──────────────────────────────────────────────────────────────────
  const inModel = normScalar(fields.model)
  if (inModel !== current.model) {
    if (inModel === undefined) doc.del(['model'])
    else doc.set(['model'], inModel)
  }

  // ── smallModel → agents.title.model ────────────────────────────────────────
  const inSmall = normScalar(fields.smallModel)
  if (inSmall !== current.smallModel) {
    moveAgentToNative(doc, 'title')
    if (inSmall === undefined) {
      doc.del(['agents', 'title', 'model'])
      doc.delIfEmpty(['agents', 'title'])
      doc.delIfEmpty(['agents'])
    } else doc.set(['agents', 'title', 'model'], inSmall)
  }

  // ── disabled / enabled providers → experimental.policies ───────────────────
  const inDisabled = normArray(fields.disabledProviders)
  // [] is meaningful here (deny every provider), so it is not normalised away.
  const inEnabled = fields.enabledProviders
  if (
    !arraysEqual(inDisabled, current.disabledProviders) ||
    !arraysEqual(inEnabled, current.enabledProviders)
  )
    writeProviderPolicies(doc, inDisabled ?? [], inEnabled)

  // ── providers (per id, per field) ──────────────────────────────────────────
  const inProviders = fields.providers ?? {}
  const curProviders = current.providers ?? {}
  for (const id of new Set([...Object.keys(inProviders), ...Object.keys(curProviders)])) {
    const incoming = inProviders[id]
    const cur = curProviders[id]
    if (incoming && !cur) {
      doc.set(['providers', id], settingsProviderToNative(incoming))
    } else if (!incoming && cur) {
      doc.del(['providers', id])
      doc.del(['provider', id])
    } else if (incoming && cur && providerNeedsEdit(incoming, cur)) {
      moveProviderToNative(doc, id)
      const entry = doc.get(['providers', id])
      const now = nativeProviderToSettings(isRecord(entry) ? entry : {})
      const at = ['providers', id]
      const inName = normScalar(incoming.name)
      if (inName !== normScalar(now.name)) {
        if (inName === undefined) doc.del([...at, 'name'])
        else doc.set([...at, 'name'], inName)
      }
      const inNpm = normScalar(incoming.npm)
      if (inNpm !== normScalar(now.npm)) {
        if (inNpm === undefined) doc.del([...at, 'package'])
        else doc.set([...at, 'package'], aisdkPackage(inNpm))
      }
      const inBase = normScalar(incoming.baseURL)
      if (inBase !== normScalar(now.baseURL)) {
        // NEVER replace the whole settings object — preserve sibling apiKey etc.
        if (inBase === undefined) doc.del([...at, 'settings', 'baseURL'])
        else doc.set([...at, 'settings', 'baseURL'], inBase)
      }
      const inModels = new Map((incoming.models ?? []).map((m) => [m.id, m]))
      const curModels = new Map((now.models ?? []).map((m) => [m.id, m]))
      for (const modelId of new Set([...inModels.keys(), ...curModels.keys()])) {
        const im = inModels.get(modelId)
        const cm = curModels.get(modelId)
        const mAt = [...at, 'models', modelId]
        if (im && !cm) doc.set(mAt, settingsModelToNative(im))
        else if (!im && cm) doc.del(mAt)
        else if (im && cm) modelEdits(doc, mAt, im, cm)
      }
    }
  }

  // ── agents (per name, per field; `title` is smallModel's) ──────────────────
  const inAgents = fields.agents ?? {}
  const curAgents = current.agents ?? {}
  for (const name of new Set([...Object.keys(inAgents), ...Object.keys(curAgents)])) {
    if (name === 'title') continue
    const incoming = inAgents[name]
    const cur = curAgents[name]
    const inAgentModel = normScalar(incoming?.model)
    const inTemp = incoming?.temperature ?? undefined
    if (incoming && !cur) {
      const entry: JsonRecord = {}
      if (inAgentModel) entry.model = inAgentModel
      if (inTemp !== undefined) entry.request = { body: { temperature: inTemp } }
      doc.set(['agents', name], entry)
    } else if (!incoming && cur) {
      doc.del(['agents', name])
      doc.del(['agent', name])
    } else if (incoming && cur) {
      const curTemp = cur.temperature ?? undefined
      const modelChanged = inAgentModel !== normScalar(cur.model)
      if (!modelChanged && inTemp === curTemp) continue
      moveAgentToNative(doc, name)
      if (modelChanged) {
        if (inAgentModel === undefined) doc.del(['agents', name, 'model'])
        else doc.set(['agents', name, 'model'], inAgentModel)
      }
      if (inTemp !== curTemp) {
        if (inTemp === undefined) {
          doc.del(['agents', name, 'request', 'body', 'temperature'])
          doc.delIfEmpty(['agents', name, 'request', 'body'])
          doc.delIfEmpty(['agents', name, 'request'])
        } else doc.set(['agents', name, 'request', 'body', 'temperature'], inTemp)
      }
    }
  }

  if (writeIfChanged(filePath, doc.text, originalText)) notifyOpencodeConfigWritten('settings')
}

// ─── Built-in tools (top-level permissions) ─────────────────────────────────

export { OPENCODE_SWITCHABLE_TOOLS, toolDisabledIn }

function recordedToolSwitches(): string[] {
  return loadEngineConfig('opencode').opencodeToolSwitches ?? []
}

function recordToolSwitches(next: string[]): void {
  const config = loadEngineConfig('opencode')
  saveEngineConfig('opencode', { ...config, opencodeToolSwitches: next.length ? next : undefined })
}

/**
 * The Tools pane's switch. OFF appends `{action,"*",deny}` to `permissions`
 * (the last rule matching the action, so 2.x's `whollyDisabled` hides the
 * tool) and records that ClaudeUI wrote it. ON removes ONLY that rule — the
 * last exact `{action,"*",deny}`, and only when ClaudeUI's record says it set
 * one — never a rule of the user's (a narrower one, or a deny-all they wrote).
 * A tool the user's own rules switch off cannot be switched on here (throws
 * with the reason); turning a tool on never ADDS an allow.
 *
 * Top-level rules come BEFORE a config-defined agent's own rules in 2.x, so an
 * agent whose own rules allow the tool still offers it (`agentsOverridingSwitch`).
 */
export function setOpencodeToolDisabled(action: string, disabled: boolean): void {
  if (!(OPENCODE_SWITCHABLE_TOOLS as readonly string[]).includes(action))
    throw new Error(`Not a switchable opencode tool: ${JSON.stringify(action)}`)
  const { path: filePath, existed } = resolveOpencodeConfigFile()
  const originalText = existed ? safeRead(filePath) : undefined
  const doc = new JsoncDoc(originalText ?? '{}')
  const recorded = recordedToolSwitches()
  const off = toolDisabledIn(doc.value(), action, process.platform)
  if (disabled) {
    if (off) return
    const rule = { action, resource: '*', effect: 'deny' }
    const list = doc.get(['permissions'])
    if (Array.isArray(list)) doc.insert(['permissions'], list.length, rule)
    else doc.set(['permissions'], [rule])
    if (writeIfChanged(filePath, doc.text, originalText))
      notifyOpencodeConfigWritten(`tool ${action}`)
    if (!recorded.includes(action)) recordToolSwitches([...recorded, action])
    return
  }
  if (!off) {
    if (recorded.includes(action)) recordToolSwitches(recorded.filter((a) => a !== action))
    return
  }
  const list = doc.get(['permissions'])
  const ours = !recorded.includes(action)
    ? -1
    : Array.isArray(list)
      ? list.findLastIndex(
          (r) => isRecord(r) && r.action === action && r.resource === '*' && r.effect === 'deny'
        )
      : -1
  if (ours < 0)
    throw new Error(
      `${action} is switched off by your own permission rules in ${filePath}; ClaudeUI only removes the switch it set`
    )
  doc.del(['permissions', ours])
  if (writeIfChanged(filePath, doc.text, originalText))
    notifyOpencodeConfigWritten(`tool ${action}`)
  recordToolSwitches(recorded.filter((a) => a !== action))
  if (toolDisabledIn(doc.value(), action, process.platform))
    throw new Error(`${action} is still switched off by your own permission rules in ${filePath}`)
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Process-level guard: run the migration at most once per process. */
let migrationRan = false

/**
 * Pure helper — computes what to write to the native file and what to strip
 * from the private EngineConfig, without touching disk.
 *
 * Non-clobber: a native key already present is NOT overwritten.
 * Preserves: autoMode, sandbox, proxy, modelAllowlist in the private config.
 */
export function computeMigrationPatch(
  privCfg: { opencodeConfig?: OpencodeConfigSettings },
  existingNative: NativeOpencodeFields
): {
  nativePatch: NativeOpencodeFields
  strippedPriv: { opencodeConfig?: OpencodeConfigSettings }
} {
  const priv = privCfg.opencodeConfig ?? {}

  // Build nativePatch: only include fields from priv that are absent in native.
  const nativePatch: NativeOpencodeFields = { ...existingNative }

  if (priv.model && !existingNative.model) nativePatch.model = priv.model
  if (priv.smallModel && !existingNative.smallModel) nativePatch.smallModel = priv.smallModel
  if (priv.disabledProviders?.length && !existingNative.disabledProviders?.length)
    nativePatch.disabledProviders = priv.disabledProviders
  if (priv.enabledProviders?.length && !existingNative.enabledProviders?.length)
    nativePatch.enabledProviders = priv.enabledProviders
  if (
    priv.providers &&
    Object.keys(priv.providers).length > 0 &&
    (!existingNative.providers || Object.keys(existingNative.providers).length === 0)
  )
    nativePatch.providers = priv.providers
  if (
    priv.agents &&
    Object.keys(priv.agents).length > 0 &&
    (!existingNative.agents || Object.keys(existingNative.agents).length === 0)
  )
    nativePatch.agents = priv.agents

  // Build strippedPriv: keep only modelAllowlist from opencodeConfig.
  // autoMode, sandbox, proxy stay at the EngineConfig level.
  const { opencodeConfig: _removed, ...rest } = privCfg as Record<string, unknown>
  void _removed

  const keptOpencodeConfig: OpencodeConfigSettings | undefined = priv.modelAllowlist
    ? { modelAllowlist: priv.modelAllowlist }
    : undefined

  const strippedPriv = {
    ...rest,
    ...(keptOpencodeConfig !== undefined ? { opencodeConfig: keptOpencodeConfig } : {})
  } as { opencodeConfig?: OpencodeConfigSettings }

  return { nativePatch, strippedPriv }
}

/**
 * One-time migration: move the six native-bound fields from ClaudeUI's private
 * engines/opencode.json into opencode's own global config file.
 *
 * - Non-clobber: native keys already present are not overwritten.
 * - Preserves autoMode, sandbox, proxy, and modelAllowlist in the private file.
 * - Process-guarded: runs at most once per process (idempotent via the file too,
 *   since after the first run the six keys are gone from the private file).
 *
 * The caller (IPC handler) is responsible for the installed-gate check.
 */
export function migrateOpencodeConfigToNative(): void {
  if (migrationRan) return
  migrationRan = true

  try {
    const engCfg = loadEngineConfig('opencode')
    const priv = engCfg.opencodeConfig ?? {}

    // Nothing to migrate if none of the six native fields are set.
    const hasMigratable =
      priv.model ||
      priv.smallModel ||
      priv.disabledProviders?.length ||
      priv.enabledProviders?.length ||
      (priv.providers && Object.keys(priv.providers).length > 0) ||
      (priv.agents && Object.keys(priv.agents).length > 0)

    if (!hasMigratable) return

    const existingNative = readOpencodeNativeConfig()
    const { nativePatch, strippedPriv } = computeMigrationPatch(engCfg, existingNative)

    // Write the native fields to opencode's file.
    writeOpencodeNativeConfig(nativePatch)

    // Strip the six fields from the private file, preserving the rest.
    // Assign opencodeConfig explicitly (NOT a spread) — strippedPriv omits the
    // opencodeConfig key when modelAllowlist is absent, so spreading it would
    // leave engCfg.opencodeConfig (with all six migrated fields) untouched and
    // the migration would re-run on every boot. `opencodeConfig: undefined` is
    // dropped by JSON.stringify on write, correctly removing the six fields.
    // `...engCfg` preserves autoMode/sandbox/proxy.
    saveEngineConfig('opencode', {
      ...engCfg,
      opencodeConfig: strippedPriv.opencodeConfig
    })
  } catch {
    // Migration is best-effort — never crash the app if it fails.
  }
}

/**
 * Test-only: reset the process-level migration guard so a second test can drive
 * migrateOpencodeConfigToNative() afresh. Never called in production.
 */
export function __resetMigrationGuardForTests(): void {
  migrationRan = false
}
