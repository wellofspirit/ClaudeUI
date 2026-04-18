import { useState, useRef, useEffect, useCallback } from 'react'
import { TaskEntry } from './TaskEntry'
import { BashBackgroundEntry } from './BashBackgroundEntry'

export type TaskEntryKind = 'bash-background' | 'task' | 'missing'

export interface TaskEntryDescriptor {
  toolUseId: string
  kind: TaskEntryKind
}

export interface TaskDetailPanelViewProps {
  style?: React.CSSProperties
  entries: TaskEntryDescriptor[]
  onClose: () => void
}

function HResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <div
      onMouseDown={onMouseDown}
      className="h-0 shrink-0 cursor-row-resize relative z-10"
    >
      <div className="absolute -top-1.5 left-0 right-0 h-3" />
      <div className="absolute top-0 left-4 right-4 border-t border-border" />
    </div>
  )
}

function PanelEntry({ entry }: { entry: TaskEntryDescriptor }): React.JSX.Element | null {
  if (entry.kind === 'missing') return null
  if (entry.kind === 'bash-background') return <BashBackgroundEntry toolUseId={entry.toolUseId} />
  return <TaskEntry toolUseId={entry.toolUseId} />
}

export function TaskDetailPanelView({ style, entries, onClose }: TaskDetailPanelViewProps): React.JSX.Element {
  const count = entries.length
  const [ratios, setRatios] = useState<number[]>(() => Array(count).fill(1 / Math.max(count, 1)))
  const prevCount = useRef(count)
  useEffect(() => {
    if (count !== prevCount.current) {
      prevCount.current = count
      setRatios(Array(count).fill(1 / Math.max(count, 1)))
    }
  }, [count])

  const containerRef = useRef<HTMLDivElement>(null)

  const handleResizeMouseDown = useCallback((index: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const containerH = container.clientHeight
    if (containerH === 0) return

    const startY = e.clientY
    const startRatios = [...ratios]
    const MIN_RATIO = 0.08

    const onMouseMove = (ev: MouseEvent): void => {
      const deltaRatio = (ev.clientY - startY) / containerH
      let newAbove = startRatios[index] + deltaRatio
      let newBelow = startRatios[index + 1] - deltaRatio

      if (newAbove < MIN_RATIO) {
        newBelow += newAbove - MIN_RATIO
        newAbove = MIN_RATIO
      }
      if (newBelow < MIN_RATIO) {
        newAbove += newBelow - MIN_RATIO
        newBelow = MIN_RATIO
      }

      const next = [...startRatios]
      next[index] = newAbove
      next[index + 1] = newBelow
      setRatios(next)
    }

    const onMouseUp = (): void => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [ratios])

  return (
    <div style={style} className="shrink-0 border-l border-border bg-bg-secondary flex flex-col h-full">
      <div className="shrink-0 flex items-center px-4 h-12 border-b border-border [-webkit-app-region:drag]">
        <span className="text-[13px] text-text-secondary font-medium flex-1">Tasks</span>
        <button
          onClick={onClose}
          className="[-webkit-app-region:no-drag] text-text-muted hover:text-text-primary transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
        {entries.map((entry, i) => (
          <div key={entry.toolUseId} className="contents">
            {i > 0 && <HResizeHandle onMouseDown={handleResizeMouseDown(i - 1)} />}
            <div style={{ flex: `${ratios[i] ?? 1} 0 0%` }} className="min-h-0 overflow-hidden">
              <PanelEntry entry={entry} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
