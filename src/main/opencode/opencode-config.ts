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
import { detectEol, safeRead, jsoncParseSafe } from './opencode-jsonc-io'
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
 * Project a parsed opencode-native config object down to the six managed keys in
 * ClaudeUI's shape. This is the SINGLE source of the read mapping — both the
 * public reader and the diff-driven writer project through it so the write diff
 * base is computed identically to what the UI reads.
 *
 * The projection is deliberately LOSSY: it models only `{name?, baseURL?,
 * models:{id,name?}[]}` per provider and `{model?, temperature?}` per agent.
 * Everything else opencode understands (model-level attachment/modalities/
 * tool_call/cost/limit, provider-level npm/options.apiKey, unknown agent fields)
 * is invisible here — which is exactly why the writer must never round-trip a
 * whole subtree from this projection.
 */
function projectNativeToFields(native: Record<string, unknown>): NativeOpencodeFields {
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

/**
 * Read opencode's native config file and map the six managed keys to the
 * ClaudeUI shape. Returns {} if the file is absent or unparseable.
 * NEVER creates the file — reading is always harmless.
 */
export function readOpencodeNativeConfig(): NativeOpencodeFields {
  const parsed = readResolvedNative()
  return parsed ? projectNativeToFields(parsed) : {}
}

/**
 * Parse the resolved config file into a raw native object, or return null when
 * the file is absent / unreadable / unparseable. Shared by the reader and the
 * writer's diff base. NEVER creates the file.
 */
function readResolvedNative(): Record<string, unknown> | null {
  const { path: filePath, existed } = resolveOpencodeConfigFile()
  if (!existed) return null
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    return (jsoncParse(text) ?? {}) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Return the union of provider ids declared in the `provider` object of BOTH
 * global config files (`opencode.jsonc` AND `opencode.json`) when present.
 *
 * Why not readOpencodeNativeConfig()? That reader (and the writer) deliberately
 * operate on ONE resolved file — resolveOpencodeConfigFile()'s jsonc-first
 * precedence — because the Custom providers editor depends on read/write
 * symmetry. But opencode itself MERGES both global files at load (verified via
 * GET /config: `provider` from opencode.json and `disabled_providers` from
 * opencode.jsonc surface simultaneously), so a user with a split layout can
 * declare custom providers in the file ClaudeUI does NOT resolve. Read-side
 * guards about "is this id a declared custom provider?" must therefore union
 * both files, not trust the single write target.
 *
 * Missing or unparseable files contribute nothing. Never creates files.
 */
export function readDeclaredProviderIds(): string[] {
  const dir = opencodeConfigDir()
  const ids = new Set<string>()
  for (const fileName of ['opencode.jsonc', 'opencode.json']) {
    const filePath = path.join(dir, fileName)
    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    let native: Record<string, unknown>
    try {
      native = (jsoncParse(text) ?? {}) as Record<string, unknown>
    } catch {
      continue
    }
    const prov = native.provider
    if (prov && typeof prov === 'object' && !Array.isArray(prov)) {
      for (const id of Object.keys(prov as Record<string, unknown>)) ids.add(id)
    }
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

/**
 * Write (reconcile) the six managed native keys into opencode's config file via
 * DIFF-DRIVEN leaf merges (ADR-031), leaving every other key AND every field
 * ClaudeUI doesn't model byte-preserved.
 *
 * The incoming `fields` are diffed against the projection of the CURRENT file
 * (via projectNativeToFields — the same mapping readOpencodeNativeConfig uses),
 * and only CHANGED leaves are emitted as jsonc-parser `modify()` edits:
 *
 *   - model / small_model: set when changed, delete when emptied.
 *   - disabled_providers / enabled_providers: atomic arrays — replace when
 *     different, delete when emptied.
 *   - provider: per id — add (whole native shape), remove (delete subtree, which
 *     IS user intent), or keep with per-field leaf edits (name, options.baseURL,
 *     models per id). Never touches unmodelled fields (npm, options.apiKey,
 *     model attachment/modalities/tool_call/cost/limit/…).
 *   - agent: per name — add/remove/keep; keep touches only model/temperature and
 *     preserves unknown entry fields (prompt, mode, permission, …).
 *
 * A no-op save produces ZERO edits and no write (byte-compare gate). Always
 * writes to the same file we read (no new file created if .jsonc exists).
 *
 * Note: the diff base is the SAME resolved file we write. A provider declared
 * only in the OTHER global file (json vs jsonc split — see readDeclaredProviderIds)
 * is invisible to both the projection and the UI's incoming set, so it appears in
 * neither side of the diff and is therefore never deleted.
 */
export function writeOpencodeNativeConfig(fields: NativeOpencodeFields): void {
  const { path: filePath, existed } = resolveOpencodeConfigFile()

  const originalText = existed ? safeRead(filePath) : undefined
  const baseText = originalText ?? '{}'

  const eol = detectEol(baseText)
  const fmt: FormattingOptions = { insertSpaces: true, tabSize: 2, eol }

  const current = projectNativeToFields((jsoncParseSafe(baseText) ?? {}) as Record<string, unknown>)

  let text = baseText
  const set = (jsonPath: (string | number)[], value: unknown): void => {
    text = applyEdits(text, modify(text, jsonPath, value, { formattingOptions: fmt }))
  }
  // INVARIANT: only call del() for paths the projection saw in THIS text (a
  // defined `current.*` leaf). jsonc-parser's modify() throws when deleting
  // under a missing parent; a projection-witnessed key guarantees the parent
  // chain exists. Diffing against any other base would break this.
  const del = (jsonPath: (string | number)[]): void => {
    text = applyEdits(text, modify(text, jsonPath, undefined, { formattingOptions: fmt }))
  }
  const reconcileScalar = (
    key: string,
    incoming: string | undefined,
    cur: string | undefined
  ): void => {
    if (incoming === cur) return
    if (incoming === undefined) {
      if (cur !== undefined) del([key])
    } else {
      set([key], incoming)
    }
  }
  const reconcileArray = (
    key: string,
    incoming: string[] | undefined,
    cur: string[] | undefined
  ): void => {
    if (arraysEqual(incoming, cur)) return
    if (incoming === undefined) {
      if (cur !== undefined) del([key])
    } else {
      set([key], incoming)
    }
  }

  // ── model / small_model (scalars) ──────────────────────────────────────────
  reconcileScalar('model', normScalar(fields.model), current.model)
  reconcileScalar('small_model', normScalar(fields.smallModel), current.smallModel)

  // ── disabled_providers / enabled_providers (atomic arrays) ──────────────────
  reconcileArray('disabled_providers', normArray(fields.disabledProviders), current.disabledProviders)
  reconcileArray('enabled_providers', normArray(fields.enabledProviders), current.enabledProviders)

  // ── provider (per id, per field) ────────────────────────────────────────────
  const inProviders = fields.providers ?? {}
  const curProviders = current.providers ?? {}
  for (const id of new Set([...Object.keys(inProviders), ...Object.keys(curProviders)])) {
    const incoming = inProviders[id]
    const cur = curProviders[id]
    if (incoming && !cur) {
      // Added → set the whole native shape.
      set(['provider', id], settingsProviderToNative(incoming))
    } else if (!incoming && cur) {
      // Removed → delete the whole subtree (that IS the user's intent).
      del(['provider', id])
    } else if (incoming && cur) {
      // Kept → per-field leaf edits only.
      const inName = normScalar(incoming.name)
      const curName = normScalar(cur.name)
      if (inName !== curName) {
        if (inName === undefined) del(['provider', id, 'name'])
        else set(['provider', id, 'name'], inName)
      }
      const inBase = normScalar(incoming.baseURL)
      const curBase = normScalar(cur.baseURL)
      if (inBase !== curBase) {
        // NEVER replace the whole options object — preserve sibling apiKey etc.
        if (inBase === undefined) del(['provider', id, 'options', 'baseURL'])
        else set(['provider', id, 'options', 'baseURL'], inBase)
      }
      // Models, per id.
      const inModels = new Map((incoming.models ?? []).map((m) => [m.id, m]))
      const curModels = new Map((cur.models ?? []).map((m) => [m.id, m]))
      for (const modelId of new Set([...inModels.keys(), ...curModels.keys()])) {
        const im = inModels.get(modelId)
        const cm = curModels.get(modelId)
        if (im && !cm) {
          set(['provider', id, 'models', modelId], im.name ? { name: im.name } : {})
        } else if (!im && cm) {
          del(['provider', id, 'models', modelId])
        } else if (im && cm) {
          const inMName = normScalar(im.name)
          const curMName = normScalar(cm.name)
          if (inMName !== curMName) {
            if (inMName === undefined) del(['provider', id, 'models', modelId, 'name'])
            else set(['provider', id, 'models', modelId, 'name'], inMName)
          }
        }
      }
    }
  }

  // ── agent (per name, per field) ──────────────────────────────────────────────
  const inAgents = fields.agents ?? {}
  const curAgents = current.agents ?? {}
  for (const name of new Set([...Object.keys(inAgents), ...Object.keys(curAgents)])) {
    const incoming = inAgents[name]
    const cur = curAgents[name]
    if (incoming && !cur) {
      const entry: Record<string, unknown> = {}
      if (incoming.model) entry.model = incoming.model
      if (incoming.temperature != null) entry.temperature = incoming.temperature
      set(['agent', name], entry)
    } else if (!incoming && cur) {
      del(['agent', name])
    } else if (incoming && cur) {
      const inModel = normScalar(incoming.model)
      const curModel = normScalar(cur.model)
      if (inModel !== curModel) {
        if (inModel === undefined) del(['agent', name, 'model'])
        else set(['agent', name, 'model'], inModel)
      }
      const inTemp = incoming.temperature ?? undefined
      const curTemp = cur.temperature ?? undefined
      if (inTemp !== curTemp) {
        if (inTemp === undefined) del(['agent', name, 'temperature'])
        else set(['agent', name, 'temperature'], inTemp)
      }
    }
  }

  // Byte-compare gate: only write when something actually changed.
  if (text === originalText) return

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
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
