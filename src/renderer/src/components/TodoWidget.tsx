import { useState } from 'react'
import { useActiveSession } from '../stores/session-store'
import type { TodoItem } from '../../../shared/types'

function StatusIndicator({ status }: { status: TodoItem['status'] }): React.JSX.Element {
  if (status === 'in_progress') {
    return (
      <span className="w-3.5 h-3.5 rounded-full border-[1.5px] border-accent border-t-transparent shrink-0 animate-spin-slow" />
    )
  }
  if (status === 'completed') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-success shrink-0">
        <polyline points="4 12 10 18 20 6" />
      </svg>
    )
  }
  return (
    <span className="w-3.5 h-3.5 rounded-full border-[1.5px] border-text-secondary shrink-0" />
  )
}

function CircularProgress({ pct }: { pct: number }): React.JSX.Element {
  const r = 15
  const circumference = 2 * Math.PI * r
  return (
    <svg width="18" height="18" viewBox="0 0 36 36" className="shrink-0 -rotate-90">
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-border" />
      <circle
        cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="2.5"
        className="text-accent"
        strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function TodoWidget(): React.JSX.Element | null {
  const todos = useActiveSession((s) => s.todos)
  const [expanded, setExpanded] = useState(false)

  if (todos.length === 0) return null
  if (todos.every((t) => t.status === 'completed')) return null

  const completedCount = todos.filter((t) => t.status === 'completed').length
  const totalCount = todos.length
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  return (
    <div
      className="absolute top-14 right-4 z-10 bg-bg-tertiary border border-border light-no-border shadow-lg shadow-black/30 overflow-hidden transition-all duration-200 ease-out"
      style={{
        width: expanded ? 'min(400px, 45%)' : 155,
        borderRadius: expanded ? 12 : 8
      }}
    >
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center px-3 h-9 hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <span className="text-[12px] text-text-secondary font-medium whitespace-nowrap">To Do</span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <CircularProgress pct={progressPct} />
          <span className="text-[12px] text-text-secondary font-mono whitespace-nowrap">{completedCount}/{totalCount}</span>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className="text-text-secondary ml-1 transition-transform duration-200"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)' }}
          >
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </div>
      </button>

      {/* Expandable body */}
      <div
        className="transition-[max-height,opacity] duration-200 ease-out overflow-hidden"
        style={{
          maxHeight: expanded ? 300 : 0,
          opacity: expanded ? 1 : 0
        }}
      >
        <div className="border-t border-border">
          {/* List — original order preserved */}
          <div className="max-h-[256px] overflow-y-auto">
            {todos.map((todo, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0"
              >
                <div className="mt-0.5">
                  <StatusIndicator status={todo.status} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-[12px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis ${
                    todo.status === 'completed' ? 'text-text-secondary line-through' : 'text-text-primary'
                  }`}>
                    {todo.content}
                  </div>
                  {todo.status === 'in_progress' && todo.activeForm && (
                    <div className="text-[11px] text-accent italic mt-0.5 truncate">
                      {todo.activeForm}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div className="h-0.5 bg-border">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
