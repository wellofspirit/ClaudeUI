import type { MockupErrorEntry, MockupLogEntry } from '../../hooks/useMockupBridge'

export interface MockupConsoleDrawerProps {
  logs: MockupLogEntry[]
  errors: MockupErrorEntry[]
  expanded: boolean
  onToggle: () => void
  onClear: () => void
}

const LEVEL_COLOR: Record<MockupLogEntry['level'], string> = {
  log: 'text-text-secondary',
  info: 'text-accent',
  warn: 'text-warning',
  error: 'text-danger',
  debug: 'text-text-muted'
}

/**
 * Collapsible drawer showing console.* + uncaught errors from the mockup
 * iframe. The iframe's DevTools aren't reachable with one click, so this
 * exists for debugging generated mockups without hunting through the
 * Electron devtools tree.
 */
export function MockupConsoleDrawer({
  logs,
  errors,
  expanded,
  onToggle,
  onClear
}: MockupConsoleDrawerProps): React.JSX.Element {
  const total = logs.length + errors.length
  const errorCount = errors.length

  // Interleave logs + errors chronologically using their shared seq id.
  const combined: Array<
    { kind: 'log'; entry: MockupLogEntry } | { kind: 'error'; entry: MockupErrorEntry }
  > = [
    ...logs.map((entry) => ({ kind: 'log' as const, entry })),
    ...errors.map((entry) => ({ kind: 'error' as const, entry }))
  ].sort((a, b) => a.entry.id - b.entry.id)

  return (
    <div data-testid="MockupConsoleDrawer" className="shrink-0 border-t border-border bg-bg-primary/50">
      <div className="flex items-center gap-2 px-3 h-8">
        <button
          data-testid="MockupConsoleDrawer.toggle"
          onClick={onToggle}
          className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-secondary cursor-default"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s' }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Console
          {total > 0 && (
            <span
              className={`ml-1 tabular-nums ${errorCount > 0 ? 'text-danger' : 'text-text-muted'}`}
            >
              {total}
              {errorCount > 0 && ` · ${errorCount} error${errorCount === 1 ? '' : 's'}`}
            </span>
          )}
        </button>
        <div className="flex-1" />
        {total > 0 && (
          <button
            data-testid="MockupConsoleDrawer.clear"
            onClick={onClear}
            className="text-[11px] text-text-muted hover:text-text-secondary cursor-default"
            title="Clear console"
          >
            Clear
          </button>
        )}
      </div>
      {expanded && (
        <div
          className="max-h-[200px] overflow-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed border-t border-border"
          data-testid="MockupConsoleDrawer.entries"
        >
          {combined.length === 0 ? (
            <div className="text-text-muted/60 italic py-1">No console output.</div>
          ) : (
            combined.map(({ kind, entry }) =>
              kind === 'log' ? (
                <div
                  key={entry.id}
                  className={`py-0.5 ${LEVEL_COLOR[entry.level]} whitespace-pre-wrap break-all`}
                >
                  <span className="text-text-muted/50 mr-1.5">[{entry.level}]</span>
                  {entry.args.join(' ')}
                </div>
              ) : (
                <div key={entry.id} className="py-0.5 text-danger whitespace-pre-wrap break-all">
                  <span className="text-text-muted/50 mr-1.5">[error]</span>
                  {entry.message}
                  {entry.filename && (
                    <span className="text-text-muted ml-2">
                      @ {entry.filename}:{entry.lineno}
                    </span>
                  )}
                  {entry.stack && (
                    <div className="text-text-muted/70 pl-4 mt-0.5">{entry.stack}</div>
                  )}
                </div>
              )
            )
          )}
        </div>
      )}
    </div>
  )
}
