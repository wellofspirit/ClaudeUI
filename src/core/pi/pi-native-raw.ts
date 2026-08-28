/**
 * pi-native-raw.ts
 *
 * Non-lossy reader / leaf-patcher for pi's OWN global settings file,
 * `~/.pi/agent/settings.json` (vendor/pi-cli/docs/settings.md — "Global (all
 * projects)"). The curated pi Configuration panes hand us literal pi field names
 * (`theme`, `defaultThinkingLevel`, `compaction.reserveTokens`, …) and we patch
 * exactly those leaves through jsonc-parser modify()+applyEdits, byte-preserving
 * every sibling key and every untouched byte of the file.
 *
 * **GLOBAL SCOPE ONLY, and no env override.** pi also reads a project-local
 * `.pi/settings.json` that overrides the global one; ClaudeUI does not edit it.
 * The path is `os.homedir()`-derived with no PI_* escape hatch on purpose:
 * ClaudeUI spawns pi with no directory overrides, so the homedir file is the one
 * our own sessions actually read.
 *
 * Deliberately UNLIKE the opencode twin (opencode-native-raw.ts) in two ways:
 *  - **No excluded top-level keys.** opencode's RAW_PATCH_EXCLUDED_TOP_LEVEL
 *    exists because an ADR-031 projection writer owns those keys and a raw write
 *    would fight it. pi has no projection writer — nothing else in ClaudeUI
 *    writes settings.json — so every key here is the panes' to own.
 *  - **No ajv pass.** pi publishes no JSON schema for settings.json, so there is
 *    nothing to validate a result against; the panes constrain what they offer,
 *    and pi's own loader stays the authority.
 *
 * Shared with that twin: the EOL / safe-read / safe-parse / byte-compare
 * write-gate discipline (opencode-jsonc-io) and the delete-safety INVARIANT —
 * jsonc-parser modify() THROWS when deleting under a missing parent, so a delete
 * patch is a no-op unless its path exists in the parsed doc.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { modify, applyEdits } from 'jsonc-parser'
import type { FormattingOptions } from 'jsonc-parser'
import { detectEol, safeRead, jsoncParseSafe, writeIfChanged } from '../opencode/opencode-jsonc-io'
// Generic predicate that happens to live in an opencode-named module (its
// `diffToPatches` sibling is what the panes use to build patches).
import { isPlainObject } from '../../shared/opencode-config-diff'
import { piAgentDir } from '../services/pi-session-list'
import type { PiNativeRaw, RawConfigPatch } from '../../shared/types'

/** `~/.pi/agent/settings.json` — pi's global settings file. */
export function piSettingsFile(): string {
  return join(piAgentDir(), 'settings.json')
}

/**
 * UTF-8 BOM. pi's own loader tolerates one, so a hand-edited (or PowerShell
 * `Out-File`-written) settings.json may carry it — but jsonc-parser does not,
 * and would report the whole document as malformed. We strip it before parsing
 * and put it back on write rather than silently changing the file's encoding.
 */
const BOM = '\uFEFF'

function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: '', body: text }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read pi's global settings file as its RAW parsed object (no projection) AND as
 * its raw text. Returns `{}` / `''` when the file is absent / unreadable /
 * unparseable, and NEVER creates it. `path` is the resolved write target (the UI
 * shows it).
 *
 * `text` is the BOM-stripped file content: it is what the Raw config pane edits,
 * so an unparseable file still round-trips through the editor (its `config` is
 * `{}`, but its bytes are all there to be fixed by hand).
 */
export function readPiNativeRaw(): PiNativeRaw {
  const filePath = piSettingsFile()
  const text = safeRead(filePath)
  if (text === undefined) return { config: {}, path: filePath, text: '' }
  const body = splitBom(text).body
  const parsed = jsoncParseSafe(body)
  return { config: isPlainObject(parsed) ? parsed : {}, path: filePath, text: body }
}

// ─── Write (leaf patches) ─────────────────────────────────────────────────────

/**
 * Path segments a patch may never traverse. `path` reaches this module from the
 * renderer over IPC, and the walk below indexes plain objects by segment, so a
 * `__proto__` hop would let a caller reach Object.prototype. (The opencode twin
 * has no such guard — its excluded-top-level set happens to be checked first for
 * every patch, but the segment itself is unguarded. Hardening added here rather
 * than retrofitted there; see the kickoff report.)
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Throw unless `path` is a non-empty array of safe string/number segments. */
function assertPatchPath(path: (string | number)[]): void {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('Refusing to apply a pi settings patch with an empty path')
  }
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]
    if (typeof seg !== 'string' && typeof seg !== 'number') {
      throw new Error(
        `Refusing to apply a pi settings patch: path segment ${i} is not a string or number`
      )
    }
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`Refusing to apply a pi settings patch through prototype segment "${seg}"`)
    }
  }
}

