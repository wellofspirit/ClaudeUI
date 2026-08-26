import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { DirEntry, ListPlacesResult } from '../../../../shared/types'

/**
 * Modal directory picker for surfaces that cannot open a native folder dialog —
 * i.e. the remote web client, where `pickFolder()` resolves to null.
 *
 * Dumb/presentational on purpose: the listing, the rail shortcuts and the
 * confirm check all arrive through props (normally `window.api.listDir` /
 * `window.api.listPlaces`, which the remote dispatcher forwards to the host's
 * `file:list-dir` / `file:list-places`), so the component never touches
 * `window.api` or a store and stays renderable in jsdom.
 *
 * Replaces the inline `DirectoryBrowserInput` (ADR-046): same path mechanics
 * and keyboard model, wrapped in a two-pane dialog with a places rail so the
 * common destinations are one click away instead of a typed absolute path.
 *
 * TWO LAYOUTS, ONE STATE. Below 768px (`useIsMobile`) the same value/entries/
 * error state renders as a full-screen drill-in — a shortcuts view that lists
 * recents and places, and a browse view behind it — because a 640x430 dialog
 * with a 176px rail is unusable on a phone. Everything that decides what may be
 * confirmed (the seed effects, `descend`, `confirm` and its latch) is shared
 * verbatim; only the markup forks.
 *
 * The path mechanics mirror the dir-autocomplete inside PermissionsDialog's
 * AddRuleInput (same absolute-path detection, Windows drive-root handling and
 * synthesized `..`); that copy is left untouched here to contain churn.
 */

export interface DirectoryBrowserDialogProps {
  /** Receives the HOST-resolved absolute path, only after it lists successfully. */
  onConfirm: (path: string) => void
  onCancel: () => void
  listDir: (
    dirPath: string
  ) => Promise<{ entries: DirEntry[]; isRoot: boolean; resolvedPath?: string }>
  listPlaces: () => Promise<ListPlacesResult>
  /** Recently used project directories, rendered as the rail's RECENT section. */
  recents?: Array<{ cwd: string; folderName: string }>
  /** Open here instead of the host's home directory. */
  initialPath?: string
  confirmLabel?: string
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

/** A path the input can browse from: whatever separator style it already uses. */
function withTrailingSep(dirPath: string): string {
  if (!dirPath) return ''
  if (/[/\\]$/.test(dirPath)) return dirPath
  return dirPath + (dirPath.includes('\\') ? '\\' : '/')
}

/**
 * Loose key for the rail highlight only — never an identity test. Separator
 * style and the case of a Windows drive letter both vary between what the host
 * reports and what the user typed, and neither means a different directory.
 */
function railKey(dirPath: string): string {
  const slashed = dirPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return slashed.replace(/^([A-Za-z]):/, (_m, letter: string) => `${letter.toLowerCase()}:`)
}

interface IconProps {
  active?: boolean
  /** Touch layouts render the same glyphs a couple of pixels larger. */
  size?: number
}

function FolderIcon({ active, size = 13 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${active ? 'text-accent' : 'text-text-muted'}`}
    >
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  )
}

function HomeIcon({ active, size = 12 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${active ? 'text-accent' : 'text-text-muted'}`}
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  )
}

function DriveIcon({ active, size = 12 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={`shrink-0 ${active ? 'text-accent' : 'text-text-muted'}`}
    >
      <rect x="2" y="7" width="20" height="10" rx="2" />
      <circle cx="17.5" cy="12" r="1" fill="currentColor" />
    </svg>
  )
}

function CloseIcon({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="shrink-0 text-text-muted"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  )
}

/** `‹` / `›` as geometry rather than a glyph, so the metrics do not shift with the font. */
function Chevron({ dir }: { dir: 'left' | 'right' }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  )
}

function RailSection({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="px-3 pb-1.5 text-[9.5px] font-semibold tracking-[0.08em] text-text-muted">
        {label}
      </div>
      {children}
    </div>
  )
}

