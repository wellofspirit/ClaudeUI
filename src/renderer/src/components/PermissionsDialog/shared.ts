import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DirEntry, PermissionScope } from '../../../../shared/types'

export type RuleCategory = 'allow' | 'deny' | 'ask'

export const SCOPE_LABELS: Record<PermissionScope, string> = {
  local: 'Local',
  project: 'Project',
  user: 'Global'
}

export const SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  local: '.claude/settings.local.json (gitignored)',
  project: '.claude/settings.json (committed)',
  user: '~/.claude/settings.json (user-wide)'
}

// Common rule templates for the add helper
export const RULE_TEMPLATES = [
  { label: 'Bash command', template: 'Bash(command:*)' },
  { label: 'Edit files', template: 'Edit' },
  { label: 'Edit in path', template: 'Edit(src/**)' },
  { label: 'Read files', template: 'Read' },
  { label: 'Write files', template: 'Write' },
  { label: 'Glob', template: 'Glob' },
  { label: 'WebFetch domain', template: 'WebFetch(domain:example.com)' },
  { label: 'WebSearch', template: 'WebSearch' },
  { label: 'MCP server', template: 'mcp__server__*' },
  { label: 'Agent (subagent)', template: 'Agent' }
]

export type ListDirFn = (path: string) => Promise<{ entries: DirEntry[]; isRoot: boolean }>

export interface DirSuggestions {
  /** Directory entries for the current input, `..` prepended (non-root only). */
  entries: DirEntry[]
  /** The portion of the input before the last separator (the listed directory). */
  dirPortion: string
  /** New input value for descending into `entry` (desktop Tab / mobile row tap). */
  navigate: (entry: DirEntry) => string
  /** Absolute path to commit for `entry` (desktop Enter / mobile ✓). '' = nothing to add. */
  confirmPath: (entry: DirEntry) => string
}

/**
 * Directory autocomplete for an absolute-path input, shared by the desktop
 * `AddRuleInput` and the mobile entry sheet.
 *
 * The two surfaces differ only in how a suggestion is *actuated* (keyboard
 * Tab/Enter vs. row tap / ✓ button), so the hook keeps the fetch + filter and
 * returns the resulting strings rather than owning the input state itself.
 */
export function useDirSuggestions(
  value: string,
  onListDir: ListDirFn,
  enabled: boolean
): DirSuggestions {
  const { dirPortion, query } = useMemo(() => {
    if (!enabled || !value) return { dirPortion: '', query: '' }
    const normalized = value.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash < 0) return { dirPortion: '', query: normalized }
    return {
      dirPortion: value.slice(0, lastSlash) || '/',
      query: value.slice(lastSlash + 1)
    }
  }, [enabled, value])

  const isAbsolutePath = /^(\/|[A-Za-z]:)/.test(value)

  const [dirEntries, setDirEntries] = useState<DirEntry[]>([])
  const [dirIsRoot, setDirIsRoot] = useState(false)

  useEffect(() => {
    if (!enabled || !isAbsolutePath || !dirPortion) {
      setDirEntries([])
      setDirIsRoot(false)
      return
    }
    const listPath = /^[A-Za-z]:$/.test(dirPortion) ? dirPortion + '\\' : dirPortion
    let cancelled = false
    onListDir(listPath)
      .then(({ entries, isRoot }) => {
        if (cancelled) return
        setDirEntries(entries.filter((e) => e.isDirectory))
        setDirIsRoot(isRoot)
      })
      .catch(() => {
        if (cancelled) return
        setDirEntries([])
        setDirIsRoot(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, dirPortion, isAbsolutePath, onListDir])

  const entries = useMemo(() => {
    if (!enabled || !isAbsolutePath || dirEntries.length === 0) return []
    const items: DirEntry[] = dirIsRoot
      ? dirEntries
      : [{ name: '..', isDirectory: true }, ...dirEntries]
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((e) => e.name.toLowerCase().includes(q))
  }, [enabled, isAbsolutePath, dirEntries, dirIsRoot, query])

  const navigate = useCallback(
    (entry: DirEntry): string => {
      const sep = value.includes('\\') ? '\\' : '/'
      let newValue: string
      if (entry.name === '..') {
        const normalized = dirPortion.replace(/\\/g, '/')
        const lastSlash = normalized.lastIndexOf('/')
        const parent =
          lastSlash > 0 ? dirPortion.slice(0, lastSlash) : dirPortion.slice(0, lastSlash + 1)
        newValue = parent + sep
      } else {
        newValue = dirPortion + sep + entry.name + sep
      }
      return newValue.replace(/[/\\]{2,}/g, sep)
    },
    [value, dirPortion]
  )

  const confirmPath = useCallback(
    (entry: DirEntry): string => {
      if (entry.name === '..') return dirPortion.replace(/[/\\]+$/, '')
      const sep = value.includes('\\') ? '\\' : '/'
      return (dirPortion + sep + entry.name).replace(/[/\\]{2,}/g, sep)
    },
    [value, dirPortion]
  )

  return { entries, dirPortion, navigate, confirmPath }
}
