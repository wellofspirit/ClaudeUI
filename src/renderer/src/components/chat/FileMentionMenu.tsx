import { useEffect, useRef } from 'react'
import type { DirEntry } from '../../../../shared/types'

interface FileMentionMenuProps {
  entries: DirEntry[]        // already filtered and includes ".." if needed
  selectedIndex: number
  onSelect: (entry: DirEntry) => void
}

/** Directory icon (folder) */
function FolderIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent shrink-0">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/** File icon */
function FileIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

export function FileMentionMenu({
  entries,
  selectedIndex,
  onSelect
}: FileMentionMenuProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll the highlighted item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (entries.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 z-20 max-h-[240px] overflow-y-auto rounded-lg border border-border bg-bg-input shadow-lg shadow-black/30"
    >
      {entries.map((entry, i) => (
        <button
          key={entry.name === '..' ? '..' : entry.name}
          onMouseDown={(e) => {
            e.preventDefault() // keep textarea focused
            onSelect(entry)
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
            i === selectedIndex ? 'bg-bg-hover' : 'hover:bg-bg-hover/50'
          }`}
        >
          {entry.isDirectory ? <FolderIcon /> : <FileIcon />}
          <span className="text-[13px] text-text-primary truncate">
            {entry.name}{entry.isDirectory && entry.name !== '..' ? '/' : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
