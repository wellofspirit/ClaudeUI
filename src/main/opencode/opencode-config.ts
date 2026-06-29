/**
 * opencode-config.ts
 *
 * Owns reading and writing opencode's OWN global config file in place,
 * using jsonc-parser for comment-safe edits. Mirrors the role that
 * claude-settings.ts plays for Claude's ~/.claude/settings.json.
 *
 * Managed native keys (the six the spec calls engine-native):
 *   model, small_model, provider, disabled_providers, enabled_providers, agent
 *
 * Keys that stay ClaudeUI-private and are NEVER written here:
 *   modelAllowlist (picker filter, opencode doesn't understand it)
 *
 * The hosted-MCP mcp.claudeui block remains ephemeral in OPENCODE_CONFIG_CONTENT.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as jsoncParse, modify, applyEdits } from 'jsonc-parser'
import type { FormattingOptions } from 'jsonc-parser'
import {
  loadEngineConfig,
  saveEngineConfig
} from '../services/ui-config'
import type { OpencodeConfigSettings, OpencodeProviderSettings } from '../../shared/types'

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the opencode config directory, honouring the same env vars that
 * opencode itself uses (xdg-basedir@5, which does NOT special-case Windows).
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
 * Resolve the highest-precedence opencode config file that exists, per the
 * opencode config.ts precedence order:
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

// ─── Native ↔ ClaudeUI shape transforms ─────────────────────────────────────

/**
 * Map opencode's native provider record shape → ClaudeUI's OpencodeProviderSettings:
 *   { name?, options?: { baseURL? }, models?: Record<id, {name?}> }
 *   → { name?, baseURL?, models?: { id, name? }[] }
 */
function nativeProviderToSettings(
  id: string,
  entry: Record<string, unknown>
): OpencodeProviderSettings {
  const result: OpencodeProviderSettings = {}
  if (typeof entry.name === 'string' && entry.name) result.name = entry.name
  const options = entry.options as Record<string, unknown> | undefined
  if (options && typeof options.baseURL === 'string' && options.baseURL) {
    result.baseURL = options.baseURL
  }
  const nativeModels = entry.models as Record<string, unknown> | undefined
  if (nativeModels && typeof nativeModels === 'object' && !Array.isArray(nativeModels)) {
    result.models = Object.entries(nativeModels).map(([modelId, v]) => {
      const modelEntry = v as Record<string, unknown>
      const m: { id: string; name?: string } = { id: modelId }
      if (typeof modelEntry?.name === 'string' && modelEntry.name) m.name = modelEntry.name
      return m
    })
  }
  void id // id is validated by the caller
  return result
}

/**
 * Map ClaudeUI's OpencodeProviderSettings → opencode's native provider record shape.
 */
function settingsProviderToNative(p: OpencodeProviderSettings): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (p.name) entry.name = p.name
  if (p.baseURL) entry.options = { baseURL: p.baseURL }
  if (p.models && p.models.length > 0) {
    entry.models = Object.fromEntries(
      p.models.map((m) => [m.id, m.name ? { name: m.name } : {}])
    )
  }
  return entry
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export type NativeOpencodeFields = Pick<
  OpencodeConfigSettings,
  'model' | 'smallModel' | 'providers' | 'disabledProviders' | 'enabledProviders' | 'agents'
>

/**
 * Read opencode's native config file and map the six managed keys to the
 * ClaudeUI shape. Returns {} if the file is absent or unparseable.
 * NEVER creates the file — reading is always harmless.
 */
