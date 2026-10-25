/**
 * Pure view logic of the worktree manager (ADR-112): what a row may do, what removing it loses,
 * and how a result reads. Kept out of the components so the rules are unit-tested without a DOM.
 */

import type {
  WorktreeHolder,
  WorktreeInspection,
  WorktreeInventoryEntry,
  WorktreeRemoveResult,
  WorktreeSize
} from '../../../shared/types'

/** An entry touched this recently is probably in use by a program outside ClaudeUI (C-S9). */
export const RECENT_MODIFICATION_MS = 10 * 60 * 1000

/** `undefined` = still loading, `null` = the query failed. */
export type Loaded<T> = T | null | undefined

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Entries with a directory to measure; a `missing` one has neither files nor a size, and an
 * `invalid` one is never walked (its path may lead through a link, N4).
 */
export function isMeasurable(entry: WorktreeInventoryEntry): boolean {
  return entry.kind !== 'missing' && !entry.invalidReason
}

/**
 * Entries worth inspecting: every one but an `invalid` entry, which cannot be removed so there is
 * nothing to report on. A missing worktree's branch (or detached HEAD) can still hold commits (R1).
 */
export function isInspectable(entry: WorktreeInventoryEntry): boolean {
  return !entry.invalidReason
}

export function recentMinutes(size: Loaded<WorktreeSize>, now: number): number | null {
  if (!size || size.newestMtimeMs <= 0) return null
  const age = now - size.newestMtimeMs
  if (age >= RECENT_MODIFICATION_MS) return null
  return Math.max(0, Math.floor(age / 60_000))
}

export function liveHolders(entry: WorktreeInventoryEntry): WorktreeHolder[] {
  return entry.holders.filter((h) => h.live)
}

export function coldHolders(entry: WorktreeInventoryEntry): WorktreeHolder[] {
  return entry.holders.filter((h) => !h.live)
}

/** Why a row cannot be selected on its own account (not counting its nested entries); null = selectable. */
export function blockReason(entry: WorktreeInventoryEntry): string | null {
  if (entry.invalidReason) return entry.invalidReason
  if (entry.locked) return entry.lockReason ? `locked: ${entry.lockReason}` : 'locked'
  const live = liveHolders(entry)
  if (live.length > 0) return `in use by ${live.map((h) => h.label).join(', ')}`
  return null
}

/**
 * The inner entries a selected row needs selected beside it: the server refuses an entry that
 * contains others unless they are removed in the same call.
 */
export function missingInner(
  entry: WorktreeInventoryEntry,
  byId: ReadonlyMap<string, WorktreeInventoryEntry>,
  selected: ReadonlySet<string>
): WorktreeInventoryEntry[] {
  return entry.contains
    .filter((id) => !selected.has(id))
    .map((id) => byId.get(id))
    .filter((e): e is WorktreeInventoryEntry => !!e)
}

/**
 * The selection that is actually valid: blocked rows drop out, and so do rows whose nested
 * entries are not (or no longer) selected with them. Runs to a fixpoint.
 */
export function effectiveSelection(
  selected: ReadonlySet<string>,
  byId: ReadonlyMap<string, WorktreeInventoryEntry>
): Set<string> {
  const out = new Set<string>()
  for (const id of selected) {
    const e = byId.get(id)
    if (e && !blockReason(e)) out.add(id)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const id of [...out]) {
      const e = byId.get(id)
      if (e && missingInner(e, byId, out).length > 0) {
        out.delete(id)
        changed = true
      }
    }
  }
  return out
}

/** The row's checkbox reason: its own block, else the nested entries still to select. */
export function disabledReason(
  entry: WorktreeInventoryEntry,
  byId: ReadonlyMap<string, WorktreeInventoryEntry>,
  selected: ReadonlySet<string>
): string | null {
  const own = blockReason(entry)
  if (own) return own
  const inner = missingInner(entry, byId, selected)
  // An inner entry that cannot be selected itself keeps this one from ever being removable.
  const stuck = inner.flatMap((e) => {
    const why = blockReason(e)
    return why ? [`${e.name}, which cannot be removed (${why})`] : []
  })
  if (stuck.length > 0) return `contains ${stuck.join('; ')}`
  if (inner.length > 0) {
    return `contains ${inner.map((e) => e.name).join(', ')}: select ${inner.length === 1 ? 'it' : 'them'} first`
  }
  return null
}

/** "Select safe" (R1, C-S9): nothing to lose, nobody using it, not touched in the last minutes. */
export function isSafe(
  entry: WorktreeInventoryEntry,
  inspection: Loaded<WorktreeInspection>,
  size: Loaded<WorktreeSize>,
  now: number
): boolean {
  if (blockReason(entry) || entry.contains.length > 0) return false
  // A missing entry has no files, but its branch or detached HEAD can hold commits (R1).
  if (!inspection) return false
  if (inspection.uncommittedFiles > 0 || inspection.uniqueCommits > 0) return false
  if (!isMeasurable(entry)) return true
  return !!size && recentMinutes(size, now) === null
}

