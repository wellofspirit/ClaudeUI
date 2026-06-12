import { useState, useRef, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { useSidebarCollapsed } from '../../SessionView'
import { WindowControls } from '../../WindowControls'
import { WorktreePill } from '../../git/WorktreePill'
import { GitBranchPill } from '../../git/GitBranchPill'
import { GitChangesPill } from '../../git/GitChangesPill'
import { PermissionsDialog } from '../../PermissionsDialog'
import { SkillsDialog } from '../../SkillsDialog'
import { McpDialog } from '../../McpDialog'

export function TopBar({ hasContent }: { hasContent: boolean }): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const sdkSessionId = useActiveSession((s) => s.status.sessionId)
  const statusLine = useActiveSession((s) => s.statusLine)
  const fallbackCost = useActiveSession((s) => s.status.totalCostUsd)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const customTitle = useSessionStore((s) =>
    activeSessionId ? s.customTitles[activeSessionId] : undefined
  )
  const {
    collapsed: sidebarCollapsed,
    toggle: toggleSidebar,
    isMobile: isMobileCtx
  } = useSidebarCollapsed()
  const showWelcome = useSessionStore((s) => s.showWelcome)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const isMac = window.api.platform === 'darwin'
  const leftPadding = isMobileCtx ? 8 : sidebarCollapsed && isMac ? 148 / uiFontScale : 13
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [infoHover, setInfoHover] = useState(false)
  const infoLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)

  const infoMouseEnter = useCallback(() => {
    if (infoLeaveTimer.current) clearTimeout(infoLeaveTimer.current)
    setInfoHover(true)
  }, [])
  const infoMouseLeave = useCallback(() => {
    infoLeaveTimer.current = setTimeout(() => setInfoHover(false), 150)
  }, [])

  const displaySessionId = sdkSessionId || activeSessionId
  const cost = statusLine ? statusLine.totalCostUsd : fallbackCost
  const durationMs = statusLine?.totalDurationMs ?? 0

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  return (
    <div
      style={{
        paddingLeft: leftPadding,
        paddingRight: isMobileCtx ? 8 : 13,
        paddingTop: isMobileCtx ? 'env(safe-area-inset-top)' : undefined
      }}
      className="shrink-0 h-12 flex items-center justify-between [-webkit-app-region:drag] border-b border-border relative"
    >
      <div className="flex items-center min-w-0">
        {/* Mobile: always show hamburger + new session */}
        {isMobileCtx && (
          <div className="[-webkit-app-region:no-drag] flex items-center gap-1 mr-2">
            <button
              onClick={toggleSidebar}
              className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="Menu"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M3 12h18" />
                <path d="M3 6h18" />
                <path d="M3 18h18" />
              </svg>
            </button>
            <button
              onClick={showWelcome}
              className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="New session"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
              </svg>
            </button>
          </div>
        )}
        {/* Desktop: show sidebar toggle when collapsed */}
        {!isMobileCtx && sidebarCollapsed && (
          <div
            style={
              isMac
                ? {
                    position: 'absolute',
                    left: 82 / uiFontScale,
                    top: 22 / uiFontScale,
                    transform: 'translateY(-50%)'
                  }
                : { marginRight: 8 }
            }
            className="[-webkit-app-region:no-drag] flex items-center gap-1"
          >
            <button
              onClick={toggleSidebar}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="Show sidebar"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
                <path d="M14 9l3 3-3 3" />
              </svg>
            </button>
            <button
              onClick={showWelcome}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="New session"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
              </svg>
            </button>
          </div>
        )}
        <div
          className="flex items-center min-w-0 [-webkit-app-region:no-drag] relative"
          onMouseEnter={infoMouseEnter}
          onMouseLeave={infoMouseLeave}
        >
          <span className="text-[13px] text-text-secondary font-normal truncate cursor-default">
            {!cwd ? 'New session' : hasContent ? customTitle || 'Session' : 'New session'}
          </span>
          {(cwd || displaySessionId) && (
            <>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 ml-1 text-text-muted/40 relative top-px"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
              {infoHover && (
                <div
                  className="absolute top-full left-0 pt-1 z-50"
                  onMouseEnter={infoMouseEnter}
                  onMouseLeave={infoMouseLeave}
                >
                  <div className="bg-bg-primary border border-border rounded-lg shadow-lg py-2 px-3 space-y-2 min-w-[200px] max-w-[400px] animate-fade-in">
                    {cwd && (
                      <button
                        onClick={() => handleCopy(cwd, 'cwd')}
                        className="w-full text-left cursor-default group/row"
                      >
                        <div className="text-[10px] text-text-muted mb-0.5">Working Directory</div>
                        <div className="text-[11px] text-text-secondary font-mono truncate group-hover/row:text-text-primary transition-colors">
                          {copiedField === 'cwd' ? 'Copied!' : cwd}
                        </div>
                      </button>
                    )}
                    {displaySessionId && (
                      <button
                        onClick={() => handleCopy(displaySessionId, 'sid')}
                        className="w-full text-left cursor-default group/row"
                      >
                        <div className="text-[10px] text-text-muted mb-0.5">Session ID</div>
                        <div className="text-[11px] text-text-secondary font-mono truncate group-hover/row:text-text-primary transition-colors">
                          {copiedField === 'sid' ? 'Copied!' : displaySessionId}
                        </div>
                      </button>
                    )}
                    {(cost > 0 || durationMs > 0) && (
                      <div className="flex gap-4">
                        {cost > 0 && (
                          <div>
                            <div className="text-[10px] text-text-muted mb-0.5">Cost</div>
                            <div className="text-[11px] text-text-secondary font-mono">
                              ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}
                            </div>
                          </div>
                        )}
                        {durationMs > 0 && (
                          <div>
                            <div className="text-[10px] text-text-muted mb-0.5">Duration</div>
                            <div className="text-[11px] text-text-secondary font-mono">
                              {durationMs < 60000
                                ? `${Math.floor(durationMs / 1000)}s`
                                : `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
        {!isMobileCtx && cwd && (
          <button
            onClick={() => window.api.openInVSCode(cwd)}
            className="group flex items-baseline gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Open in VS Code"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 100 100"
              fill="none"
              className="shrink-0 relative top-[1px] transition-opacity"
            >
              <mask id="vsc" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M70.912 99.317a6.223 6.223 0 004.96-.19l20.589-9.907A6.25 6.25 0 00100 83.587V16.413a6.25 6.25 0 00-3.539-5.633L75.872.873a6.226 6.226 0 00-7.109 1.318L29.355 38.044 12.187 25.02a4.162 4.162 0 00-5.318.27L1.382 30.308a4.168 4.168 0 00-.005 6.146L16.674 50 1.377 63.546a4.168 4.168 0 00.005 6.146l5.487 5.018a4.162 4.162 0 005.318.27l17.168-13.024 39.408 35.853a6.213 6.213 0 002.149 1.508zM75.015 27.3L45.11 50l29.906 22.7V27.3z"
                  fill="#fff"
                />
              </mask>
              <g mask="url(#vsc)">
                <path
                  d="M96.461 10.796L75.857.873a6.23 6.23 0 00-7.108 1.318l-67.37 61.354a4.167 4.167 0 00.006 6.146l5.487 5.018a4.163 4.163 0 005.318.27L96.47 10.87l-.009-.073z"
                  className="fill-current group-hover:fill-[#0065A9] transition-colors"
                />
                <path
                  d="M96.461 89.204L75.857 99.127a6.23 6.23 0 01-7.108-1.318L1.38 36.455a4.167 4.167 0 01.006-6.146l5.487-5.018a4.163 4.163 0 015.318-.27L96.47 89.13l-.009.073z"
                  className="fill-current group-hover:fill-[#007ACC] transition-colors"
                />
                <path
                  d="M75.857 99.127a6.226 6.226 0 01-7.108-1.318C73.952 102.61 81.25 98.28 81.25 91.667V8.333c0-6.614-7.298-10.943-12.5-6.142a6.226 6.226 0 017.108-1.318l20.604 9.923A6.25 6.25 0 01100 16.43v67.14a6.25 6.25 0 01-3.538 5.634l-20.605 9.923z"
                  className="fill-current group-hover:fill-[#1F9CF0] transition-colors"
                />
              </g>
            </svg>
            <span>VSCode</span>
          </button>
        )}
        {!isMobileCtx && cwd && (
          <button
            onClick={() => setSkillsOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Skills"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </button>
        )}
        {!isMobileCtx && cwd && (
          <button
            onClick={() => setMcpOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="MCP Servers"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M12 22v-5" />
              <path d="M9 8V2" />
              <path d="M15 8V2" />
              <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8Z" />
            </svg>
          </button>
        )}
        {!isMobileCtx && cwd && (
          <button
            onClick={() => setPermissionsOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Project permissions"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </button>
        )}
        {!isMobileCtx && <WorktreePill />}
        {!isMobileCtx && <GitBranchPill />}
        {!isMobileCtx && <GitChangesPill />}
        {!isMobileCtx && <WindowControls />}
      </div>
      <SkillsDialog open={skillsOpen} onClose={() => setSkillsOpen(false)} cwd={cwd} />
      <McpDialog
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
        cwd={cwd}
        routingId={activeSessionId}
      />
      <PermissionsDialog
        open={permissionsOpen}
        onClose={() => setPermissionsOpen(false)}
        cwd={cwd}
      />
    </div>
  )
}
