import { useActiveSession, useSessionStore } from '../../../stores/session-store'

interface Props {
  stagedCount: number
  unstagedCount: number
}

export function FilterTabs({ stagedCount, unstagedCount }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const gitFileFilter = useActiveSession((s) => s.gitFileFilter)
  const setGitFileFilter = useSessionStore((s) => s.setGitFileFilter)

  const tabs: Array<{ key: 'staged' | 'unstaged' | 'all'; label: string; count: number }> = [
    { key: 'staged', label: 'Staged', count: stagedCount },
    { key: 'unstaged', label: 'Unstaged', count: unstagedCount },
    { key: 'all', label: 'All', count: stagedCount + unstagedCount }
  ]

  return (
    <div className="shrink-0 flex border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => activeSessionId && setGitFileFilter(activeSessionId, tab.key)}
          className={`flex-1 px-2 py-1.5 text-[11px] font-medium transition-colors cursor-default ${
            gitFileFilter === tab.key
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {tab.label} ({tab.count})
        </button>
      ))}
    </div>
  )
}
