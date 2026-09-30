/**
 * `~/.claude/ui/harnesses.json`: which source each harness runs from (ADR-082 §2),
 * and whether harness updates install themselves (`updates`, §6).
 *
 * Main-owned. It is deliberately not a field of `engines/<id>.json`: that file
 * is replaced whole by `saveEngineConfig`, and renderer screens save their own
 * (possibly stale) snapshots of it, so a harness choice stored there could be
 * reverted by an unrelated settings save.
 *
 * Reads never throw: a missing, unreadable or malformed file reads as the
 * defaults. Saves are read-modify-write, so keys this version does not know
 * survive. This module does not invalidate the resolver; whoever saves (the
 * IPC handler) calls `invalidateHarness` afterwards.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  HarnessId,
  HarnessSelection,
  HarnessSourceChoice,
  HarnessUpdateMode,
  HarnessesConfig
} from '../../shared/harness-types'
import { isHarnessId } from '../../shared/harness-types'
import { readJsonFileForWrite, writeFileAtomicSync } from '../services/write-json-atomic'

/** An exact version usable as a directory name: plain semver, optional pre-release/build. */
export const HARNESS_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const SOURCES: ReadonlySet<string> = new Set<HarnessSourceChoice>(['bundled', 'managed', 'system'])

/** Resolved at call time so a redirected home (tests) is honoured. */
export function harnessesConfigPath(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'harnesses.json')
}

export function defaultSelection(id: HarnessId): HarnessSelection {
  return id === 'claude' ? { source: 'bundled' } : { source: 'managed', version: 'tested' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A well-formed selection, or null. Unknown sources and unsafe versions are dropped. */
function sanitizeSelection(value: unknown): HarnessSelection | null {
  if (!isRecord(value) || typeof value.source !== 'string' || !SOURCES.has(value.source)) {
    return null
  }
  const selection: HarnessSelection = { source: value.source as HarnessSourceChoice }
  const version = value.version
  if (
    typeof version === 'string' &&
    (version === 'latest' || version === 'tested' || HARNESS_VERSION_RE.test(version))
  ) {
    selection.version = version
  }
  return selection
}

function isUpdateMode(value: unknown): value is HarnessUpdateMode {
  return value === 'auto' || value === 'ask'
}

/** The file's selections and update mode, validated. Never throws. */
export function loadHarnessesConfig(file = harnessesConfigPath()): HarnessesConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const config: HarnessesConfig = isUpdateMode(parsed.updates) ? { updates: parsed.updates } : {}
  if (!isRecord(parsed.selections)) return config
  const selections: Partial<Record<HarnessId, HarnessSelection>> = {}
  for (const [id, value] of Object.entries(parsed.selections)) {
    if (!isHarnessId(id)) continue
    const selection = sanitizeSelection(value)
    if (selection) selections[id] = selection
  }
  return { ...config, selections }
}

/** The selection in effect for `id`: the saved one, else the default. */
export function harnessSelection(
  id: HarnessId,
  config: HarnessesConfig = loadHarnessesConfig()
): HarnessSelection {
  return config.selections?.[id] ?? defaultSelection(id)
}

/**
 * Install updates (ADR-082 §6): Automatically (`auto`) or Ask me (`ask`), the
 * default for a missing or unrecognised value.
 */
export function harnessUpdateMode(
  config: HarnessesConfig = loadHarnessesConfig()
): HarnessUpdateMode {
  return config.updates ?? 'ask'
}

/**
 * Merge `update.selections` into the file, per harness, and set `updates` when
 * given. Top-level keys and selections for harnesses this version does not
 * know are kept. Throws on an invalid value, and rather than overwrite a
 * present-but-unreadable file, which is backed up first.
 */
export function saveHarnessesConfig(update: HarnessesConfig, file = harnessesConfigPath()): void {
  if (update.updates !== undefined && !isUpdateMode(update.updates)) {
    throw new Error(`Invalid harness update mode: ${JSON.stringify(update.updates)}`)
  }
  const current = readJsonFileForWrite(file)
  const selections = isRecord(current.selections) ? { ...current.selections } : {}
  for (const [id, value] of Object.entries(update.selections ?? {})) {
    if (!isHarnessId(id)) continue
    const selection = sanitizeSelection(value)
    if (!selection) throw new Error(`Invalid harness selection for ${id}`)
    selections[id] = selection
  }
  const next: Record<string, unknown> = { ...current, selections }
  if (update.updates !== undefined) next.updates = update.updates
  writeFileAtomicSync(file, JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700
  })
}
