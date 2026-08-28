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
 * The mechanics — BOM handling, path validation, the delete invariant, the
 * creation seed, the byte-compare write gate — live in `pi-json-raw.ts`, shared
 * verbatim with the models.json editor (`pi-models-raw.ts`). What stays here is
 * everything settings-specific: which file, and the whole-file text write the
 * Raw config pane needs (models.json has no such pane).
 *
 * Deliberately UNLIKE the opencode twin (opencode-native-raw.ts) in two ways:
 *  - **No excluded top-level keys.** opencode's RAW_PATCH_EXCLUDED_TOP_LEVEL
 *    exists because an ADR-031 projection writer owns those keys and a raw write
 *    would fight it. NOTHING projects into settings.json — so every key here is
 *    the panes' to own, and `patchPiNativeRaw` passes no ownership guard. (Its
 *    models.json sibling does: `PiSharedProviderAdapter` owns provider entries
 *    there, which is exactly the situation this file does not have.)
 *  - **No ajv pass.** pi publishes no JSON schema for settings.json, so there is
 *    nothing to validate a result against; the panes constrain what they offer,
 *    and pi's own loader stays the authority.
 */

import { join } from 'node:path'
import { isPlainObject } from '../../shared/opencode-config-diff'
import { piAgentDir } from '../services/pi-session-list'
import { patchPiJsonRaw, readBeforeOverwrite, readPiJsonRaw, splitBom } from './pi-json-raw'
import { writeIfChanged } from '../opencode/opencode-jsonc-io'
import type { PiNativeRaw, RawConfigPatch } from '../../shared/types'

/** `~/.pi/agent/settings.json` — pi's global settings file. */
export function piSettingsFile(): string {
  return join(piAgentDir(), 'settings.json')
}

/** Names settings.json in every refusal this module can raise. */
const LABEL = 'pi settings'

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
  return readPiJsonRaw(piSettingsFile())
}

// ─── Write (leaf patches) ─────────────────────────────────────────────────────

/**
 * Apply leaf patches to pi's global settings file — see {@link patchPiJsonRaw}
 * for the guarantees (validation, delete invariant, BOM/EOL preservation,
 * create-nothing-on-a-no-op, byte-compare write gate).
 */
export function patchPiNativeRaw(patches: RawConfigPatch[]): void {
  patchPiJsonRaw({ filePath: piSettingsFile(), label: LABEL, patches })
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
  // Present but unreadable — the same guard as patchPiNativeRaw: we cannot know
  // what we would be destroying, so we destroy nothing.
  const originalText = readBeforeOverwrite(filePath, LABEL)

  const bom = originalText === undefined ? '' : splitBom(originalText).bom
  writeIfChanged(filePath, bom + body, originalText)
}