/**
 * Whether `path` resolves to an existing leaf/branch in `obj`.
 *
 * A private twin of the same walk in opencode-native-raw.ts. Kept local rather
 * than hoisted into opencode-jsonc-io so this work item leaves opencode's
 * shipped writer byte-for-byte untouched; folding the two together is a clean
 * follow-up if that file ever grows a third caller.
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
 * Apply leaf patches to pi's global settings file via jsonc-parser
 * modify()+applyEdits, byte-preserving sibling keys and the formatting of every
 * untouched region.
 *
 * Guarantees:
 *  - A patch set that changes no bytes creates nothing and writes nothing —
 *    including the empty array, and including a delete-only set whose paths are
 *    all absent. (A `{}` seed plus an unconditional write would leave a stray
 *    settings.json behind on a file pi has never written.)
 *  - Every patch path is validated first (non-empty, string/number segments, no
 *    prototype hops); one bad patch rejects the whole set, before any write.
 *  - `value` absent or `undefined` DELETES the leaf (absent-means-default is how
 *    pi reads settings.json), and a delete whose path is not in the current doc
 *    is a NO-OP — the modify() delete-under-missing-parent INVARIANT. Deleting
 *    the last child leaves the now-empty parent object alone: whether an empty
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
export function patchPiNativeRaw(patches: RawConfigPatch[]): void {
  if (patches.length === 0) return
  for (const patch of patches) assertPatchPath(patch.path)

  const filePath = piSettingsFile()
  const originalText = safeRead(filePath)
  if (originalText === undefined && existsSync(filePath)) {
    // Present but unreadable (permissions, an AV lock). Seeding from `{}` here
    // would overwrite the user's real settings with a one-key file.
    throw new Error(`Refusing to overwrite unreadable pi settings file: ${filePath}`)
  }

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
  if (text === body) return

  // Only a file we are creating gets a trailing newline imposed; an existing one
  // keeps whatever it had, since modify() only edits inside the braces.
  if (!existed && !text.endsWith(eol)) text += eol

  writeIfChanged(filePath, bom + text, originalText)
}

// ─── Write (whole file) ───────────────────────────────────────────────────────

/**
 * Replace pi's global settings file with `text` VERBATIM — the Raw config pane's
 * writer. pi publishes no schema for settings.json, so the pane is a plain text
 * editor and this is a plain text write: no reserialisation, no formatting, no
 * merging of the keys the curated panes own.
 *
 * Two things it does NOT take verbatim:
 *  - **Validity.** `JSON.parse` must accept the text and its top level must be a
 *    JSON object, or nothing is written. The renderer checks the same two things
 *    to disable its Save button; this is the defence-in-depth half, because the
 *    renderer is not the only possible caller of the IPC channel. The parser is
 *    strict JSON — NOT jsonc — on purpose: pi's own loader is, so a `//` comment
 *    that {@link patchPiNativeRaw} would happily preserve is still a file pi
 *    cannot read, and refusing to save it is the honest answer.
 *  - **The BOM.** A file that had one keeps it (and one pasted into the editor is
 *    dropped rather than doubled), matching the leaf patcher: a BOM is an
 *    encoding marker, and silently changing a file's encoding is not something
 *    "save the text I typed" should mean.
 *
 * Byte-compare write gate, like every other writer here: text identical to what
 * is on disk performs no write at all.
 */
export function writePiNativeRawText(text: string): void {
  const body = splitBom(text).body

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new Error(
      `Refusing to write invalid JSON to pi settings: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Refusing to write pi settings whose top level is not a JSON object')
  }

  const filePath = piSettingsFile()
  const originalText = safeRead(filePath)
  if (originalText === undefined && existsSync(filePath)) {
    // Present but unreadable — the same guard as patchPiNativeRaw: we cannot
    // know what we would be destroying, so we destroy nothing.
    throw new Error(`Refusing to overwrite unreadable pi settings file: ${filePath}`)
  }

  const bom = originalText === undefined ? '' : splitBom(originalText).bom
  writeIfChanged(filePath, bom + body, originalText)
}
