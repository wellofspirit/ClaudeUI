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
import { SCOPE_META, SCOPE_ORDER, type ServerGroup, type AddServerPayload } from './utils'

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
    const scopes: Array<{ scope: McpServerScope; needsCwd: boolean }> = [
      { scope: 'user', needsCwd: false },
      { scope: 'project', needsCwd: true },
      { scope: 'local', needsCwd: true }
    ]
    for (const { scope, needsCwd } of scopes) {
      if (needsCwd && !cwd) continue
      try {
        const cfgServers = await window.api.loadMcpServers(scope, cwd ?? undefined)
        for (const [name, config] of Object.entries(cfgServers)) {
          results.push({
            name,
            status: 'not_started',
            config,
            scope
          })
        }
      } catch {
        // Scope may not exist — fine
      }
    }

    if (cwd) {
      try {
        const disabledNames = await window.api.mcpReadDisabled(cwd)
        if (disabledNames.length > 0) {
          const disabledSet = new Set(disabledNames)
          for (const server of results) {
            if (disabledSet.has(server.name)) {
              server.status = 'disabled'
            }
          }
        }
      } catch {
        // Failed to read disabled list — leave all as not_started
      }
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

  const handleDelete = useCallback(
    async (server: McpServerInfo): Promise<void> => {
      const isEditable = server.scope && ['user', 'project', 'local'].includes(server.scope)
      if (!server.scope || !isEditable) return
      setActionLoading(server.name)
      try {
        const scope = server.scope as 'user' | 'project' | 'local'

        await window.api.removeMcpServer(scope, server.name, cwd ?? undefined)

        if (routingId) {
          try {
            const remaining = await window.api.loadMcpServers(scope, cwd ?? undefined)
            await window.api.mcpSetServers(routingId, remaining)
          } catch {
            // SDK may not be ready — server is removed from config regardless
          }
        }

        setSelected(null)
        await refreshServers()
      } catch (err) {
        console.error('Delete failed:', err)
        setActionLoading(null)
      }
    },
    [cwd, routingId, refreshServers]
  )

  const handleSubmitAddForm = useCallback(
    async (payload: AddServerPayload): Promise<{ error?: string } | void> => {
      const { name, scope, config } = payload
      const existing = await window.api.loadMcpServers(scope, cwd ?? undefined)
      if (existing[name]) {
        return { error: `Server "${name}" already exists in ${scope} scope` }
      }
      existing[name] = config
      await window.api.saveMcpServers(scope, existing, cwd ?? undefined)

      if (routingId) {
        try {
          await window.api.mcpSetServers(routingId, existing)
        } catch {
          // SDK may not be ready — server is saved to config file regardless
        }
      }

      setShowAddForm(false)
      await refreshServers()
    },
    [cwd, routingId, refreshServers]
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
