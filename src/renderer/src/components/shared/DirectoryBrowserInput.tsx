import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry } from '../../../../shared/types'

/**
 * Inline directory browser for surfaces that cannot open a native folder
 * dialog — i.e. the remote web client, where `pickFolder()` resolves to null.
 *
 * Dumb/presentational on purpose: the directory listing arrives through the
 * `listDir` prop (normally `window.api.listDir`, which the remote dispatcher
 * forwards to the host's `file:list-dir`), so the component never touches
 * `window.api` or a store and stays renderable in jsdom.
 *
 * The path mechanics mirror the dir-autocomplete inside PermissionsDialog's
 * AddRuleInput (same absolute-path detection, Windows drive-root handling and
 * synthesized `..`); that copy is left untouched here to contain churn.
 */

export interface DirectoryBrowserInputProps {
  /** Receives the HOST-resolved absolute path, only after it lists successfully. */
  onConfirm: (path: string) => void
  onCancel: () => void
  listDir: (
    dirPath: string
  ) => Promise<{ entries: DirEntry[]; isRoot: boolean; resolvedPath?: string }>
  placeholder?: string
  autoFocus?: boolean
}

const ABSOLUTE_PATH_RE = /^(\/|[A-Za-z]:)/
/** A bare drive letter: `readdir('D:')` is CWD-relative on Windows, `D:\` is the root. */
const DRIVE_ONLY_RE = /^[A-Za-z]:$/

/** Split `D:/work/cla` into the directory to list (`D:/work`) and the filter (`cla`). */
function splitPath(value: string): { dirPortion: string; query: string } {
  const normalized = value.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash < 0) return { dirPortion: '', query: normalized }
  return { dirPortion: value.slice(0, lastSlash) || '/', query: value.slice(lastSlash + 1) }
}

function toListPath(dirPortion: string): string {
  return DRIVE_ONLY_RE.test(dirPortion) ? dirPortion + '\\' : dirPortion
}

/** What Enter confirms: the typed value without a trailing separator. */
function toConfirmPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const stripped = trimmed.replace(/[/\\]+$/, '')
  if (!stripped) return '/'
  return DRIVE_ONLY_RE.test(stripped) ? stripped + '/' : stripped
}

/** `listDirEntries` strips the trailing slash, turning `D:/` into a drive-relative `D:`. */
function normalizeResolved(resolved: string): string {
  return DRIVE_ONLY_RE.test(resolved) ? resolved + '/' : resolved
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
    >
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  )
}

