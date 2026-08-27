/**
 * opencode-native-raw.ts
 *
 * The NON-lossy sibling of opencode-config.ts's projection writer (ADR-031).
 *
 * Where writeOpencodeNativeConfig() projects opencode's rich ConfigV1 down to the
 * six modelled keys and reconciles them, this module reads/writes opencode's own
 * config file with NO projection: the schema-driven settings UI hands us the
 * literal opencode field names (attachment, modalities, tool_call, cost, limit,
 * …) and we patch exactly those leaves through jsonc-parser modify()+applyEdits,
 * byte-preserving every comment and sibling.
 *
 * Both writers share the same resolved file (resolveOpencodeConfigFile), the same
 * EOL/formatting/write-gate discipline (opencode-jsonc-io), and the same
 * delete-safety INVARIANT: jsonc-parser modify() THROWS when deleting under a
 * missing parent, so a delete patch is a no-op unless its path exists in the
 * CURRENT parsed doc.
 */

import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction, AnySchemaObject } from 'ajv/dist/2020'
import { modify, applyEdits } from 'jsonc-parser'
import type { FormattingOptions } from 'jsonc-parser'
import { resolveOpencodeConfigFile } from './opencode-config'
import { detectEol, safeRead, jsoncParseSafe, writeIfChanged } from './opencode-jsonc-io'
import { isPlainObject } from '../../shared/opencode-config-diff'
import type { RawConfigPatch } from '../../shared/types'
import schemaJson from '../../shared/opencode-config-schema.1.18.23.json'

// ─── Patch shape ────────────────────────────────────────────────────────────

/**
 * Top-level keys the raw patcher REFUSES to touch (defense in depth). Each has a
 * dedicated owner elsewhere and a raw write here would fight that owner:
 *   model / small_model / disabled_providers / enabled_providers / agent
 *     → the ADR-031 projection writer (saveOpencodeSettings) + Models/Agents UIs
 *   mcp        → mcp.claudeui is injected ephemerally at spawn; user mcp.* is user-owned
 *   permission → derived from ClaudeUI's neutral autonomy-mode mapping (ADR-022)
 *   $schema    → not user-editable config
 *
 * `provider` is DELIBERATELY absent: the model-capability editor (part C2) writes
 * provider.<id>.models.<modelId>.<capability> leaves through this exact path, and
 * that composes with the projection writer because both are leaf-scoped.
 */
export const RAW_PATCH_EXCLUDED_TOP_LEVEL: ReadonlySet<string> = new Set([
  '$schema',
  'model',
  'small_model',
  'disabled_providers',
  'enabled_providers',
  'agent',
  'mcp',
  'permission'
])

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the resolved opencode config file as its RAW parsed jsonc object (no
 * projection). Returns `{}` when the file is absent / unreadable / unparseable.
 * NEVER creates the file. `path` is the resolved write target (useful for UI).
 */
export function readOpencodeNativeRaw(): { config: Record<string, unknown>; path: string } {
  const { path: filePath, existed } = resolveOpencodeConfigFile()
  if (!existed) return { config: {}, path: filePath }
  const text = safeRead(filePath)
  if (text === undefined) return { config: {}, path: filePath }
  const parsed = jsoncParseSafe(text)
  return { config: isPlainObject(parsed) ? parsed : {}, path: filePath }
}

// ─── Schema validation (ajv, draft 2020-12) ─────────────────────────────────

let cachedValidator: ValidateFunction | null = null

/**
 * Prepare the vendored schema for ajv:
 *  - drop the non-standard root keys allowComments / allowTrailingCommas
 *  - drop every `additionalProperties: false` so a config carrying keys this
 *    PINNED schema doesn't model (unknown top-level keys, future opencode fields,
 *    hand-added nested options) does NOT fail validation. Type/enum/format
 *    constraints on the fields we DO edit are still enforced — which is all the
 *    guard needs to catch a malformed edit (e.g. attachment: "yes"). opencode's
 *    own binary remains the authoritative validator.
 */
function prepareSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prepareSchema)
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === 'allowComments' || k === 'allowTrailingCommas') continue
      if (k === 'additionalProperties' && v === false) continue
      out[k] = prepareSchema(v)
    }
    return out
  }
  return node
}

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  // The schema $refs an external models.dev schema for `model`/`small_model`.
  // We don't edit those keys, so a permissive string stub is enough to compile.
  ajv.addSchema({
    $id: 'https://models.dev/model-schema.json',
    $defs: { Model: { type: 'string' } }
  })
  cachedValidator = ajv.compile(prepareSchema(schemaJson) as AnySchemaObject)
  return cachedValidator
}

