import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { useSidebarCollapsed } from '../../SessionView'
import { WindowControls } from '../../WindowControls'
import { WorktreePill } from '../../git/WorktreePill'
import { GitBranchPill } from '../../git/GitBranchPill'
import { GitChangesPill } from '../../git/GitChangesPill'
import { PermissionsDialog } from '../../PermissionsDialog'
import { SkillsDialog } from '../../SkillsDialog'
import { McpDialog } from '../../McpDialog'
import { EngineLogo } from '../../shared/EngineLogo'
import { toggleTerminalPanel } from '../../terminal/toggle-terminal'
import { useTerminalAvailability } from '../../terminal/terminal-availability'
import { shortModelName } from '../../usage/usage-utils'

/** Format a millisecond duration as "Ns", "Nm Ns", or "Nh Nm" — seconds drop
 *  out at the hour scale where they're noise. Shared by the Session time /
 *  API time tooltip rows. */
function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60000)}m`
}

/** Format a cost figure consistently with the existing Cost/breakdown rows. */
function formatCost(costUsd: number): string {
  return `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`
}

/**
 * Display label for a dispatched (cross-engine, Slice C) cost row. Reuses
 * shortModelName — it already recognizes Claude family names anywhere in the
 * id, so a dispatched Claude target (e.g. "anthropic/claude-opus-4-6") comes
 * back clean. For a non-Claude id shortModelName can't shorten (e.g. an
 * opencode "providerID/modelID" target like "openai/gpt-5-codex"), it returns
 * the raw string unchanged (by design — see its own doc comment) — strip the
 * redundant provider prefix here instead of teaching shortModelName about
 * dispatch-only id shapes.
 */
function dispatchedModelLabel(modelId: string): string {
  const short = shortModelName(modelId)
  const slash = short.indexOf('/')
  return slash === -1 ? short : short.slice(slash + 1)
}

export function TopBar({ hasContent }: { hasContent: boolean }): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const sdkSessionId = useActiveSession((s) => s.status.sessionId)
  const statusLine = useActiveSession((s) => s.statusLine)
  const fallbackCost = useActiveSession((s) => s.status.totalCostUsd)
  const engineId = useActiveSession((s) => s.status.engineId)
  const canUseMcp = useActiveSession((s) => s.status.capabilities.canUseMcp)
  const capSkills = useActiveSession((s) => s.status.capabilities.skills)
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
  const terminalAvailability = useTerminalAvailability()
  // Tooltip text only. `window.api.platform` is 'web' for every host OS, so the
  // UA hint is the only signal a browser client has about its keyboard. Both
  // bindings work everywhere regardless — this just names the reachable one.
  const isMacKeyboard =
    isMac || (window.api.platform === 'web' && /mac/i.test(navigator.platform ?? ''))
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [infoHover, setInfoHover] = useState(false)
  const infoLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)

  /**
   * Mobile overflow ("⋯") menu contents. The desktop right-side buttons don't
   * fit a phone bar, so the ones that still make sense there live behind this
   * menu, in the same left-to-right order the desktop bar shows them. Each
   * entry carries EXACTLY the gate its desktop button uses (Skills: capSkills;
   * MCP: canUseMcp && engineId==='claude' — see the desktop button's comment
   * for why the engine scope is load-bearing), so the two surfaces can never
   * disagree about what this session can do. An empty list hides the ⋯ button
   * entirely rather than opening an empty popover.
   */
  const overflowItems = useMemo(() => {
    if (!cwd) return []
    const items: Array<{
      id: string
      label: string
      testId: string
      icon: React.JSX.Element
      onSelect: () => void
    }> = []
    // Terminal leads, matching the desktop bar's left-to-right order. Its gate
    // is the desktop button's, verbatim — the host's own availability answer
    // (`allowed === true`, so a null "still asking" renders nothing). The extra
    // condition it inherits from this menu is `cwd`, and it is load-bearing:
    // with no active directory, toggle-terminal.ts opens the panel but creates
    // nothing, so a phone would land in the empty state whose `+` button spawns
    // into TerminalPanel's `cwd || '.'` fallback — an invisible orphan pty with
    // no second entry point to reach it from afterwards.
    if (terminalAvailability?.allowed === true) {
      items.push({
        id: 'terminal',
        label: 'Terminal',
        testId: 'TopBar.overflowMenuTerminal',
        icon: (
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
            <path d="M4 17l6-6-6-6" />
            <path d="M12 19h8" />
          </svg>
        ),
        // The same single source of truth the desktop button and the keybinding
        // call — the takeover opens off `terminalPanelOpen` like the panel does.
        onSelect: toggleTerminalPanel
      })
    }
    if (capSkills) {
      items.push({
        id: 'skills',
        label: 'Skills',
        testId: 'TopBar.overflowMenuSkills',
        icon: (
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
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        ),
        onSelect: () => setSkillsOpen(true)
      })
    }
    if (canUseMcp && engineId === 'claude') {
      items.push({
        id: 'mcp',
        label: 'MCP Servers',
        testId: 'TopBar.overflowMenuMcp',
        icon: (
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
        ),
        onSelect: () => setMcpOpen(true)
      })
    }
    items.push({
      id: 'permissions',
      label: 'Permissions',
      testId: 'TopBar.overflowMenuPermissions',
      icon: (
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
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      onSelect: () => setPermissionsOpen(true)
    })
    return items
  }, [cwd, capSkills, canUseMcp, engineId, terminalAvailability])

  // Dismiss on outside pointerdown / Escape. pointerdown (not click) so a tap
  // that starts outside never lands on whatever the menu was covering.
  useEffect(() => {
    if (!overflowOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOverflowOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overflowOpen])

  const infoMouseEnter = useCallback(() => {
    if (infoLeaveTimer.current) clearTimeout(infoLeaveTimer.current)
    setInfoHover(true)
  }, [])
  const infoMouseLeave = useCallback(() => {
    infoLeaveTimer.current = setTimeout(() => setInfoHover(false), 150)
  }, [])

  const displaySessionId = sdkSessionId || activeSessionId
  const cost = statusLine ? statusLine.totalCostUsd : fallbackCost
  const totalDurationMs = statusLine?.totalDurationMs ?? 0
  const totalApiDurationMs = statusLine?.totalApiDurationMs ?? 0
  const turnStartedAtMs = statusLine?.turnStartedAtMs ?? null
  const rawModelCosts = statusLine?.modelCosts ?? []
  // A single-model session's breakdown is redundant with the headline Cost
  // figure — only show it when there's actually more than one line, or a
  // dispatched (cross-engine, Slice C) row is present.
  const showCostBreakdown = rawModelCosts.length >= 2 || rawModelCosts.some((m) => m.dispatched)
  const sortedModelCosts = showCostBreakdown
    ? [...rawModelCosts].sort((a, b) => b.costUsd - a.costUsd)
    : []
  // "Total incl. dispatched" (Slice C): headline own-engine cost + dispatched
  // spend, NEVER sum(breakdown rows) — the headline is the authoritative
  // own-engine figure, so summing rows instead could disagree with it if a
  // per-model recompute ever drifts from the engine's own cumulative total.
  const hasDispatchedCost = rawModelCosts.some((m) => m.dispatched)
  const dispatchedCostUsd = rawModelCosts
    .filter((m) => m.dispatched)
    .reduce((acc, m) => acc + m.costUsd, 0)
  const totalInclDispatchedUsd = cost + dispatchedCostUsd

  // Tick every second while the tooltip is open and a turn is in flight, so
  // "Session time" keeps counting up live instead of freezing until the next
  // status-line event.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!infoHover || !turnStartedAtMs) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [infoHover, turnStartedAtMs])

  const sessionDurationMs =
    totalDurationMs + (turnStartedAtMs ? Math.max(0, now - turnStartedAtMs) : 0)

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
      data-testid="TopBar"
      className="shrink-0 h-12 flex items-center justify-between [-webkit-app-region:drag] border-b border-border relative"
    >
      <div className="flex items-center min-w-0">
        {/* Mobile: always show hamburger + new session */}
        {isMobileCtx && (
          <div className="[-webkit-app-region:no-drag] flex items-center gap-1 mr-2">
            <button
              data-testid="TopBar.toggleSidebar"
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
              data-testid="TopBar.newSession"
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
              data-testid="TopBar.toggleSidebar"
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
              data-testid="TopBar.newSession"
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
          data-testid="TopBar.info"
          className="flex items-center min-w-0 [-webkit-app-region:no-drag] relative"
          onMouseEnter={infoMouseEnter}
          onMouseLeave={infoMouseLeave}
        >
          <span className="flex items-center gap-1 text-[13px] text-text-secondary font-normal truncate cursor-default">
            {cwd && hasContent && engineId && engineId !== 'claude' && (
              <EngineLogo engineId={engineId} size={11} className="shrink-0 opacity-75" />
            )}
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
                    {(cost > 0 ||
                      hasDispatchedCost ||
                      sessionDurationMs > 0 ||
                      totalApiDurationMs > 0) && (
                      <div className="flex gap-4">
                        {(cost > 0 || hasDispatchedCost) && (
                          <div>
                            <div className="text-[10px] text-text-muted mb-0.5">Cost</div>
                            <div className="text-[11px] text-text-secondary font-mono">
                              ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}
                            </div>
                            {showCostBreakdown && (
                              <div data-testid="TopBar.costBreakdown" className="mt-1 space-y-0.5">
                                {sortedModelCosts.map((m) => (
                                  <div
                                    key={`${m.engineId}:${m.modelId}`}
                                    data-testid="TopBar.costBreakdownRow"
                                    data-model={m.modelId}
                                    {...(m.dispatched ? { 'data-dispatched': 'true' } : {})}
                                    className="flex items-center justify-between gap-3"
                                  >
                                    <span className="text-[10px] text-text-muted truncate">
                                      {m.dispatched
                                        ? `${dispatchedModelLabel(m.modelId)} · dispatched`
                                        : shortModelName(m.modelId)}
                                    </span>
                                    <span className="text-[10px] text-text-secondary font-mono shrink-0">
                                      {formatCost(m.costUsd)}
                                    </span>
                                  </div>
                                ))}
                                {hasDispatchedCost && (
                                  <div
                                    data-testid="TopBar.costTotalInclDispatched"
                                    className="flex items-center justify-between gap-3 pt-0.5 mt-0.5 border-t border-border/50"
                                  >
                                    <span className="text-[10px] text-text-muted truncate">
                                      Total incl. dispatched
                                    </span>
                                    <span className="text-[10px] text-text-secondary font-mono shrink-0">
                                      {formatCost(totalInclDispatchedUsd)}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {sessionDurationMs > 0 && (
                          <div data-testid="TopBar.sessionTime">
                            <div className="text-[10px] text-text-muted mb-0.5">Session time</div>
                            <div className="text-[11px] text-text-secondary font-mono">
                              {formatDuration(sessionDurationMs)}
                            </div>
                          </div>
                        )}
                        {totalApiDurationMs > 0 && (
                          <div data-testid="TopBar.apiTime">
                            <div className="text-[10px] text-text-muted mb-0.5">API time</div>
                            <div className="text-[11px] text-text-secondary font-mono">
                              {formatDuration(totalApiDurationMs)}
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
            data-testid="TopBar.openVSCode"
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
        {/* The only *visible* way into the terminal panel. The Ctrl/Cmd+` and
            Alt+` keybindings stay, but Ctrl/Cmd+` is unreachable in a browser
            (macOS owns Cmd+`, Edge swallows Ctrl+`), so web needs a button.
            Gated on the host's own answer: on desktop the hook resolves
            "allowed" synchronously with no IPC (the remote toggle governs
            remote access, never the local shell), while on web the button only
            appears once `terminal:availability` says yes — no affordance for a
            shell this client cannot get. Null (web, first query in flight)
            renders nothing: appearing a beat late beats flashing out. The panel
            re-asks the same question itself — defense in depth. Mobile reaches
            the same helper from the ⋯ menu (the bar has no room for it), which
            carries this exact gate. */}
        {!isMobileCtx && terminalAvailability?.allowed === true && (
          <button
            data-testid="TopBar.terminal"
            onClick={toggleTerminalPanel}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title={isMacKeyboard ? 'Terminal (⌥`)' : 'Terminal (Ctrl+`)'}
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
              <path d="M4 17l6-6-6-6" />
              <path d="M12 19h8" />
            </svg>
          </button>
        )}
        {!isMobileCtx && cwd && capSkills && (
          <button
            data-testid="TopBar.skills"
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
        {/* MCP config dialog manages Claude's .mcp.json servers — Claude-native
            config, not "hosted tools". Scoped to engineId==='claude' so flipping
            opencode's hostedMcp capability (Phase 5c, for our injected plugin
            tools) does NOT surface this Claude-only config UI for opencode. */}
        {!isMobileCtx && cwd && canUseMcp && engineId === 'claude' && (
          <button
            data-testid="TopBar.mcp"
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
            data-testid="TopBar.permissions"
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
        {/* Mobile keeps the changes pill — it doubles as the git-panel entry
            point (MobileGitView) and self-hides outside a git repo. */}
        <GitChangesPill />
        {!isMobileCtx && <WindowControls />}
        {/* The dropdown below deliberately has no positioned wrapper: it anchors
            to the TopBar itself (the nearest positioned ancestor), so it hangs
            below the whole bar right-aligned instead of mid-bar off the button. */}
        {isMobileCtx && overflowItems.length > 0 && (
          <div ref={overflowRef}>
            <button
              data-testid="TopBar.overflowMenu"
              onClick={() => setOverflowOpen((o) => !o)}
              className="w-[30px] h-[30px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="More"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
            {overflowOpen && (
              <div className="absolute top-full right-0 mt-1 z-50 min-w-[180px] bg-bg-primary border border-border rounded-lg shadow-lg py-1 animate-fade-in">
                {overflowItems.map((item) => (
                  <button
                    key={item.id}
                    data-testid={item.testId}
                    onClick={() => {
                      setOverflowOpen(false)
                      item.onSelect()
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] text-text-secondary hover:bg-bg-hover transition-colors"
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
