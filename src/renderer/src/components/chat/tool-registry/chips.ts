/**
 * toolChips — the metadata strip in a ToolCard header.
 *
 * One engine-neutral rule: a chip states what the call PROVED, never what its
 * input said. The summary already carries the input (the command, the path, the
 * query); a chip carries the outcome — how many files a search matched, how many
 * lines an edit moved, whether a read was truncated, what a command exited with.
 * That is what makes a COLLAPSED card worth reading.
 *
 * Chips are opportunistic and honest (ADR-030): each one renders only when the
 * value is either computable from the view/result we already hold, or supplied
 * by an engine whose wire actually carries it. A field an engine does not report
 * renders NOTHING — never a placeholder, never a zero standing in for unknown.
 * Codex's `commandExecution` carries a real `exitCode`, Claude's Bash result does
 * not, so a Codex command card shows `exit 1` and a Claude one shows nothing;
 * duration is absent from every harness's tool_result today, so no card claims it.
 */

import type { ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../shared/types'
import { getLang } from '../../../lib/lang'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** `neutral` is the default grey; the rest borrow the card's status palette. */
export type ChipTone = 'neutral' | 'ok' | 'error' | 'accent' | 'warn'

export interface ToolChip {
  label: string
  tone: ChipTone
}

/** `getLang` answers 'plaintext' for anything it cannot place — not a chip. */
function languageChip(path: string | undefined): ToolChip | null {
  if (!path) return null
  const lang = getLang(path)
  return lang === 'plaintext' ? null : { label: lang, tone: 'accent' }
}

function countLines(text: string): number {
  if (!text) return 0
  // A trailing newline is a terminator, not an empty last line.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

/**
 * `+n −m` for an edit. Counted on the before/after pair the view carries, so an
 * engine that supplies per-file diffs instead (opencode `apply_patch`, Codex
 * `fileChange`) sums those hunks' own +/- lines rather than a pair it never had.
 */
function editDeltaChip(view: Extract<ToolView, { kind: 'fileEdit' }>): ToolChip | null {
  if (view.files?.length) {
    let added = 0
    let removed = 0
    for (const file of view.files) {
      // `additions`/`deletions` are the engine's own count when it supplies one
      // (opencode does); otherwise the hunk lines are counted, skipping the
      // `+++`/`---` file headers that are not content.
      if (file.additions !== undefined || file.deletions !== undefined) {
        added += file.additions ?? 0
        removed += file.deletions ?? 0
        continue
      }
      for (const line of (file.patch ?? '').split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++
        else if (line.startsWith('-') && !line.startsWith('---')) removed++
      }
    }
    if (added === 0 && removed === 0) return null
    return { label: `+${added} −${removed}`, tone: 'ok' }
  }
  // An empty before with a non-empty after is an insertion, and vice versa; a
  // pair that is empty on both sides carries no delta to state.
  if (!view.before && !view.after) return null
  const added = view.after ? countLines(view.after) : 0
  const removed = view.before ? countLines(view.before) : 0
  return { label: `+${added} −${removed}`, tone: 'ok' }
}

/**
 * Claude's Grep answers one of three shapes depending on `output_mode`, and its
 * Glob answers a bare path list. Each is counted structurally rather than parsed:
 * a leading "Found N files" header wins, otherwise non-empty lines are the unit.
 */
export function searchResultChips(text: string | undefined): ToolChip[] {
  if (!text) return []
  const header = text.match(/^Found (\d+) (files?|matches?|lines?)/i)
  if (header) {
    const noun = header[2].toLowerCase().replace(/s$/, '')
    return [{ label: `${header[1]} ${noun}${header[1] === '1' ? '' : 's'}`, tone: 'neutral' }]
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return [{ label: 'no matches', tone: 'neutral' }]
  // `path:line:content` is content mode — count distinct files AND hits. A bare
  // list (files_with_matches, Glob) has one file per line and no hit count.
  const withLocation = lines.filter((l) => /^[^\s:]+:\d+:/.test(l))
  if (withLocation.length >= Math.max(2, lines.length * 0.6)) {
    const files = new Set(withLocation.map((l) => l.slice(0, l.indexOf(':'))))
    return [
      { label: `${files.size} file${files.size === 1 ? '' : 's'}`, tone: 'neutral' },
      {
        label: `${withLocation.length} hit${withLocation.length === 1 ? '' : 's'}`,
        tone: 'neutral'
      }
    ]
  }
  return [{ label: `${lines.length} file${lines.length === 1 ? '' : 's'}`, tone: 'neutral' }]
}

/**
 * The header's metadata strip for one call.
 *
 * `result` is undefined while the call is in flight, so every result-derived chip
 * is absent until it lands — a running card shows only what its input settles
 * (the language of the path it is writing, say).
 */
export function toolChips(kind: ToolKind, view: ToolView, result?: ToolResultBlock): ToolChip[] {
  const chips: ToolChip[] = []
  const errored = !!result?.isError

  switch (kind) {
    case 'command': {
      if (view.kind !== 'command') break
      // Only an engine that reports an exit code gets the chip (Codex today).
      // `0` is a real value and must survive the guard, so test for undefined.
      if (view.exitCode !== undefined) {
        chips.push({
          label: `exit ${view.exitCode}`,
          tone: view.exitCode === 0 ? 'ok' : 'error'
        })
      }
      break
    }

    case 'fileEdit': {
      if (view.kind !== 'fileEdit') break
      if (!errored) {
        const delta = editDeltaChip(view)
        if (delta) chips.push(delta)
      }
      const lang = languageChip(view.path || view.files?.[0]?.path)
      if (lang) chips.push(lang)
      break
    }

    case 'fileWrite': {
      if (view.kind !== 'fileWrite') break
      if (!errored && view.content) {
        const lines = countLines(view.content)
        chips.push({ label: `${lines} line${lines === 1 ? '' : 's'}`, tone: 'neutral' })
      }
      const lang = languageChip(view.path)
      if (lang) chips.push(lang)
      break
    }

    case 'fileRead': {
      if (view.kind !== 'fileRead') break
      if (!errored && view.truncated) chips.push({ label: 'truncated', tone: 'warn' })
      const lang = languageChip(view.path)
      if (lang) chips.push(lang)
      break
    }

    case 'search': {
      if (errored) break
      chips.push(...searchResultChips(result?.toolResult))
      break
    }

    case 'web': {
      if (view.kind !== 'web') break
      if (!errored && view.results?.length) {
        const n = view.results.length
        chips.push({ label: `${n} result${n === 1 ? '' : 's'}`, tone: 'neutral' })
      }
      break
    }

    case 'mcp': {
      if (view.kind !== 'mcp') break
      if (view.readOnly) chips.push({ label: 'read-only', tone: 'accent' })
      break
    }

    default:
      break
  }

  return chips
}
