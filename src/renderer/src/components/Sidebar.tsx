import { useSessionStore } from '../stores/session-store'

export function Sidebar(): React.JSX.Element {
  const cwd = useSessionStore((s) => s.cwd)
  const recentDirs = useSessionStore((s) => s.recentDirs)
  const openDirectory = useSessionStore((s) => s.openDirectory)

  const handleOpen = async (dir: string): Promise<void> => {
    await window.api.createSession(dir)
    openDirectory(dir)
  }

  const handlePickFolder = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) {
      await window.api.createSession(folder)
      openDirectory(folder)
    }
  }

  return (
    <div className={`w-60 shrink-0 flex flex-col select-none ${window.api.platform === 'darwin' ? 'bg-bg-secondary/80' : 'bg-bg-secondary/85'}`}>
      {/* Traffic light clearance */}
      <div className="h-12 shrink-0 [-webkit-app-region:drag]" />

      {/* Top nav */}
      <nav style={{ margin: '0 8px' }} className="flex flex-col gap-px">
        <NavItem
          label="New thread"
          onClick={handlePickFolder}
          icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
            </svg>
          }
        />
      </nav>

      {/* Threads = recent directories */}
      {recentDirs.length > 0 && (
        <div style={{ margin: '20px 8px 0' }}>
          <div style={{ paddingLeft: 5, marginBottom: 3 }}>
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">Threads</span>
          </div>
          <nav className="flex flex-col gap-px">
            {recentDirs.map((dir) => {
              const name = dir.split(/[\\/]/).pop() || dir
              const isActive = dir === cwd
              return (
                <NavItem
                  key={dir}
                  label={name}
                  active={isActive}
                  onClick={() => handleOpen(dir)}
                  icon={
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                  }
                />
              )
            })}
          </nav>
        </div>
      )}

      <div className="flex-1" />

      {/* Footer */}
      <div style={{ padding: '12px 16px' }} className="border-t border-border/50 flex items-center gap-2 text-[11px] text-text-muted">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-text-muted">
          <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>ClaudeUI</span>
      </div>
    </div>
  )
}

function NavItem({ label, icon, active, onClick }: {
  label: string
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div
      style={{ padding: '0 5px' }}
      onClick={onClick}
      className={`
        flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
        ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
      `}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate flex-1">{label}</span>
    </div>
  )
}
