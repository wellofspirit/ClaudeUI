/**
 * pi-json-raw.ts
 *
 * The file-generic half of pi's raw JSON editors — everything `pi-native-raw.ts`
 * (`~/.pi/agent/settings.json`) and `pi-models-raw.ts` (`~/.pi/agent/models.json`)
 * do IDENTICALLY, parameterized by path.
 *
 * It exists because the second file arrived: settings.json's reader/patcher was
 * written first and its BOM handling, path validation, delete-safety invariant,
 * creation seed and byte-compare write gate are not settings-specific in any
 * way — they are "edit a pi JSON file without disturbing a byte we were not
 * asked to change". Duplicating that for models.json would have produced two
 * copies of the delete invariant and two prototype-hop guards to keep in step.
 *
 * What stays in the callers: WHICH file, what the panes may write to it, and any
 * ownership rules over its contents (models.json has a projection writer —
 * `shared-providers/PiSharedProviderAdapter.ts` — and this module knows nothing
 * about that; `patchPiJsonRaw` takes a `guard` callback instead).
 *
 * Shared with the opencode twin (opencode-native-raw.ts): the EOL / safe-read /
 * safe-parse / byte-compare write-gate discipline (opencode-jsonc-io) and the
 * delete-safety INVARIANT — jsonc-parser modify() THROWS when deleting under a
 * missing parent, so a delete patch is a no-op unless its path exists in the
 * parsed doc.
 */

import { existsSync } from 'node:fs'
import { modify, applyEdits } from 'jsonc-parser'
import type { FormattingOptions } from 'jsonc-parser'
import { detectEol, safeRead, jsoncParseSafe, writeIfChanged } from '../opencode/opencode-jsonc-io'
// Generic predicate that happens to live in an opencode-named module (its
// `diffToPatches` sibling is what the panes use to build patches).
import { isPlainObject } from '../../shared/opencode-config-diff'
import type { RawConfigPatch } from '../../shared/types'

/**
 * UTF-8 BOM. pi's own loader tolerates one, so a hand-edited (or PowerShell
 * `Out-File`-written) file may carry it — but jsonc-parser does not, and would
 * report the whole document as malformed. We strip it before parsing and put it
 * back on write rather than silently changing the file's encoding.
 */
const BOM = '\uFEFF'

export function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/** A raw read: the parsed object (never a projection), the path, and the bytes. */
export interface PiJsonRawRead {
  config: Record<string, unknown>
  path: string
  text: string
}

/**
 * Read a pi JSON file as its RAW parsed object AND as its raw text. Returns
 * `{}` / `''` when the file is absent / unreadable / unparseable, and NEVER
 * creates it. `path` is echoed back as the resolved write target (the UI shows
 * it).
 *
 * `text` is the BOM-stripped file content: it is what a raw text editor pane
 * edits, so an unparseable file still round-trips (its `config` is `{}`, but its
 * bytes are all there to be fixed by hand).
 */
export function readPiJsonRaw(filePath: string): PiJsonRawRead {
  const text = safeRead(filePath)
  if (text === undefined) return { config: {}, path: filePath, text: '' }
  const body = splitBom(text).body
  const parsed = jsoncParseSafe(body)
  return { config: isPlainObject(parsed) ? parsed : {}, path: filePath, text: body }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Path segments a patch may never traverse. `path` reaches these modules from
 * the renderer over IPC, and the walk below indexes plain objects by segment, so
 * a `__proto__` hop would let a caller reach Object.prototype. (The opencode
 * twin has no such guard — its excluded-top-level set happens to be checked
 * first for every patch, but the segment itself is unguarded. Hardening added on
 * the pi side rather than retrofitted there.)
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Throw unless `path` is a non-empty array of safe string/number segments.
 * `label` names the file in the refusal ("pi settings" → "Refusing to apply a pi
 * settings patch …"), so a message still says which file was being edited.
 */
export function assertPatchPath(path: (string | number)[], label: string): void {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error(`Refusing to apply a ${label} patch with an empty path`)
  }
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]
    if (typeof seg !== 'string' && typeof seg !== 'number') {
      throw new Error(
        `Refusing to apply a ${label} patch: path segment ${i} is not a string or number`
      )
    }
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`Refusing to apply a ${label} patch through prototype segment "${seg}"`)
    }
  }
}