export function statusText(
  entry: WorktreeInventoryEntry,
  inspection: Loaded<WorktreeInspection>
): string {
  if (entry.kind === 'missing') {
    // Not "gone": an unplugged drive or an offline share looks exactly like this.
    if (!inspection) return 'not found at its path'
    return inspection.uniqueCommits > 0
      ? `not found at its path · ${plural(inspection.uniqueCommits, 'commit')} only here`
      : 'not found at its path'
  }
  if (entry.invalidReason) return 'not checked'
  if (inspection === undefined) return 'checking…'
  if (inspection === null) return 'could not check'
  if (entry.kind === 'orphan') {
    return inspection.uncommittedFiles > 0
      ? `${plural(inspection.uncommittedFiles, 'file')} left inside`
      : 'empty shell'
  }
  const parts: string[] = []
  if (inspection.uncommittedFiles > 0) parts.push(`${inspection.uncommittedFiles} uncommitted`)
  if (inspection.uniqueCommits > 0) {
    parts.push(`${plural(inspection.uniqueCommits, 'commit')} only here`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'clean'
}

export function sizeText(entry: WorktreeInventoryEntry, size: Loaded<WorktreeSize>): string {
  if (!isMeasurable(entry)) return '—'
  if (size === undefined) return '…'
  if (size === null) return '?'
  return formatBytes(size.bytes)
}

export interface HolderChip {
  text: string
  live: boolean
}

export function holderChip(h: WorktreeHolder): HolderChip {
  if (h.kind === 'terminal') return { text: 'terminal', live: h.live }
  if (h.kind === 'x-agent') return { text: h.live ? h.label : `${h.label} (parked)`, live: h.live }
  return { text: h.live ? `live session: ${h.label}` : `session: ${h.label}`, live: h.live }
}

/** Total of the measured sizes; `atLeast` while some are still pending (or failed). */
export function totalSize(
  entries: readonly WorktreeInventoryEntry[],
  sizes: Readonly<Record<string, Loaded<WorktreeSize>>>
): { bytes: number; atLeast: boolean } {
  let bytes = 0
  let atLeast = false
  for (const e of entries) {
    if (!isMeasurable(e)) continue
    const s = sizes[e.id]
    if (s) bytes += s.bytes
    else atLeast = true
  }
  return { bytes, atLeast }
}

// ---------------------------------------------------------------------------
// The confirm: what each selected row loses
// ---------------------------------------------------------------------------

export interface ConfirmItem {
  id: string
  name: string
  /** One line per loss or warning. */
  lines: string[]
  /** Short samples under the line above (file names, commit subjects). */
  samples: string[]
  /** True when the row loses nothing and has nothing to warn about. */
  clean: boolean
}

const SAMPLE_SHOWN = 5

/** "…and N more" when the sample shows fewer entries than there are. */
function moreLine(total: number, sample: readonly unknown[]): string[] {
  const more = total - Math.min(SAMPLE_SHOWN, sample.length)
  return more > 0 ? [`…and ${more} more`] : []
}

/** What happens to the commits and the branch: shared by a worktree and a missing entry (R1). */
function commitLines(
  entry: WorktreeInventoryEntry,
  inspection: WorktreeInspection,
  lines: string[],
  samples: string[]
): void {
  if (inspection.uniqueCommits > 0) {
    const commits = plural(inspection.uniqueCommits, 'commit')
    lines.push(
      entry.branch
        ? `${commits} ${inspection.uniqueCommits === 1 ? 'exists' : 'exist'} only on branch ${entry.branch}: the branch is kept.`
        : `${commits} on a detached HEAD will be lost.`
    )
    for (const c of inspection.uniqueCommitSample.slice(0, SAMPLE_SHOWN)) {
      samples.push(`${c.sha.slice(0, 7)} ${c.subject}`)
    }
  } else if (entry.branch) {
    lines.push(`Branch ${entry.branch} is deleted: every commit on it exists elsewhere.`)
  }
}

export function confirmItem(
  entry: WorktreeInventoryEntry,
  inspection: Loaded<WorktreeInspection>,
  size: Loaded<WorktreeSize>,
  now: number
): ConfirmItem {
  const lines: string[] = []
  const samples: string[] = []

  if (entry.kind === 'missing') {
    lines.push(
      'Not found at its path (an unplugged drive or offline share looks the same); removing it only unregisters it, no files are touched.'
    )
    if (!inspection) {
      lines.push(
        inspection === null
          ? 'Could not check for commits only on this worktree.'
          : 'Not checked yet: commits only on this worktree are unknown.'
      )
    } else {
      commitLines(entry, inspection, lines, samples)
    }
  } else if (!inspection) {
    lines.push(
      inspection === null
        ? 'Could not check for uncommitted changes.'
        : 'Not checked yet: uncommitted changes are unknown.'
    )
  } else if (entry.kind === 'orphan') {
    if (inspection.uncommittedFiles > 0) {
      lines.push(
        `${plural(inspection.uncommittedFiles, 'file')} left in this folder will be deleted.`
      )
      samples.push(...inspection.uncommittedSample.slice(0, SAMPLE_SHOWN))
      samples.push(...moreLine(inspection.uncommittedFiles, inspection.uncommittedSample))
    }
  } else {
    if (inspection.uncommittedFiles > 0) {
      lines.push(
        `${plural(inspection.uncommittedFiles, 'uncommitted file')} will be lost (not recoverable).`
      )
      samples.push(...inspection.uncommittedSample.slice(0, SAMPLE_SHOWN))
      samples.push(...moreLine(inspection.uncommittedFiles, inspection.uncommittedSample))
    }
    commitLines(entry, inspection, lines, samples)
    if (inspection.ignoredEntries > 0) {
      lines.push(
        `${plural(inspection.ignoredEntries, 'ignored entry', 'ignored entries')} (build output, dependencies) will be deleted.`
      )
    }
  }

  if (isMeasurable(entry)) {
    const minutes = recentMinutes(size, now)
    if (minutes !== null) {
      lines.push(
        `Modified ${minutes < 1 ? 'less than a minute' : plural(minutes, 'minute')} ago: a program outside ClaudeUI may be using it.`
      )
    } else if (!size) {
      lines.push(
        size === null
          ? 'Could not measure it: recent changes by a program outside ClaudeUI are unknown.'
          : 'Not measured yet: recent changes by a program outside ClaudeUI are unknown.'
      )
    }
  }
  for (const h of coldHolders(entry)) {
    lines.push(
      h.kind === 'session'
        ? `Session "${h.label}" is closed and will lose its working folder.`
        : `${h.label} is parked and will lose its working folder.`
    )
  }

  return { id: entry.id, name: entry.name, lines, samples, clean: lines.length === 0 }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ResultView {
  tone: 'ok' | 'warn' | 'error'
  text: string
  /** Paths git or the walker could not delete (partial), up to 3. */
  paths: string[]
}

function refusalText(reason: string | undefined): string {
  const r = reason ?? 'refused'
  if (r === 'locked') return 'Refused: the worktree is locked.'
  if (r === 'not-found') return 'Refused: it no longer exists.'
  if (r.startsWith('in-use: ')) return `Refused: in use by ${r.slice('in-use: '.length)}.`
  if (r === 'invalid: reappeared') {
    return 'Refused: a folder reappeared at this path since the check. Refresh and retry.'
  }
  if (r.startsWith('invalid: ')) return `Refused: ${r.slice('invalid: '.length)}.`
  return `Refused: ${r}.`
}

export function describeResult(result: WorktreeRemoveResult): ResultView {
  switch (result.outcome) {
    case 'removed': {
      const b = result.branch
      if (!b) return { tone: 'ok', text: 'Removed.', paths: [] }
      if (b.action === 'deleted') {
        return { tone: 'ok', text: `Removed. Branch ${b.name} deleted.`, paths: [] }
      }
      const why =
        b.action === 'protected'
          ? (b.reason ?? 'protected')
          : b.reason
            ? b.reason
            : `${plural(b.uniqueCommits, 'commit')} only there`
      return {
        tone: 'ok',
        text: `Removed. Branch ${b.name} ${b.action === 'kept' ? 'kept' : 'not deleted'} (${why}).`,
        paths: []
      }
    }
    case 'refused':
      return { tone: 'warn', text: refusalText(result.reason), paths: [] }
    case 'partial': {
      const failures = result.failures ?? []
      const codes = new Set(failures.map((f) => f.code))
      if (codes.has('GIT_UNREGISTER')) {
        return {
          tone: 'warn',
          text: 'Files are gone but git still lists the worktree. Refresh and retry.',
          paths: []
        }
      }
      if (codes.has('REAPPEARED')) {
        return {
          tone: 'warn',
          text: 'A folder reappeared at this path while removing, so git was left alone. Refresh and retry.',
          paths: []
        }
      }
      if (failures.length > 0 && failures.every((f) => f.code === 'ECHANGED')) {
        return {
          tone: 'warn',
          text: 'The folder changed while removing, so the rest was left alone. Refresh and retry.',
          paths: failures.slice(0, 3).map((f) => f.path)
        }
      }
      const n = failures.length
      return {
        tone: 'warn',
        text: `${n >= 20 ? '20 or more paths' : plural(n, 'path')} could not be deleted. Close programs using it and retry.`,
        paths: failures.slice(0, 3).map((f) => `${f.path} (${f.code})`)
      }
    }
    case 'failed':
      return { tone: 'error', text: `Failed: ${result.reason ?? 'unknown error'}`, paths: [] }
  }
}
