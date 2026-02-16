import { useEffect, useRef } from 'react'
import type { SlashCommandInfo } from '../../../../shared/types'

interface SlashCommandMenuProps {
  commands: SlashCommandInfo[]
  filter: string
  selectedIndex: number
  onSelect: (name: string) => void
}

export function SlashCommandMenu({
  commands,
  filter,
  selectedIndex,
  onSelect
}: SlashCommandMenuProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  // Filter commands by the typed prefix (after the /)
  const filtered = commands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith('/' + filter.toLowerCase())
  )

  // Scroll the highlighted item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (filtered.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 z-20 max-h-[240px] overflow-y-auto rounded-lg border border-border bg-bg-input shadow-lg shadow-black/30"
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          onMouseDown={(e) => {
            e.preventDefault() // keep textarea focused
            onSelect(cmd.name)
          }}
          className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
            i === selectedIndex ? 'bg-bg-hover' : 'hover:bg-bg-hover/50'
          }`}
        >
          <span className="text-[13px] font-medium text-text-primary shrink-0">{cmd.name}</span>
          {cmd.description && (
            <span className="text-[12px] text-text-muted truncate">{cmd.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** Helper to filter commands — exported for use in InputBox keyboard logic */
export function filterSlashCommands(
  commands: SlashCommandInfo[],
  filter: string
): SlashCommandInfo[] {
  return commands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith('/' + filter.toLowerCase())
  )
}