/**
 * Whether `path` resolves to an existing leaf/branch in `obj`.
 *
 * A private twin of the same walk in opencode-native-raw.ts. Kept on the pi side
 * rather than hoisted into opencode-jsonc-io so this leaves opencode's shipped
 * writer byte-for-byte untouched; folding the two together is a clean follow-up
 * if that file ever grows a third caller.
 */
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
 * Read a file we are about to overwrite, refusing when it is PRESENT but
 * unreadable (permissions, an AV lock, a directory in its place). `undefined`
 * means genuinely absent — the caller may seed a new file. Seeding over a file
 * we simply could not read would overwrite the user's real config with a
 * one-key document.
 */
export function readBeforeOverwrite(filePath: string, label: string): string | undefined {
  const originalText = safeRead(filePath)
  if (originalText === undefined && existsSync(filePath)) {
    throw new Error(`Refusing to overwrite unreadable ${label} file: ${filePath}`)
  }
  return originalText
}

export interface PiJsonPatchRequest {
  /** The file to patch. */
  filePath: string
  /** Names the file in refusal messages — "pi settings", "pi models". */
  label: string
  patches: RawConfigPatch[]
  /**
   * Caller-specific admissibility check over the whole set, run after path
   * validation and BEFORE the file is read or written — an ownership rule
   * (models.json's shared-provider projection) rejects the call, never half of
   * it. Taking the whole array rather than one patch lets a guard derive its
   * state once per call instead of once per patch.
   */
  guard?: (patches: RawConfigPatch[]) => void
}

/**
 * Apply leaf patches to a pi JSON file via jsonc-parser modify()+applyEdits,
 * byte-preserving sibling keys and the formatting of every untouched region.
 * Returns whether anything was actually written.
 *
 * Guarantees:
 *  - A patch set that changes no bytes creates nothing and writes nothing —
 *    including the empty array, and including a delete-only set whose paths are
 *    all absent. (A `{}` seed plus an unconditional write would leave a stray
 *    file behind on one pi has never written.)
 *  - Every patch path is validated first (non-empty, string/number segments, no
 *    prototype hops), then the caller's `guard` sees the whole set; one bad
 *    patch rejects the whole set, before any write.
 *  - `value` absent or `undefined` DELETES the leaf (absent-means-default is how
 *    pi reads its config), and a delete whose path is not in the current doc is
 *    a NO-OP — the modify() delete-under-missing-parent INVARIANT. Deleting the
 *    last child leaves the now-empty parent object alone: whether an empty
 *    branch should collapse is the panes' decision, not the writer's.
 *    (`pathExists` is checked against the doc as PARSED, matching the opencode
 *    twin: a delete of a path an EARLIER patch in the same call created would be
 *    skipped. The panes build patch sets from an old→new diff, which never emits
 *    both for one path.)
 *  - The file's existing EOL and BOM survive; a file created here is seeded from
 *    `{}` with 2-space indent, `\n` EOL and a trailing newline.
 *  - Byte-compare write gate: a patch set producing no textual change performs
 *    no write at all (no mtime churn).
 */
export function patchPiJsonRaw({ filePath, label, patches, guard }: PiJsonPatchRequest): boolean {
  if (patches.length === 0) return false
  for (const patch of patches) assertPatchPath(patch.path, label)
  guard?.(patches)

  const originalText = readBeforeOverwrite(filePath, label)
  const existed = originalText !== undefined
  const { bom, body } = splitBom(originalText ?? '{}')
  const parsed = (jsoncParseSafe(body) ?? {}) as Record<string, unknown>

  const eol = detectEol(body)
  const fmt: FormattingOptions = { insertSpaces: true, tabSize: 2, eol }
  let text = body
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

  // Nothing changed textually → no write at all. This is what stops a
  // delete-only patch set whose paths were all absent from CREATING the file
  // with a bare `{}` seed; for an existing file the byte gate below would catch
  // it anyway, but for an absent one there is no `originalText` to compare to.
  if (text === body) return false

  // Only a file we are creating gets a trailing newline imposed; an existing one
  // keeps whatever it had, since modify() only edits inside the braces.
  if (!existed && !text.endsWith(eol)) text += eol

  return writeIfChanged(filePath, bom + text, originalText)
}
