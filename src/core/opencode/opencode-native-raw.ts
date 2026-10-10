/**
 * opencode-native-raw.ts
 *
 * The NON-lossy sibling of opencode-config.ts's projection writer (ADR-031).
 *
 * Where writeOpencodeNativeConfig() projects opencode's config down to the
 * fields ClaudeUI models and reconciles them, this module reads/writes
 * opencode's own config file with NO projection: the schema-driven settings UI
 * and the curated panes hand us literal opencode 2.x paths (`media.image.…`,
 * `providers.<id>.models.<m>.capabilities.input`, …) and we patch exactly those
 * leaves through jsonc-parser, byte-preserving every comment and sibling.
 *
 * opencode 2.x (ADR-097 S8):
 *  - The schema is the pinned 2.x `Config.InfoEncoded`
 *    (`shared/opencode-config-schema.json`, generated).
 *  - A SET may only name a path that schema has: 1.x keys (`provider`,
 *    `logLevel`, `compaction.tail_turns`, …) are refused, so the file never
 *    gains a key 2.x warns about. A DELETE of a 1.x leaf is allowed (that is
 *    how a pane resets a key it used to own), except the ones the projection
 *    writer owns.
 *  - Validation covers the TOUCHED top-level keys only: a 1.x value elsewhere
 *    in the user's file (2.x still reads it) never blocks an unrelated edit.
 *  - A patch under `providers.<id>` for a provider that only exists as a 1.x
 *    `provider.<id>` moves that entry to its 2.x key first, whole
 *    (`moveProviderToNative`), so the edit lands on the entry 2.x uses; the
 *    same for `attachment` → `media` and `snapshot` → `snapshots`.
 */

import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction, AnySchemaObject } from 'ajv/dist/2020'
import {
  moveProviderToNative,
  notifyOpencodeConfigWritten,
  resolveOpencodeConfigFile
} from './opencode-config'
import { JsoncDoc, safeRead, jsoncParseSafe, writeIfChanged } from './opencode-jsonc-io'
import { isPlainObject } from '../../shared/opencode-config-diff'
import type { RawConfigPatch } from '../../shared/types'
import schemaJson from '../../shared/opencode-config-schema.json'

// ─── Patch shape ────────────────────────────────────────────────────────────

/**
 * Paths the raw patcher REFUSES to touch (defense in depth), as prefixes. Each
 * has a dedicated owner elsewhere and a raw write here would fight it:
 *   model / agents        → the projection writer (Models: default + small
 *                           model) and the agent editor
 *   mcp.servers           → ClaudeUI injects its own at spawn; the user's are theirs
 *   permissions           → the Tools pane's own writer + autonomy (ADR-022)
 *   experimental.policies → the provider enable/disable writer
 *   $schema               → not user-editable config
 * and the 1.x keys those owners read and move (provider, agent, small_model,
 * disabled_providers, enabled_providers, permission, tools, mode).
 *
 * `providers` is DELIBERATELY absent: the model-capability editor writes
 * `providers.<id>.models.<m>.…` leaves through this path, which composes with
 * the projection writer because both are leaf-scoped.
 */
export const RAW_PATCH_EXCLUDED_PATHS: readonly (readonly string[])[] = [
  ['$schema'],
  ['model'],
  ['agents'],
  ['mcp', 'servers'],
  ['permissions'],
  ['experimental', 'policies'],
  ['provider'],
  ['agent'],
  ['small_model'],
  ['disabled_providers'],
  ['enabled_providers'],
  ['permission'],
  ['tools'],
  ['mode']
]

function excludedBy(path: (string | number)[]): readonly string[] | undefined {
  return RAW_PATCH_EXCLUDED_PATHS.find(
    (prefix) =>
      // `mcp` as a whole is excluded when the patch would replace `mcp.servers` with it.
      (path.length < prefix.length &&
        path.every((seg, i) => String(seg) === prefix[i]) &&
        prefix.length > 1) ||
      prefix.every((seg, i) => String(path[i]) === seg)
  )
}

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

// ─── Schema ───────────────────────────────────────────────────────────────────

type Node = Record<string, unknown>
const DEFS = (schemaJson as { $defs: Record<string, Node> }).$defs
const ROOT = DEFS[(schemaJson as { $ref: string }).$ref.replace('#/$defs/', '')]

function resolveRef(node: unknown): Node | undefined {
  if (!isPlainObject(node)) return undefined
  const ref = node.$ref
  if (typeof ref === 'string') return resolveRef(DEFS[ref.replace('#/$defs/', '')])
  return node
}

/** Every concrete node an `anyOf`/`oneOf`/`allOf` union may stand for. */
function branches(node: Node | undefined): Node[] {
  if (!node) return []
  const union = (node.anyOf ?? node.oneOf ?? node.allOf) as unknown[] | undefined
  if (Array.isArray(union)) return union.flatMap((b) => branches(resolveRef(b)))
  return [node]
}

/**
 * Whether the pinned 2.x schema has `path`: each segment must be a declared
 * property, a record key (`additionalProperties` schema), or an array index.
 * An open object (no `additionalProperties: false`) accepts any key below it.
 */
