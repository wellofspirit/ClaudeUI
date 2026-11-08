import { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  McpServerInfo,
  McpServerScope,
  McpServerConnectionStatus,
  McpServerConfig
} from '../../../../shared/types'
import { useIsMobile } from '../../hooks/useIsMobile'
import { McpDialogView } from './View'
import { McpMobileView } from './MobileView'
import {
  SCOPE_META,
  SCOPE_ORDER,
  isRemovableScope,
  type ServerGroup,
  type AddServerPayload
} from './utils'

interface McpDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
  routingId: string | null
}

export function McpDialog({
  open,
  onClose,
  cwd,
  routingId
}: McpDialogProps): React.JSX.Element | null {
  const isMobile = useIsMobile()
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const loadFromConfig = useCallback(async (): Promise<McpServerInfo[]> => {
    const results: McpServerInfo[] = []
    try {
      // Everything a Claude session in `cwd` would load (the home dir without one),
      // labelled by source; a cold-disabled server stays listed, flagged `disabled`
      const { servers } = await window.api.loadMcpCatalog(cwd ?? undefined)
      for (const s of servers) {
        results.push({
          name: s.name,
          status: s.disabled ? 'disabled' : 'not_started',
          config: s.config,
          scope: s.source
        })
      }
    } catch {
      // Config unreadable — show whatever the live session reports
    }

    return results
  }, [cwd])

  const loadFromSdk = useCallback(async (): Promise<McpServerInfo[] | null> => {
    if (!routingId) return null
    try {
      const raw = await window.api.mcpServerStatus(routingId)
      if (!raw || !Array.isArray(raw) || raw.length === 0) return null
      const result: McpServerInfo[] = (raw as unknown as Array<Record<string, unknown>>)
        .map((entry) => ({
          name: (entry.name ?? entry.serverName ?? '') as string,
          status: (entry.status ?? 'pending') as McpServerConnectionStatus,
          serverInfo: entry.serverInfo as McpServerInfo['serverInfo'],
          error: entry.error as string | undefined,
          config: entry.config as McpServerConfig | undefined,
          scope: entry.scope as McpServerScope | undefined,
          tools: (entry.tools ?? []) as McpServerInfo['tools']
        }))
        .filter((s) => s.name)
      return result.length > 0 ? result : null
    } catch (err) {
      console.error('[McpDialog] SDK mcpServerStatus error:', err)
    }
    return null
  }, [routingId])

  const refreshServers = useCallback(async () => {
    setActionLoading(null)

    const fromConfig = await loadFromConfig()
    const fromSdk = await loadFromSdk()

    if (fromSdk && fromSdk.length > 0) {
      const configByName = new Map(fromConfig.map((s) => [s.name, s]))
      const merged = fromSdk.map((sdk) => {
        const cfg = configByName.get(sdk.name)
        const knownScope = sdk.scope && SCOPE_ORDER.includes(sdk.scope) ? sdk.scope : undefined
        return {
          ...sdk,
          scope: knownScope ?? cfg?.scope ?? 'managed',
          config: sdk.config ?? cfg?.config
        }
      })
      const sdkNames = new Set(fromSdk.map((s) => s.name))
      const extras = fromConfig.filter((s) => !sdkNames.has(s.name))
      setServers([...merged, ...extras])
    } else {
      setServers(fromConfig)
    }
  }, [loadFromConfig, loadFromSdk])

  // Load on open
  useEffect(() => {
    if (!open) return
    setLoading(true)
    refreshServers()
      .catch((err) => console.error('[McpDialog] refreshServers error:', err))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, routingId])

  // Reset on close. Selection is included: on mobile it IS the navigation state
  // (a kept selection would reopen straight into some server's detail screen
  // instead of the list), and desktop is unaffected either way — its View
  // auto-selects nothing and simply shows the empty detail pane until a row is
  // tapped, exactly as it does on a first open.
  useEffect(() => {
    if (!open) {
      setFilter('')
      setShowAddForm(false)
      setSelected(null)
    }
  }, [open])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (showAddForm) {
          setShowAddForm(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose, showAddForm])

  const filteredServers = useMemo(() => {
    if (!filter) return servers
    const q = filter.toLowerCase()
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q) ||
        (s.scope && s.scope.toLowerCase().includes(q))
    )
  }, [servers, filter])

  const groups = useMemo<ServerGroup[]>(() => {
    const map = new Map<McpServerScope, McpServerInfo[]>()
    for (const s of filteredServers) {
      const scope = s.scope ?? 'managed'
      const list = map.get(scope) || []
      list.push(s)
      map.set(scope, list)
    }
    return SCOPE_ORDER.filter((scope) => map.has(scope)).map((scope) => ({
      scope,
      label: SCOPE_META[scope]?.label ?? scope,
      servers: map.get(scope)!
    }))
  }, [filteredServers])

  const selectedServer = useMemo(
    () => servers.find((s) => s.name === selected) ?? null,
    [servers, selected]
  )

  const refreshAfterAction = useCallback(
    (delay = 800): void => {
      setTimeout(refreshServers, delay)
      setTimeout(refreshServers, delay * 2)
    },
    [refreshServers]
  )

  const handleToggle = useCallback(
    async (server: McpServerInfo): Promise<void> => {
      setActionLoading(server.name)
      try {
        const enable = server.status === 'disabled' || server.status === 'not_started'
        if (routingId) {
          await window.api.mcpToggleServer(routingId, server.name, enable)
          refreshAfterAction()
        } else if (cwd) {
          await window.api.mcpToggleDisabled(cwd, server.name, enable)
          await refreshServers()
        }
      } catch (err) {
        console.error(`[McpDialog] toggle ${server.name} FAILED:`, err)
        setActionLoading(null)
      }
    },
    [routingId, cwd, refreshAfterAction, refreshServers]
  )

  const handleReconnect = useCallback(
    async (server: McpServerInfo): Promise<void> => {
      if (!routingId) return
      setActionLoading(server.name)
      try {
        await window.api.mcpReconnectServer(routingId, server.name)
        refreshAfterAction()
      } catch (err) {
        console.error('Reconnect failed:', err)
        setActionLoading(null)
      }
    },
    [routingId, refreshAfterAction]
  )

  // A running stream-json cli.js does not watch its config files (probed 2.1.317):
  // after a native write, ask it to re-read them.
  const reloadLiveServers = useCallback(
    async (expect?: { name: string; present: boolean }): Promise<void> => {
      if (!routingId) return
      try {
        await window.api.mcpReloadServers(routingId, expect)
      } catch {
        // SDK may not be ready — the write landed in the config regardless
      }
    },
    [routingId]
  )

  const handleDelete = useCallback(
    async (server: McpServerInfo): Promise<void> => {
      if (!server.scope || !isRemovableScope(server.scope)) return
      setActionLoading(server.name)
      try {
        if (server.scope === 'claudeui') {
          // ClaudeUI's own legacy files. A live session holds these as dynamic
          // servers, but `mcp_set_servers` REPLACES the whole dynamic set, the
          // hosted claude-ui servers included, which the renderer can't rebuild.
          // So no live push: the server stops at the next session start.
          await window.api.removeMcpServer('claudeui', server.name, cwd ?? undefined)
        } else {
          const scope = server.scope as 'user' | 'project' | 'local'
          const result = await window.api.mcpCliRemove(scope, server.name, cwd ?? undefined)
          if (result.error) throw new Error(result.error)
        }
        // a legacy (dynamic) entry never leaves the live list on reload: nothing to wait for
        await reloadLiveServers(
          server.scope === 'claudeui' ? undefined : { name: server.name, present: false }
        )

        setSelected(null)
        await refreshServers()
      } catch (err) {
        console.error('Delete failed:', err)
        setActionLoading(null)
      }
    },
    [cwd, refreshServers, reloadLiveServers]
  )

  const handleSubmitAddForm = useCallback(
    async (payload: AddServerPayload): Promise<{ error?: string } | void> => {
      const { name, scope, config } = payload
      // Claude Code's own writer: right file for the scope, locked, validated
      const result = await window.api.mcpCliAdd(scope, name, config, cwd ?? undefined)
      if (result.error) return { error: result.error }

      await reloadLiveServers({ name, present: true })
      setShowAddForm(false)
      await refreshServers()
    },
    [cwd, refreshServers, reloadLiveServers]
  )

  /**
   * Selection is navigation on mobile (the MobileGitView contract): null puts
   * the phone back on the list screen. Widening the parameter here rather than
   * in `View.tsx` keeps the desktop view untouched — `(string | null) => void`
   * is assignable to the `(string) => void` it declares.
   */
  const handleSelect = useCallback((name: string | null): void => {
    setSelected(name)
    setShowAddForm(false)
  }, [])

  if (!open) return null

  // Same props, two presentations (the PermissionsDialog / SettingsDialog
  // pattern): a phone gets a fullscreen list ⇄ detail drill-down, because the
  // desktop dialog is a fixed 920×580 box with a 280px side list. Container
  // state — servers, selection, loading, every mutation — is shared verbatim.
  const View = isMobile ? McpMobileView : McpDialogView

  return (
    <View
      servers={servers}
      filteredServers={filteredServers}
      groups={groups}
      loading={loading}
      selected={selected}
      selectedServer={selectedServer}
      filter={filter}
      showAddForm={showAddForm}
      actionLoading={actionLoading}
      hasRoutingId={routingId !== null}
      hasCwd={cwd !== null}
      onSelect={handleSelect}
      onChangeFilter={setFilter}
      onOpenAddForm={() => setShowAddForm(true)}
      onCancelAddForm={() => setShowAddForm(false)}
      onSubmitAddForm={handleSubmitAddForm}
      onToggleServer={handleToggle}
      onReconnectServer={handleReconnect}
      onDeleteServer={handleDelete}
      onClose={onClose}
    />
  )
}