export function DirectoryBrowserInput({
  onConfirm,
  onCancel,
  listDir,
  placeholder,
  autoFocus
}: DirectoryBrowserInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([])
  const [dirIsRoot, setDirIsRoot] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { dirPortion, query } = useMemo(() => splitPath(value), [value])
  const isAbsolutePath = ABSOLUTE_PATH_RE.test(value)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  /**
   * Open on somewhere real. The listing effect below only fires for an absolute
   * path, so an untouched input showed an empty box until the user typed a drive
   * or a slash. `listDir('')` is the host's home directory; an empty
   * `resolvedPath` means it could not answer, and the input just stays blank.
   *
   * The write is conditional on the input still being empty rather than gated by
   * a ran-once ref: that keeps a seed typed over mid-flight, and keeps this
   * correct under StrictMode's mount/unmount/remount, where a ref-gated second
   * pass would bail while the first pass's result was already discarded.
   */
  useEffect(() => {
    let stale = false
    listDir('')
      .then(({ resolvedPath }) => {
        if (stale || !resolvedPath) return
        const home = normalizeResolved(resolvedPath)
        setValue((current) => current || (home.endsWith('/') ? home : home + '/'))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [listDir])

  useEffect(() => {
    if (!isAbsolutePath || !dirPortion) {
      setDirEntries([])
      setDirIsRoot(false)
      return
    }
    let stale = false
    listDir(toListPath(dirPortion))
      .then(({ entries, isRoot }) => {
        if (stale) return
        setDirEntries(entries.filter((e) => e.isDirectory))
        setDirIsRoot(isRoot)
        setSelectedIndex(0)
      })
      .catch(() => {
        if (stale) return
        setDirEntries([])
        setDirIsRoot(false)
      })
    return () => {
      stale = true
    }
  }, [dirPortion, isAbsolutePath, listDir])

  const filteredEntries = useMemo(() => {
    if (!isAbsolutePath || dirEntries.length === 0) return []
    const items: DirEntry[] = dirIsRoot
      ? dirEntries
      : [{ name: '..', isDirectory: true }, ...dirEntries]
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((e) => e.name.toLowerCase().includes(q))
  }, [isAbsolutePath, dirEntries, dirIsRoot, query])

  const menuOpen = filteredEntries.length > 0

  // Keep the highlighted row visible inside the scrolling list
  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const descend = useCallback(
    (entry: DirEntry): void => {
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
      setValue(newValue.replace(/[/\\]{2,}/g, sep))
      setSelectedIndex(0)
      setError(null)
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [value, dirPortion]
  )

  /**
   * A path that only exists on the client's screen would spawn a session in a
   * directory the host does not have, so confirm through the host: the handler
   * returns an empty `resolvedPath` for anything it cannot read as a directory.
   */
  const confirm = useCallback(async (): Promise<void> => {
    const target = toConfirmPath(value)
    if (!target) return
    setChecking(true)
    try {
      const { resolvedPath } = await listDir(toListPath(target))
      if (!resolvedPath) {
        setError('No such directory on the host')
        return
      }
      onConfirm(normalizeResolved(resolvedPath))
    } catch {
      setError('No such directory on the host')
    } finally {
      setChecking(false)
    }
  }, [value, listDir, onConfirm])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % filteredEntries.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + filteredEntries.length) % filteredEntries.length)
        return
      }
      // ArrowRight only descends from the end of the text — mid-string it is
      // still ordinary caret movement.
      const atEnd = e.currentTarget.selectionStart === value.length
      if (e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd)) {
        const entry = filteredEntries[selectedIndex]
        if (entry) {
          e.preventDefault()
          descend(entry)
          return
        }
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void confirm()
    }
  }

  return (
    <div data-testid="DirectoryBrowserInput" className="flex flex-col gap-1.5 px-3 py-2">
      <input
        ref={inputRef}
        data-testid="DirectoryBrowserInput.path"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'D:\\projects or /home/you/repo'}
        spellCheck={false}
        autoComplete="off"
        className="w-full text-[12px] font-mono bg-bg-input border border-border rounded px-2 py-1 text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
      />

      {error && (
        <span data-testid="DirectoryBrowserInput.error" className="text-[11px] text-danger">
          {error}
        </span>
      )}

      {menuOpen && (
        <div
          ref={listRef}
          className="max-h-40 overflow-y-auto rounded border border-border bg-bg-input"
        >
          {filteredEntries.map((entry, i) => (
            <button
              key={entry.name}
              data-testid="DirectoryBrowserInput.entry"
              data-id={entry.name}
              onMouseDown={(e) => e.preventDefault()} // keep the input focused
              onClick={() => descend(entry)}
              className={`w-full flex items-center gap-2 px-2 py-1 text-left transition-colors cursor-default ${
                i === selectedIndex ? 'bg-bg-hover' : 'hover:bg-bg-hover/50'
              }`}
            >
              <FolderIcon />
              <span className="text-[12px] text-text-primary font-mono truncate">
                {entry.name}
                {entry.name === '..' ? '' : '/'}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[10px] text-text-muted">
          Tab to open · Enter to start
        </span>
        <button
          data-testid="DirectoryBrowserInput.cancel"
          onClick={onCancel}
          className="px-2 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        >
          Cancel
        </button>
        <button
          data-testid="DirectoryBrowserInput.confirm"
          onClick={() => void confirm()}
          disabled={checking || !toConfirmPath(value)}
          className="px-2 py-0.5 rounded text-[11px] text-accent hover:bg-bg-hover disabled:opacity-40 transition-colors cursor-default"
        >
          Start
        </button>
      </div>
    </div>
  )
}
