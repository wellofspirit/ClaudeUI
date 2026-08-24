import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpServerConnectionStatus, McpServerInfo } from '../../../../shared/types'
import type { McpDialogViewProps } from './View'
import { SCOPE_META } from './utils'

/**
 * Mobile (viewport ≤768px) MCP UI — ADR-048's takeover + drill-down pattern.
 *
 * The desktop dialog is a fixed 920×580 box with a 280px server list beside a
 * detail pane; neither half survives a 360px phone, so this is the same data as
 * two screens:
 *
 *   List (selectedServer === null) → tap a row → Detail → "Servers" back →
 *
 * Navigation is DERIVED from the container's own `selected` state (the
 * MobileGitView contract, Decision 3): there is no local nav state to disagree
 * with it, so the container clearing the selection — after a successful remove,
 * and on close — lands the user back on the list for free.
 *
 * Two deliberate omissions relative to desktop:
 *
 *   • **Add Server.** The desktop add flow is a mid-scroll form of six-plus
 *     fields including two raw-JSON textareas (env / headers). ADR-048
 *     Decision 4 bans mid-scroll inputs on mobile, and a keyboard-safe wizard
 *     for hand-typing JSON on a phone is a feature, not chrome — servers are
 *     added from the desktop app (or by editing .mcp.json) and managed here.
 *   • **Filter.** Server lists are short (a handful per scope); the desktop
 *     filter earns its keep against a 280px column, not against a full-height
 *     phone list. Because there is no input to clear it with, this view resets
 *     the container's filter on mount — see the effect below.
 *
 * Everything else — status, config, tools, toggle/reconnect/remove — goes
 * through the SAME props the desktop view uses. This is a presentation fork.
 */

/**
 * Status → dot color / label.
 *
 * Duplicated from `View.tsx` rather than lifted, because that file must stay
 * byte-identical in this change; if it is ever touched, these and the inline
 * copies there should become one exported pair (same rule the mobile Settings
 * fork records for its search predicate).
 */
const STATUS_COLORS: Record<McpServerConnectionStatus, string> = {
  connected: 'bg-emerald-400',
  failed: 'bg-red-400',
  'needs-auth': 'bg-amber-400',
  pending: 'bg-amber-400',
  disabled: 'bg-text-muted/40',
  not_started: 'bg-text-muted/25'
}

const STATUS_LABELS: Record<McpServerConnectionStatus, string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs Auth',
  pending: 'Connecting...',
  disabled: 'Disabled',
  not_started: 'Not Started'
}

/** Tools shown before the list collapses behind a "Show all" tap. */
const TOOLS_PREVIEW = 8

/**
 * The desktop props, with ONE widening: `onSelect` also takes null, which is
 * how this view goes back to the list. `(name: string | null) => void` is
 * assignable to the desktop's `(name: string) => void`, so the container hands
 * both views the same handler and `View.tsx` stays untouched.
 */
export type McpMobileViewProps = Omit<McpDialogViewProps, 'onSelect'> & {
  onSelect: (name: string | null) => void
}

/** A server counts as "on" unless it is explicitly off for this session. */
function isEnabled(server: McpServerInfo): boolean {
  return server.status !== 'disabled' && server.status !== 'not_started'
}

/** One-line subtitle: transport, then tool count when the SDK reported any. */
function subtitleFor(server: McpServerInfo): string {
  const transport = server.config?.type ?? (server.config?.url ? 'http' : 'stdio')
  const toolCount = server.tools?.length ?? 0
  return toolCount > 0 ? `${transport} · ${toolCount} tools` : transport
}

function CrossIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }): React.JSX.Element {
  return (
    <svg
      width={dir === 'left' ? 18 : 14}
      height={dir === 'left' ? 18 : 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {dir === 'left' ? (
        <polyline points="15 18 9 12 15 6" />
      ) : (
        <polyline points="9 18 15 12 9 6" />
      )}
    </svg>
  )
}

function StatusDot({ status }: { status: McpServerConnectionStatus }): React.JSX.Element {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status] ?? STATUS_COLORS.failed}`}
    />
  )
}

/** The list row's inline enable switch — a 44px-tall tap target either side. */
function ToggleSwitch({
  server,
  busy,
  onToggle
}: {
  server: McpServerInfo
  busy: boolean
  onToggle: () => void
}): React.JSX.Element {
  const on = isEnabled(server)
  return (
    <button
      data-testid="McpMobileView.toggle"
      data-id={server.name}
      data-on={on ? 'true' : 'false'}
      role="switch"
      aria-checked={on}
      aria-label={`${on ? 'Disable' : 'Enable'} ${server.name}`}
      disabled={busy}
      onClick={onToggle}
      className="shrink-0 w-12 flex items-center justify-center border-l border-border/40 disabled:opacity-40"
    >
      <span
        className={`w-9 h-5 rounded-full relative transition-colors ${on ? 'bg-accent' : 'bg-text-muted/30'}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'left-[18px]' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