export function DirectoryBrowserDialog({
  onConfirm,
  onCancel,
  listDir,
  listPlaces,
  recents,
  initialPath,
  confirmLabel
}: DirectoryBrowserDialogProps): React.JSX.Element {
  const isMobile = useIsMobile()
  /**
   * Mobile only: which half of the drill-in is on screen. An `initialPath`
   * caller already knows where it wants to be, so it skips the shortcuts.
   */
  const [mobileView, setMobileView] = useState<'shortcuts' | 'browse'>(
    initialPath ? 'browse' : 'shortcuts'
  )
  const [value, setValue] = useState(() => withTrailingSep(initialPath ?? ''))
  const [places, setPlaces] = useState<ListPlacesResult | null>(null)
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([])
  const [dirIsRoot, setDirIsRoot] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { dirPortion, query } = useMemo(() => splitPath(value), [value])
  const isAbsolutePath = ABSOLUTE_PATH_RE.test(value)

  /**
   * Desktop opens with the caret in the path input. Never on mobile: focusing an
   * input programmatically summons the software keyboard over half the screen,
   * and the mobile flow opens on a list of taps, not on typing. (With an
   * `initialPath` the mobile dialog opens straight on the browse view, so the
   * input IS mounted here — the guard is what keeps the keyboard down, not the
   * absence of the element.)
   */
  useEffect(() => {
    if (!isMobile) inputRef.current?.focus()
  }, [isMobile])

  /**
   * The one place mobile DOES focus the input: the "Type a path…" row, which is
   * the explicit typing affordance. `useLayoutEffect` rather than a `rAF` —
   * it runs synchronously in the same task as the tap that flipped the view, so
   * the focus still counts as user-initiated and iOS actually opens the keyboard.
   */
  const focusOnBrowse = useRef(false)
  useLayoutEffect(() => {
    if (mobileView !== 'browse' || !focusOnBrowse.current) return
    focusOnBrowse.current = false
    inputRef.current?.focus()
  }, [mobileView])

  /** Rail shortcuts. Best-effort: what the host could not answer stays hidden. */
  useEffect(() => {
    let stale = false
    listPlaces()
      .then((result) => {
        if (!stale) setPlaces(result)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [listPlaces])

  /**
   * Open on somewhere real. The listing effect below only fires for an absolute
   * path, so an untouched input showed an empty box until the user typed a drive
   * or a slash. `listDir('')` is the host's home directory; an empty
   * `resolvedPath` means it could not answer, and the input just stays blank.
   *
   * The write is conditional on the input still being empty rather than gated by
   * a ran-once ref: that keeps a seed typed over mid-flight, keeps an
   * `initialPath` from being clobbered, and keeps this correct under StrictMode's
   * mount/unmount/remount, where a ref-gated second pass would bail while the
   * first pass's result was already discarded.
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

  /**
   * First-wins dedupe on cwd. Callers map the session store's `directories`,
   * which is unique by projectKey rather than by cwd — two groups sharing a cwd
   * would render two identical rail rows under one duplicated React key.
   */
  const railRecents = useMemo(() => {
    const seen = new Set<string>()
    const unique: Array<{ cwd: string; folderName: string }> = []
    for (const recent of recents ?? []) {
      if (seen.has(recent.cwd)) continue
      seen.add(recent.cwd)
      unique.push(recent)
    }
    return unique
  }, [recents])

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
      // Desktop only: clicking a row must not cost the caret. On a phone the
      // same call would raise the keyboard on every folder tap.
      if (!isMobile) requestAnimationFrame(() => inputRef.current?.focus())
    },
    [value, dirPortion, isMobile]
  )

  /** A rail click NAVIGATES — it never confirms. Two clicks, never an accident. */
  const navigate = useCallback(
    (target: string): void => {
      setValue(withTrailingSep(target))
      setSelectedIndex(0)
      setError(null)
      if (!isMobile) requestAnimationFrame(() => inputRef.current?.focus())
    },
    [isMobile]
  )

  /**
   * A path that only exists on the client's screen would spawn a session in a
   * directory the host does not have, so confirm through the host: the handler
   * returns an empty `resolvedPath` for anything it cannot read as a directory.
   *
   * One confirm at a time. Enter key-repeat over a slow remote link would
   * otherwise put several `listDir` checks in flight and call `onConfirm` once
   * per resolution — which in WelcomeState is one duplicate session each. The
   * latch is a REF, not the `checking` state: `setChecking(true)` does not land
   * until React re-renders, so two keystrokes inside one batch would both read
   * the stale `false`. `checking` still drives the disabled button.
   */
  const confirmInFlight = useRef(false)
  const confirm = useCallback(async (): Promise<void> => {
    if (confirmInFlight.current) return
    const target = toConfirmPath(value)
    if (!target) return
    confirmInFlight.current = true
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
      confirmInFlight.current = false
      setChecking(false)
    }
  }, [value, listDir, onConfirm])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // The dialog root cancels on Escape too (for the rail and the buttons);
      // sealing it here keeps one keystroke from cancelling twice.
      e.stopPropagation()
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

  const confirmPath = toConfirmPath(value)
  const activeKey = railKey(confirmPath)
  const homePlace = places?.home ?? ''
  const drivePlaces = places?.drives ?? []
  const hasPlaces = !!homePlace || drivePlaces.length > 0
  const showRail = railRecents.length > 0 || hasPlaces
  // A phone's button is the end of the flow, so it says what it will do; the
  // desktop footer already reads as a dialog. An explicit prop beats both.
  const resolvedConfirmLabel = confirmLabel ?? (isMobile ? 'Select this directory' : 'Select')

  const rootKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    onCancel()
  }

  /** One directory row, in either density — the two lists differ only in size. */
  const entryRow = (
    entry: DirEntry,
    i: number,
    variant: 'compact' | 'touch'
  ): React.JSX.Element => {
    const selected = i === selectedIndex
    const touch = variant === 'touch'
    return (
      <button
        key={entry.name}
        type="button"
        data-testid="DirectoryBrowserDialog.entry"
        data-id={entry.name}
        onMouseDown={(e) => e.preventDefault()} // keep the input focused
        onClick={() => descend(entry)}
        className={`w-full flex items-center text-left transition-colors cursor-default ${
          touch ? 'gap-3 px-4 py-3' : 'gap-2.5 px-4 py-1.5'
        } ${selected ? 'bg-bg-hover' : 'hover:bg-bg-hover/50'}`}
      >
        <FolderIcon active={selected} size={touch ? 15 : 13} />
        <span
          className={`${touch ? 'text-[13px]' : 'text-[12px]'} text-text-primary font-mono truncate`}
        >
          {entry.name}
          {entry.name === '..' ? '' : '/'}
        </span>
      </button>
    )
  }

  const railItem = (
    testid: string,
    dirPath: string,
    label: string,
    icon: (active: boolean) => React.JSX.Element,
    opts: { mono?: boolean; title?: string } = {}
  ): React.JSX.Element => {
    const active = railKey(dirPath) === activeKey
    return (
      <button
        key={dirPath}
        type="button"
        data-testid={testid}
        data-id={dirPath}
        data-active={active || undefined}
        title={opts.title ?? dirPath}
        onMouseDown={(e) => e.preventDefault()} // keep the input focused
        onClick={() => navigate(dirPath)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-default ${
          active ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover/60'
        }`}
      >
        {icon(active)}
        <span className={`text-[12px] truncate ${opts.mono ? 'font-mono' : ''}`}>{label}</span>
      </button>
    )
  }

  /**
   * The mobile counterpart of `railItem`: same testid, same `data-id`, same
   * `navigate` — it additionally drills into the browse view, which is the whole
   * point of the layout. No `focus()`: tapping a folder must not raise the
   * keyboard (the "Type a path…" row is the affordance that does).
   */
  const shortcutRow = (
    testid: string,
    dirPath: string,
    label: string,
    subtitle: string | undefined,
    icon: (active: boolean) => React.JSX.Element,
    opts: { mono?: boolean } = {}
  ): React.JSX.Element => {
    const active = railKey(dirPath) === activeKey
    return (
      <button
        key={dirPath}
        type="button"
        data-testid={testid}
        data-id={dirPath}
        data-active={active || undefined}
        onClick={() => {
          navigate(dirPath)
          setMobileView('browse')
        }}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors active:bg-bg-hover"
      >
        {icon(active)}
        {subtitle ? (
          <span className="flex flex-col min-w-0 flex-1">
            <span className="text-[13px] text-text-primary truncate">{label}</span>
            <span className="font-mono text-[11px] text-text-muted truncate">{subtitle}</span>
          </span>
        ) : (
          <span
            className={`flex-1 min-w-0 truncate text-[13px] text-text-primary ${
              opts.mono ? 'font-mono' : ''
            }`}
          >
            {label}
          </span>
        )}
        <span className="text-text-muted">
          <Chevron dir="right" />
        </span>
      </button>
    )
  }

  if (isMobile) {
    return createPortal(
      <div
        data-testid="DirectoryBrowserDialog"
        data-view={mobileView}
        role="dialog"
        aria-modal="true"
        aria-label="Select directory"
        className="fixed inset-0 z-[200] bg-bg-tertiary flex flex-col animate-fade-in"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
        onKeyDown={rootKeyDown}
      >
        {mobileView === 'shortcuts' ? (
          <>
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[14px] font-medium text-text-primary">Select directory</span>
                {places?.hostname && (
                  <span className="text-[11px] text-text-muted truncate">on {places.hostname}</span>
                )}
              </div>
              <button
                type="button"
                data-testid="DirectoryBrowserDialog.close"
                aria-label="Close"
                onClick={onCancel}
                className="w-7 h-7 shrink-0 flex items-center justify-center rounded text-text-muted active:bg-bg-hover transition-colors"
              >
                <CloseIcon size={14} />
              </button>
            </div>

            <button
              type="button"
              data-testid="DirectoryBrowserDialog.typePath"
              onClick={() => {
                focusOnBrowse.current = true
                setMobileView('browse')
              }}
              className="mx-4 mt-3 mb-1 shrink-0 flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-bg-input border border-border text-left"
            >
              <SearchIcon />
              <span className="font-mono text-[13px] text-text-muted">Type a path…</span>
            </button>

            <div
              className="flex-1 overflow-y-auto pt-2"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              {railRecents.length > 0 && (
                <>
                  <div className="px-4 pb-1.5 pt-2 text-[9.5px] font-semibold tracking-[0.08em] text-text-muted">
                    RECENT
                  </div>
                  {railRecents.map((r) =>
                    shortcutRow(
                      'DirectoryBrowserDialog.recent',
                      r.cwd,
                      r.folderName,
                      r.cwd,
                      (active) => <FolderIcon active={active} size={16} />
                    )
                  )}
                </>
              )}
              {hasPlaces && (
                <>
                  <div className="px-4 pb-1.5 pt-4 text-[9.5px] font-semibold tracking-[0.08em] text-text-muted">
                    PLACES
                  </div>
                  {homePlace &&
                    shortcutRow(
                      'DirectoryBrowserDialog.place',
                      homePlace,
                      'Home',
                      homePlace,
                      (active) => <HomeIcon active={active} size={15} />
                    )}
                  {drivePlaces.map((drive) =>
                    shortcutRow(
                      'DirectoryBrowserDialog.place',
                      drive,
                      drive,
                      undefined,
                      (active) => <DriveIcon active={active} size={15} />,
                      { mono: true }
                    )
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border">
              <button
                type="button"
                data-testid="DirectoryBrowserDialog.back"
                aria-label="Back"
                onClick={() => {
                  setError(null)
                  setMobileView('shortcuts')
                }}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded text-text-secondary active:bg-bg-hover transition-colors"
              >
                <Chevron dir="left" />
              </button>
              <input
                ref={inputRef}
                data-testid="DirectoryBrowserDialog.path"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  setError(null)
                }}
                onKeyDown={handleKeyDown}
                placeholder="D:\projects or /home/you/repo"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 min-w-0 text-[13px] font-mono bg-bg-input border border-accent/50 rounded-lg px-3 py-2.5 text-text-primary placeholder:text-text-muted/50 outline-none"
              />
            </div>

            <div ref={listRef} className="flex-1 overflow-y-auto py-1">
              {filteredEntries.map((entry, i) => entryRow(entry, i, 'touch'))}
            </div>

            <div
              className="shrink-0 px-4 py-3 border-t border-border bg-bg-input"
              style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
            >
              {error ? (
                <div
                  data-testid="DirectoryBrowserDialog.error"
                  className="text-[11px] text-danger truncate mb-2.5"
                >
                  {error}
                </div>
              ) : (
                <div className="font-mono text-[11px] text-text-muted truncate mb-2.5">
                  {confirmPath}
                </div>
              )}
              <button
                type="button"
                data-testid="DirectoryBrowserDialog.confirm"
                onClick={() => void confirm()}
                disabled={checking || !confirmPath}
                className="w-full py-2.5 rounded-lg text-[13px] font-medium bg-accent text-bg-primary disabled:opacity-40 transition-colors"
              >
                {resolvedConfirmLabel}
              </button>
            </div>
          </>
        )}
      </div>,
      document.body
    )
  }

  return createPortal(
    <div
      data-testid="DirectoryBrowserDialog"
      role="dialog"
      aria-modal="true"
      aria-label="Select directory"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      onKeyDown={rootKeyDown}
    >
      <div className="w-[min(640px,calc(100vw-2rem))] h-[min(430px,80vh)] bg-bg-tertiary border border-border-bright rounded-xl shadow-2xl flex overflow-hidden">
        {/* Places rail. Narrow viewports never reach this branch — the phone
            layout lives in the `isMobile` fork above. */}
        {showRail && (
          <div className="w-44 shrink-0 bg-bg-secondary border-r border-border py-3 flex flex-col gap-4 overflow-y-auto">
            {railRecents.length > 0 && (
              <RailSection label="RECENT">
                {railRecents.map((r) =>
                  railItem(
                    'DirectoryBrowserDialog.recent',
                    r.cwd,
                    r.folderName,
                    (active) => <FolderIcon active={active} />,
                    { title: r.cwd }
                  )
                )}
              </RailSection>
            )}
            {hasPlaces && (
              <RailSection label="PLACES">
                {homePlace &&
                  railItem('DirectoryBrowserDialog.place', homePlace, 'Home', (active) => (
                    <HomeIcon active={active} />
                  ))}
                {drivePlaces.map((drive) =>
                  railItem(
                    'DirectoryBrowserDialog.place',
                    drive,
                    drive,
                    (active) => <DriveIcon active={active} />,
                    { mono: true }
                  )
                )}
              </RailSection>
            )}
          </div>
        )}

        {/* Browse pane */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[13px] font-medium text-text-primary">Select directory</span>
              {places?.hostname && (
                <span className="text-[11px] text-text-muted truncate">on {places.hostname}</span>
              )}
            </div>
            <button
              type="button"
              data-testid="DirectoryBrowserDialog.close"
              aria-label="Close"
              onClick={onCancel}
              className="w-6 h-6 shrink-0 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            >
              <CloseIcon />
            </button>
          </div>

          <div className="px-4 py-2 border-b border-border">
            <input
              ref={inputRef}
              data-testid="DirectoryBrowserDialog.path"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={handleKeyDown}
              placeholder="D:\projects or /home/you/repo"
              spellCheck={false}
              autoComplete="off"
              className="w-full text-[12px] font-mono bg-bg-input border border-border rounded px-2 py-1.5 text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/50 transition-colors"
            />
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto py-1">
            {filteredEntries.map((entry, i) => entryRow(entry, i, 'compact'))}
          </div>

          <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-bg-input">
            {error ? (
              <span
                data-testid="DirectoryBrowserDialog.error"
                className="flex-1 min-w-0 truncate text-[11px] text-danger"
              >
                {error}
              </span>
            ) : (
              <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-text-muted">
                {confirmPath}
              </span>
            )}
            <button
              type="button"
              data-testid="DirectoryBrowserDialog.cancel"
              onClick={onCancel}
              className="px-3 py-1 rounded text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="DirectoryBrowserDialog.confirm"
              onClick={() => void confirm()}
              disabled={checking || !confirmPath}
              className="px-3 py-1 rounded text-[12px] font-medium bg-accent text-bg-primary hover:bg-accent-hover disabled:opacity-40 transition-colors cursor-default"
            >
              {resolvedConfirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