export function schemaHasPath(path: (string | number)[]): boolean {
  let nodes: Node[] = branches(ROOT)
  for (const seg of path) {
    const next: Node[] = []
    for (const node of nodes) {
      const props = isPlainObject(node.properties) ? node.properties : undefined
      if (props && String(seg) in props) next.push(...branches(resolveRef(props[String(seg)])))
      else if (typeof seg === 'number' && node.items !== undefined)
        next.push(...branches(resolveRef(node.items)))
      else if (isPlainObject(node.additionalProperties))
        next.push(...branches(resolveRef(node.additionalProperties)))
      else if (
        node.additionalProperties !== false &&
        (node.type === 'object' || props !== undefined) &&
        typeof seg === 'string'
      )
        next.push({}) // an open object: anything goes below
      else if (Object.keys(node).length === 0) next.push({}) // unconstrained (Json values)
    }
    if (next.length === 0) return false
    nodes = next
  }
  return true
}

let cachedValidator: ValidateFunction | null = null

/**
 * Prepare the generated schema for ajv: drop every `additionalProperties:
 * false` so a 1.x key already inside a 2.x object (2.x drops it with a
 * diagnostic; it is the user's) does not fail a write that never touches it.
 * Writing such a key is refused by `schemaHasPath` instead. Types, enums and
 * `required` on the touched keys are still enforced.
 */
function prepareSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prepareSchema)
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
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
  cachedValidator = ajv.compile(prepareSchema(schemaJson) as AnySchemaObject)
  return cachedValidator
}

/** Throw with ajv's error text when the touched keys of `config` violate the schema. */
function validateTouched(config: Record<string, unknown>, keys: Set<string>): void {
  const subset = Object.fromEntries(
    [...keys].filter((k) => config[k] !== undefined).map((k) => [k, config[k]])
  )
  const validate = getValidator()
  if (!validate(subset)) {
    const ajvText = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ')
    throw new Error(`opencode config would be invalid: ${ajvText || 'unknown validation error'}`)
  }
}

// ─── Write (leaf patches) ─────────────────────────────────────────────────────

/**
 * 2.x keys that 2.x also reads from a 1.x key of the same shape: a native value
 * beside the 1.x one REPLACES it whole (with a conflict warning), so before a
 * patch under the 2.x key the 1.x value moves there.
 */
const TOP_LEVEL_RENAMES: Record<string, string> = { media: 'attachment', snapshots: 'snapshot' }

function moveTopLevel(doc: JsoncDoc, legacy: string, native: string): void {
  if (!doc.has([legacy])) return
  if (!doc.has([native])) doc.set([native], doc.get([legacy]))
  doc.del([legacy])
}

/**
 * The 1.x `experimental.mcp_timeout` is BOTH 2.x MCP timeouts (`catalog` and
 * `execution`, `normalizeMcp`). Before a patch under `mcp.timeout` it moves
 * into whichever of the two is still unset, so editing one never drops the
 * other to its default (S8 review F5).
 */
function moveMcpTimeout(doc: JsoncDoc): void {
  const legacy = doc.get(['experimental', 'mcp_timeout'])
  if (legacy === undefined) return
  if (typeof legacy === 'number')
    for (const leaf of ['catalog', 'execution'])
      if (!doc.has(['mcp', 'timeout', leaf])) doc.set(['mcp', 'timeout', leaf], legacy)
  doc.del(['experimental', 'mcp_timeout'])
}

/**
 * Apply leaf patches to opencode's resolved config file via jsonc-parser,
 * byte-preserving comments and sibling keys.
 *
 * Guarantees:
 *  - Rejects any patch under RAW_PATCH_EXCLUDED_PATHS, and any SET of a path
 *    the 2.x schema does not have.
 *  - Moves a 1.x-only provider entry to `providers.<id>` before patching it.
 *  - Validates the RESULTING touched keys against the schema BEFORE writing;
 *    throws (with ajv text) on violation — nothing is written.
 *  - Delete patches are no-ops when the path is absent.
 *  - Byte-compare write gate: patches producing no textual change → no write.
 */
export function patchOpencodeNativeRaw(patches: RawConfigPatch[]): void {
  for (const patch of patches) {
    if (patch.path.length === 0) throw new Error('Refusing to apply a patch with an empty path')
    const excluded = excludedBy(patch.path)
    if (excluded)
      throw new Error(`Refusing to patch protected opencode config key "${excluded.join('.')}"`)
    const isDelete = !('value' in patch) || patch.value === undefined
    if (!isDelete && !schemaHasPath(patch.path))
      throw new Error(
        `Refusing to write "${patch.path.join('.')}": opencode 2.x has no such config key`
      )
  }

  const { path: filePath, existed } = resolveOpencodeConfigFile()
  const originalText = existed ? safeRead(filePath) : undefined
  const doc = new JsoncDoc(originalText ?? '{}')

  for (const patch of patches) {
    if (patch.path[0] === 'providers' && typeof patch.path[1] === 'string')
      moveProviderToNative(doc, patch.path[1])
    const legacy = TOP_LEVEL_RENAMES[String(patch.path[0])]
    if (legacy) moveTopLevel(doc, legacy, String(patch.path[0]))
    if (patch.path[0] === 'mcp' && patch.path[1] === 'timeout') moveMcpTimeout(doc)
  }

  for (const patch of patches) {
    const isDelete = !('value' in patch) || patch.value === undefined
    if (isDelete) doc.del(patch.path)
    else doc.set(patch.path, patch.value)
  }

  validateTouched(doc.value(), new Set(patches.map((p) => String(p.path[0]))))
  if (writeIfChanged(filePath, doc.text, originalText)) notifyOpencodeConfigWritten('raw config')
}

/** Test-only: drop the memoised ajv validator so a fresh schema can recompile. */
export function __resetValidatorForTests(): void {
  cachedValidator = null
}