export function McpMobileView({
  servers,
  groups,
  loading,
  selectedServer,
  actionLoading,
  hasRoutingId,
  hasCwd,
  onSelect,
  onChangeFilter,
  onToggleServer,
  onReconnectServer,
  onDeleteServer,
  onClose
}: McpMobileViewProps): React.JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [showAllTools, setShowAllTools] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const clearConfirm = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = null
    setConfirmingRemove(false)
  }, [])

  // This view renders no filter input, so a filter left behind by desktop (the
  // container keeps it while the dialog stays open across a resize) would
  // silently hide servers with nothing on screen explaining why. Landing on the
  // list is NOT handled here — the container clears `selected` on close, at the
  // source, so every open starts on the list for both layouts.
  useEffect(() => {
    onChangeFilter('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  // An armed remove (and an expanded tool list) must never survive a change of
  // subject — the next screen's Remove would inherit the confirmation.
  const selectedName = selectedServer?.name ?? null
  useEffect(() => {
    clearConfirm()
    setShowAllTools(false)
  }, [selectedName, clearConfirm])

  const connectedCount = useMemo(
    () => servers.filter((s) => s.status === 'connected').length,
    [servers]
  )

  const canAct = hasRoutingId || hasCwd

  const handleRemove = useCallback(async () => {
    if (!selectedServer) return
    if (!confirmingRemove) {
      setConfirmingRemove(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmingRemove(false), 3000)
      return
    }
    clearConfirm()
    await onDeleteServer(selectedServer)
  }, [selectedServer, confirmingRemove, clearConfirm, onDeleteServer])

  // ── Detail screen ────────────────────────────────────────────────────────
  if (selectedServer) {
    const server = selectedServer
    const busy = actionLoading === server.name
    const editable = !!server.scope && ['user', 'project', 'local'].includes(server.scope)
    const canReconnect =
      hasRoutingId && server.status !== 'not_started' && server.status !== 'pending'
    const config = server.config
    const tools = server.tools ?? []
    const visibleTools = showAllTools ? tools : tools.slice(0, TOOLS_PREVIEW)
    const scopeMeta = server.scope ? (SCOPE_META[server.scope] ?? SCOPE_META.managed) : null

    return (
      <div
        data-testid="McpMobileView"
        className="fixed inset-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
      >
        <div
          className="shrink-0 flex items-center gap-1 px-3 h-12 border-b border-border"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <button
            data-testid="McpMobileView.back"
            onClick={() => onSelect(null)}
            className="flex items-center gap-1 shrink-0 -ml-1 px-1 py-2 text-text-secondary hover:text-text-primary transition-colors"
          >
            <Chevron dir="left" />
            <span className="text-[13px] font-medium">Servers</span>
          </button>
          <span className="flex-1 min-w-0 text-[13px] text-text-primary font-medium truncate text-right">
            {server.name}
          </span>
          <button
            data-testid="McpMobileView.close"
            onClick={onClose}
            className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
            title="Close"
          >
            <CrossIcon />
          </button>
        </div>

        <div
          data-testid="McpMobileView.detail"
          data-id={server.name}
          className="flex-1 overflow-y-auto px-3 py-3 space-y-4"
        >
          {/* Status */}
          <div className="space-y-1.5">
            <div
              data-testid="McpMobileView.status"
              data-status={server.status}
              className="flex items-center gap-2 text-[12px] min-w-0"
            >
              <StatusDot status={server.status} />
              <span
                className={
                  server.status === 'connected'
                    ? 'text-emerald-400'
                    : server.status === 'failed'
                      ? 'text-red-400'
                      : 'text-text-muted'
                }
              >
                {STATUS_LABELS[server.status] ?? server.status}
              </span>
              {scopeMeta && (
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${scopeMeta.color}`}
                >
                  {scopeMeta.label}
                </span>
              )}
              {server.serverInfo && (
                /* min-w-0 as well as truncate: a flex item's min-width is
                   `auto`, so overflow:hidden alone would not let a long server
                   name shrink below its content width at 360px. */
                <span className="min-w-0 truncate text-text-muted/60 text-[11px]">
                  {server.serverInfo.name} v{server.serverInfo.version}
                </span>
              )}
            </div>
            {server.error && (
              <div
                data-testid="McpMobileView.error"
                className="text-[11px] text-red-400 bg-red-400/10 rounded-md px-2.5 py-1.5 break-words"
              >
                {server.error}
              </div>
            )}
          </div>

          {/* Actions */}
          {canAct && (
            <div className="flex flex-wrap items-center gap-2">
              {canReconnect && (
                <button
                  data-testid="McpMobileView.reconnect"
                  onClick={() => {
                    // Acting on a neighbouring control is a change of intent —
                    // an armed Remove must not sit waiting behind it.
                    clearConfirm()
                    void onReconnectServer(server)
                  }}
                  disabled={busy}
                  className="px-3 py-2 rounded-md bg-amber-500/15 border border-amber-500/30 text-[12px] text-amber-400 font-medium disabled:opacity-40"
                >
                  {busy
                    ? 'Reconnecting...'
                    : server.status === 'connected'
                      ? 'Restart'
                      : 'Reconnect'}
                </button>
              )}
              <button
                data-testid="McpMobileView.detailToggle"
                onClick={() => {
                  clearConfirm()
                  void onToggleServer(server)
                }}
                disabled={busy}
                className={`px-3 py-2 rounded-md border text-[12px] font-medium disabled:opacity-40 ${
                  isEnabled(server)
                    ? 'bg-text-muted/10 border-text-muted/20 text-text-muted'
                    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                }`}
              >
                {isEnabled(server) ? 'Disable' : 'Enable'}
              </button>
              {editable && (
                /* Two-tap destructive confirm with a 3s disarm — the
                   MobileGitView.discard pattern; a phone has no hover, so a
                   modal-free arm/confirm is the safe affordance. */
                <button
                  data-testid="McpMobileView.remove"
                  data-armed={confirmingRemove ? 'true' : 'false'}
                  onClick={handleRemove}
                  onBlur={clearConfirm}
                  disabled={busy}
                  className={`px-3 py-2 rounded-md border text-[12px] disabled:opacity-40 transition-colors ${
                    confirmingRemove
                      ? 'border-red-500 bg-red-500/10 text-red-400 font-medium'
                      : 'border-border text-text-muted'
                  }`}
                >
                  {confirmingRemove ? 'Confirm remove?' : 'Remove'}
                </button>
              )}
            </div>
          )}

          {/* Config (read-only) */}
          {config && (
            <div>
              <div className="text-[10px] font-semibold text-text-muted tracking-wider mb-1.5">
                CONFIG
              </div>
              <div className="bg-bg-secondary/60 rounded-lg px-3 py-2.5 text-[11px] font-mono text-text-secondary space-y-1 break-all">
                {config.type && (
                  <div>
                    <span className="text-text-muted">type:</span> {config.type}
                  </div>
                )}
                {config.command && (
                  <div>
                    <span className="text-text-muted">command:</span> {config.command}
                  </div>
                )}
                {config.args && config.args.length > 0 && (
                  <div>
                    {/* JSON, like desktop: a joined string turns an arg that
                        itself contains a space into two. */}
                    <span className="text-text-muted">args:</span> {JSON.stringify(config.args)}
                  </div>
                )}
                {config.url && (
                  <div>
                    <span className="text-text-muted">url:</span> {config.url}
                  </div>
                )}
                {config.env && Object.keys(config.env).length > 0 && (
                  <div>
                    <span className="text-text-muted">env:</span>
                    {Object.entries(config.env).map(([k, v]) => (
                      <div key={k} className="pl-3">
                        {k}: {v.length > 20 ? v.slice(0, 8) + '...' + v.slice(-4) : v}
                      </div>
                    ))}
                  </div>
                )}
                {config.headers && Object.keys(config.headers).length > 0 && (
                  <div>
                    <span className="text-text-muted">headers:</span>
                    {Object.entries(config.headers).map(([k, v]) => (
                      <div key={k} className="pl-3">
                        {k}: {v.length > 20 ? v.slice(0, 8) + '...' : v}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tools */}
          {tools.length > 0 && (
            <div data-testid="McpMobileView.toolsList">
              <div className="text-[10px] font-semibold text-text-muted tracking-wider mb-1.5">
                TOOLS ({tools.length})
              </div>
              <div className="space-y-0.5">
                {visibleTools.map((tool) => (
                  <div
                    key={tool.name}
                    data-testid="McpMobileView.tool"
                    data-id={tool.name}
                    className="px-2 py-1.5 rounded-md bg-bg-secondary/40 min-w-0"
                  >
                    <div className="flex items-start gap-1.5 min-w-0">
                      <span className="flex-1 min-w-0 text-[11px] font-mono text-accent break-all">
                        {tool.name}
                      </span>
                      {/* Blast radius, same three markers desktop shows: this is
                          the only place the UI says a tool writes, deletes, or
                          reaches the network — dropping them on mobile would
                          make the small screen the less-informed one. */}
                      <span className="shrink-0 flex gap-1">
                        {tool.annotations?.readOnly && (
                          <span
                            data-testid="McpMobileView.toolBadge"
                            data-kind="readOnly"
                            className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400"
                          >
                            RO
                          </span>
                        )}
                        {tool.annotations?.destructive && (
                          <span
                            data-testid="McpMobileView.toolBadge"
                            data-kind="destructive"
                            className="text-[9px] px-1 py-0.5 rounded bg-red-500/10 text-red-400"
                          >
                            !
                          </span>
                        )}
                        {tool.annotations?.openWorld && (
                          <span
                            data-testid="McpMobileView.toolBadge"
                            data-kind="openWorld"
                            className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400"
                          >
                            net
                          </span>
                        )}
                      </span>
                    </div>
                    {tool.description && (
                      <div className="text-[10px] text-text-muted truncate">{tool.description}</div>
                    )}
                  </div>
                ))}
              </div>
              {tools.length > TOOLS_PREVIEW && (
                <button
                  data-testid="McpMobileView.toolsToggle"
                  onClick={() => setShowAllTools((v) => !v)}
                  className="mt-1.5 px-2 py-2 text-[11px] text-accent"
                >
                  {showAllTools ? 'Show fewer' : `Show all ${tools.length} tools`}
                </button>
              )}
            </div>
          )}

          {tools.length === 0 && server.status === 'connected' && (
            <div className="text-[11px] text-text-muted/60">No tools exposed by this server</div>
          )}
        </div>
      </div>
    )
  }

  // ── List screen ──────────────────────────────────────────────────────────
  return (
    <div
      data-testid="McpMobileView"
      className="fixed inset-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
    >
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent shrink-0"
        >
          <path d="M12 22v-5" />
          <path d="M9 8V2" />
          <path d="M15 8V2" />
          <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8Z" />
        </svg>
        <span className="flex-1 min-w-0 text-[14px] font-medium text-text-primary truncate">
          MCP servers
          {servers.length > 0 && (
            <span className="text-text-muted text-[11px] font-normal">
              {' '}
              · {connectedCount}/{servers.length} connected
            </span>
          )}
        </span>
        <button
          data-testid="McpMobileView.close"
          onClick={onClose}
          className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
          title="Close"
        >
          <CrossIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12 text-text-muted text-[13px]">
            Loading servers...
          </div>
        )}
        {!loading && groups.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center text-text-muted text-[13px]">
            <span>No MCP servers configured</span>
            <span className="text-[11px] text-text-muted/60">
              Servers are added from the desktop app or by editing .mcp.json
            </span>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.scope}>
            <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-text-muted/60">
              {group.label}
            </div>
            {group.servers.map((server) => (
              <div
                key={server.name}
                className="flex items-stretch border-b border-border/40 last:border-b-0"
              >
                <button
                  data-testid="McpMobileView.row"
                  data-id={server.name}
                  onClick={() => onSelect(server.name)}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left px-3 py-2.5 min-h-[52px]"
                >
                  <StatusDot status={server.status} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-text-primary truncate">
                      {server.name}
                    </span>
                    <span className="block text-[11px] text-text-muted truncate">
                      {subtitleFor(server)}
                    </span>
                  </span>
                  <span className="shrink-0 text-text-muted/50">
                    <Chevron dir="right" />
                  </span>
                </button>
                {canAct && (
                  <ToggleSwitch
                    server={server}
                    busy={actionLoading === server.name}
                    onToggle={() => onToggleServer(server)}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