export function readOpencodeNativeConfig(): NativeOpencodeFields {
  const { path: filePath, existed } = resolveOpencodeConfigFile()
  if (!existed) return {}

  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }

  let native: Record<string, unknown>
  try {
    native = (jsoncParse(text) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }

  const result: NativeOpencodeFields = {}

  if (typeof native.model === 'string' && native.model) result.model = native.model
  if (typeof native.small_model === 'string' && native.small_model)
    result.smallModel = native.small_model

  const dp = native.disabled_providers
  if (Array.isArray(dp) && dp.length > 0) {
    result.disabledProviders = dp.filter((v): v is string => typeof v === 'string')
  }

  const ep = native.enabled_providers
  if (Array.isArray(ep) && ep.length > 0) {
    result.enabledProviders = ep.filter((v): v is string => typeof v === 'string')
  }

  const prov = native.provider
  if (prov && typeof prov === 'object' && !Array.isArray(prov)) {
    const provRecord = prov as Record<string, unknown>
    const providers: Record<string, OpencodeProviderSettings> = {}
    for (const [id, entry] of Object.entries(provRecord)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        providers[id] = nativeProviderToSettings(id, entry as Record<string, unknown>)
      }
    }
    if (Object.keys(providers).length > 0) result.providers = providers
  }

  const agentNative = native.agent
  if (agentNative && typeof agentNative === 'object' && !Array.isArray(agentNative)) {
    const agentRecord = agentNative as Record<string, unknown>
    const agents: Record<string, { model?: string; temperature?: number }> = {}
    for (const [name, a] of Object.entries(agentRecord)) {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        const entry = a as Record<string, unknown>
        const ag: { model?: string; temperature?: number } = {}
        if (typeof entry.model === 'string' && entry.model) ag.model = entry.model
        if (typeof entry.temperature === 'number') ag.temperature = entry.temperature
        agents[name] = ag
      }
    }
    if (Object.keys(agents).length > 0) result.agents = agents
  }

  return result
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Detect line ending from existing content, defaulting to '\n'.
 */
function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Determine if a value is "empty" for purposes of deletion:
 * undefined, '', [], or {}
 */
function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

/**
 * Write (reconcile) the six managed native keys into opencode's config file,
 * leaving all other keys (theme, keybinds, mcp, etc.) byte-for-byte unchanged.
 *
 * If a field is absent/empty in `fields`, the corresponding native key is
 * DELETED from the file (so removing a provider in the UI removes it from the
 * file). Fields not in the six managed set are never touched.
 *
 * Always writes to the same file we read (no new file created if .jsonc exists).
 * Ensures the config directory exists before writing.
 */
export function writeOpencodeNativeConfig(fields: NativeOpencodeFields): void {
  const { path: filePath } = resolveOpencodeConfigFile()

  // Ensure the directory exists.
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  // Start with the existing content, or empty object for a new file.
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    text = '{}'
  }

  const eol = detectEol(text)
  const fmt: FormattingOptions = { insertSpaces: true, tabSize: 2, eol }

  // The six managed native keys and their corresponding values.
  // Order: apply each key sequentially, re-applying edits per key.

  type ManagedKey = {
    nativeKey: string
    value: unknown
  }

  // Build provider native object
  let providerValue: Record<string, unknown> | undefined
  if (!isEmpty(fields.providers)) {
    providerValue = {}
    for (const [id, p] of Object.entries(fields.providers!)) {
      providerValue[id] = settingsProviderToNative(p)
    }
  }

  // Build agent native object
  let agentValue: Record<string, unknown> | undefined
  if (!isEmpty(fields.agents)) {
    agentValue = {}
    for (const [name, a] of Object.entries(fields.agents!)) {
      const entry: Record<string, unknown> = {}
      if (a.model) entry.model = a.model
      if (a.temperature != null) entry.temperature = a.temperature
      agentValue[name] = entry
    }
  }

  const managedKeys: ManagedKey[] = [
    { nativeKey: 'model', value: fields.model || undefined },
    { nativeKey: 'small_model', value: fields.smallModel || undefined },
    {
      nativeKey: 'disabled_providers',
      value:
        fields.disabledProviders && fields.disabledProviders.length > 0
          ? fields.disabledProviders
          : undefined
    },
    {
      nativeKey: 'enabled_providers',
      value:
        fields.enabledProviders && fields.enabledProviders.length > 0
          ? fields.enabledProviders
          : undefined
    },
    { nativeKey: 'provider', value: providerValue },
    { nativeKey: 'agent', value: agentValue }
  ]

  for (const { nativeKey, value } of managedKeys) {
    const edits = modify(text, [nativeKey], value === undefined ? undefined : value, {
      formattingOptions: fmt
    })
    text = applyEdits(text, edits)
  }

  fs.writeFileSync(filePath, text, 'utf8')
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