/** Throw with ajv's error text when `config` violates the vendored schema. */
function validateAgainstSchema(config: unknown): void {
  const validate = getValidator()
  if (!validate(config)) {
    const ajvText = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ')
    throw new Error(`opencode config would be invalid: ${ajvText || 'unknown validation error'}`)
  }
}

// ─── Write (leaf patches) ─────────────────────────────────────────────────────

/** Whether `path` resolves to an existing leaf/branch in `obj`. */
function pathExists(obj: unknown, path: (string | number)[]): boolean {
  let cur: unknown = obj
  for (const seg of path) {
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || seg < 0 || seg >= cur.length) return false
      cur = cur[seg]
    } else if (isPlainObject(cur)) {
      if (!(String(seg) in cur)) return false
      cur = cur[String(seg)]
    } else {
      return false
    }
  }
  return true
}

/**
 * Apply patches to a plain JS object IN PLACE (used only for pre-write schema
 * validation of the projected result — the on-disk write goes through
 * jsonc-parser to preserve comments). Set creates missing parents; delete is a
 * no-op when the path is absent (mirrors the on-disk delete-safety).
 */
function applyPatchesToObject(
  root: Record<string, unknown>,
  patches: RawConfigPatch[]
): Record<string, unknown> {
  for (const patch of patches) {
    const path = patch.path
    if (path.length === 0) continue
    const isDelete = !('value' in patch) || patch.value === undefined
    if (isDelete) {
      if (!pathExists(root, path)) continue
      let cur: Record<string, unknown> = root
      for (let i = 0; i < path.length - 1; i++) {
        cur = cur[String(path[i])] as Record<string, unknown>
      }
      delete cur[String(path[path.length - 1])]
    } else {
      let cur: Record<string, unknown> = root
      for (let i = 0; i < path.length - 1; i++) {
        const key = String(path[i])
        if (!isPlainObject(cur[key])) cur[key] = {}
        cur = cur[key] as Record<string, unknown>
      }
      cur[String(path[path.length - 1])] = patch.value
    }
  }
  return root
}

/**
 * Apply leaf patches to opencode's resolved config file via jsonc-parser
 * modify()+applyEdits, byte-preserving comments and sibling keys.
 *
 * Guarantees:
 *  - Rejects any patch whose top-level key is in RAW_PATCH_EXCLUDED_TOP_LEVEL.
 *  - Validates the RESULTING config against the vendored schema BEFORE writing;
 *    throws (with ajv text) on violation — nothing is written.
 *  - Delete patches are no-ops when the path is absent in the current parsed doc
 *    (the modify() delete-under-missing-parent INVARIANT).
 *  - Byte-compare write gate: patches producing no textual change → no write.
 */
export function patchOpencodeNativeRaw(patches: RawConfigPatch[]): void {
  for (const patch of patches) {
    if (patch.path.length === 0) {
      throw new Error('Refusing to apply a patch with an empty path')
    }
    const top = patch.path[0]
    if (typeof top === 'string' && RAW_PATCH_EXCLUDED_TOP_LEVEL.has(top)) {
      throw new Error(`Refusing to patch protected opencode config key "${top}"`)
    }
  }

  const { path: filePath, existed } = resolveOpencodeConfigFile()
  const originalText = existed ? safeRead(filePath) : undefined
  const baseText = originalText ?? '{}'
  const parsed = (jsoncParseSafe(baseText) ?? {}) as Record<string, unknown>

  // Validate the projected RESULT (against a deep clone) before touching disk.
  const projected = applyPatchesToObject(structuredClone(parsed), patches)
  validateAgainstSchema(projected)

  const eol = detectEol(baseText)
  const fmt: FormattingOptions = { insertSpaces: true, tabSize: 2, eol }
  let text = baseText
  for (const patch of patches) {
    const isDelete = !('value' in patch) || patch.value === undefined
    if (isDelete) {
      // INVARIANT: modify() throws deleting under a missing parent — skip absent.
      if (!pathExists(parsed, patch.path)) continue
      text = applyEdits(text, modify(text, patch.path, undefined, { formattingOptions: fmt }))
    } else {
      text = applyEdits(text, modify(text, patch.path, patch.value, { formattingOptions: fmt }))
    }
  }

  writeIfChanged(filePath, text, originalText)
}

/** Test-only: drop the memoised ajv validator so a fresh schema can recompile. */
export function __resetValidatorForTests(): void {
  cachedValidator = null
}
