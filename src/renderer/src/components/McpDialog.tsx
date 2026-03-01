import { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  McpServerInfo,
  McpServerScope,
  McpServerConnectionStatus,
  McpServerTransport,
  McpServerConfig
} from '../../../shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpDialogProps {
  open: boolean
  onClose: () => void
  cwd: string | null
  routingId: string | null
}

interface ServerGroup {
  scope: McpServerScope
  label: string
  servers: McpServerInfo[]
}

// ---------------------------------------------------------------------------
// Scope display config
// ---------------------------------------------------------------------------

const SCOPE_ORDER: McpServerScope[] = ['user', 'project', 'local', 'managed', 'claudeai']

const SCOPE_META: Record<McpServerScope, { label: string; color: string }> = {
  user: { label: 'User', color: 'bg-purple-500/15 text-purple-400' },
  project: { label: 'Project', color: 'bg-accent/15 text-accent' },
  local: { label: 'Local', color: 'bg-amber-500/15 text-amber-400' },
  managed: { label: 'Managed', color: 'bg-text-muted/15 text-text-muted' },
  claudeai: { label: 'Claude AI', color: 'bg-sky-500/15 text-sky-400' },
}

// ---------------------------------------------------------------------------
// Status dot colors
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<McpServerConnectionStatus, string> = {
  connected: 'bg-emerald-400',
  failed: 'bg-red-400',
  'needs-auth': 'bg-amber-400',
  pending: 'bg-amber-400',
  disabled: 'bg-text-muted/40',
  not_started: 'bg-text-muted/25',
}

const STATUS_LABELS: Record<McpServerConnectionStatus, string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs Auth',
  pending: 'Connecting...',
  disabled: 'Disabled',
  not_started: 'Not Started',
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScopeBadge({ scope }: { scope: McpServerScope }): React.JSX.Element {
  const meta = SCOPE_META[scope] ?? SCOPE_META.managed
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.color}`}>
      {meta.label}
    </span>
  )
}

function StatusDot({ status }: { status: McpServerConnectionStatus }): React.JSX.Element {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status] ?? STATUS_COLORS.failed}`}
      title={STATUS_LABELS[status] ?? status}
    />
  )
}

function ServerRow({
  server,
  selected,
  onSelect
}: {
  server: McpServerInfo
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const toolCount = server.tools?.length ?? 0
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-lg transition-colors cursor-default ${
        selected
          ? 'bg-accent/10 border border-accent/30'
          : 'hover:bg-bg-hover border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={server.status} />
        <span className={`text-[12px] font-medium truncate ${selected ? 'text-accent' : 'text-text-primary'}`}>
          {server.name}
        </span>
        {toolCount > 0 && (
          <span className="ml-auto text-[10px] text-text-muted/60 shrink-0">{toolCount} tools</span>
        )}
      </div>
      {server.error && (
        <div className="text-[10px] text-red-400/80 truncate mt-0.5 pl-[18px]">
          {server.error}
        </div>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Add Server Form
// ---------------------------------------------------------------------------

function AddServerForm({
  cwd,
  routingId,
  onDone
}: {
  cwd: string | null
  routingId: string | null
  onDone: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpServerTransport>('stdio')
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('project')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = name.trim() && (
    transport === 'stdio' ? command.trim() : url.trim()
  )

  const handleSave = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)

    try {
      const config: McpServerConfig = { type: transport }
      if (transport === 'stdio') {
        config.command = command.trim()
        if (args.trim()) {
          config.args = args.split('\n').map((a) => a.trim()).filter(Boolean)
        }
        if (envText.trim()) {
          try {
            config.env = JSON.parse(envText.trim())
          } catch {
            setError('Invalid env JSON')
            setSaving(false)
            return
          }
        }
      } else {
        config.url = url.trim()
        if (headersText.trim()) {
          try {
            config.headers = JSON.parse(headersText.trim())
          } catch {
            setError('Invalid headers JSON')
            setSaving(false)
            return
          }
        }
      }

      // Save to config file
      const existing = await window.api.loadMcpServers(scope, cwd ?? undefined)
      if (existing[name.trim()]) {
        setError(`Server "${name.trim()}" already exists in ${scope} scope`)
        setSaving(false)
        return
      }
      existing[name.trim()] = config
      await window.api.saveMcpServers(scope, existing, cwd ?? undefined)

      // Notify SDK if session is active
      if (routingId) {
        try {
          await window.api.mcpSetServers(routingId, existing)
        } catch {
          // SDK may not be ready — server is saved to config file regardless
        }
      }

      onDone()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-2.5 py-1.5 rounded-md bg-bg-secondary border border-border text-[12px] text-text-primary placeholder-text-muted/50 outline-none focus:border-accent/50 transition-colors'
  const labelCls = 'text-[11px] text-text-secondary font-medium mb-1'

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
      <div className="shrink-0 px-5 py-3 border-b border-border">
        <h2 className="text-[14px] font-semibold text-text-primary">Add MCP Server</h2>
        <p className="text-[11px] text-text-muted mt-0.5">Configure a new MCP server connection</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Name */}
        <div>
          <label className={labelCls}>Server Name</label>
          <input
            type="text"
            placeholder="my-server"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            autoFocus
          />
        </div>

        {/* Scope */}
        <div>
          <label className={labelCls}>Scope</label>
          <div className="flex gap-1.5">
            {(['project', 'user', 'local'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-default ${
                  scope === s
                    ? 'bg-accent/20 text-accent border border-accent/30'
                    : 'bg-bg-secondary text-text-muted border border-border hover:bg-bg-hover'
                }`}
              >
                {s === 'project' ? 'Project' : s === 'user' ? 'User (Global)' : 'Local'}
              </button>
            ))}
          </div>
        </div>

        {/* Transport type */}
        <div>
          <label className={labelCls}>Transport</label>
          <div className="flex gap-1.5">
            {(['stdio', 'sse', 'http'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTransport(t)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-default ${
                  transport === t
                    ? 'bg-accent/20 text-accent border border-accent/30'
                    : 'bg-bg-secondary text-text-muted border border-border hover:bg-bg-hover'
                }`}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Transport-specific fields */}
        {transport === 'stdio' ? (
          <>
            <div>
              <label className={labelCls}>Command</label>
              <input
                type="text"
                placeholder="npx"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Arguments (one per line)</label>
              <textarea
                placeholder={'-y\n@modelcontextprotocol/server-github'}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none font-mono`}
              />
            </div>
            <div>
              <label className={labelCls}>Environment Variables (JSON)</label>
              <textarea
                placeholder={'{\n  "GITHUB_TOKEN": "ghp_..."\n}'}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none font-mono`}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className={labelCls}>URL</label>
              <input
                type="text"
                placeholder="https://mcp.example.com/sse"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Headers (JSON)</label>
              <textarea
                placeholder={'{\n  "Authorization": "Bearer ..."\n}'}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={3}
                className={`${inputCls} resize-none font-mono`}
              />
            </div>
          </>
        )}

        {error && (
          <div className="text-[11px] text-red-400 bg-red-400/10 rounded-md px-3 py-2">
            {error}
          </div>
        )}
      </div>

      {/* Form footer */}
      <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
        <button
          onClick={onDone}
          className="px-3 py-1.5 rounded-md bg-bg-secondary hover:bg-bg-hover border border-border text-[12px] text-text-secondary hover:text-text-primary transition-colors cursor-default"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="px-3 py-1.5 rounded-md bg-accent/20 hover:bg-accent/30 border border-accent/30 text-[12px] text-accent font-medium transition-colors cursor-default disabled:opacity-40 disabled:pointer-events-none"
        >
          {saving ? 'Adding...' : 'Add Server'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Server detail / right panel
// ---------------------------------------------------------------------------

function ServerDetail({
  server,
  routingId,
  cwd,
  onRefresh,
  actionLoading,
  setActionLoading
}: {
  server: McpServerInfo
  routingId: string | null
  cwd: string | null
  onRefresh: () => void
  actionLoading: string | null
  setActionLoading: (name: string | null) => void
}): React.JSX.Element {
  const isActionable = routingId !== null
  const isEditable = server.scope && ['user', 'project', 'local'].includes(server.scope)
  const isBusy = actionLoading === server.name

  const refreshAfterAction = useCallback((delay = 800): void => {
    // Refresh after a delay to let the SDK process the change, then again for safety
    setTimeout(onRefresh, delay)
    setTimeout(onRefresh, delay * 2)
  }, [onRefresh])

  const handleToggle = async (): Promise<void> => {
    if (!routingId) return
    setActionLoading(server.name)
    try {
      const enable = server.status === 'disabled' || server.status === 'not_started'
      console.log(`[McpDialog] toggle ${server.name}: status=${server.status} → enable=${enable}`)
      await window.api.mcpToggleServer(routingId, server.name, enable)
      console.log(`[McpDialog] toggle ${server.name}: IPC call completed`)
      refreshAfterAction()
    } catch (err) {
      console.error(`[McpDialog] toggle ${server.name} FAILED:`, err)
      setActionLoading(null)
    }
  }

  const handleReconnect = async (): Promise<void> => {
    if (!routingId) return
    setActionLoading(server.name)
    try {
      console.log(`[McpDialog] reconnect ${server.name}`)
      await window.api.mcpReconnectServer(routingId, server.name)
      refreshAfterAction()
    } catch (err) {
      console.error('Reconnect failed:', err)
      setActionLoading(null)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!server.scope || !isEditable) return
    try {
      const existing = await window.api.loadMcpServers(
        server.scope as 'user' | 'project' | 'local',
        cwd ?? undefined
      )
      delete existing[server.name]
      await window.api.saveMcpServers(
        server.scope as 'user' | 'project' | 'local',
        existing,
        cwd ?? undefined
      )
      onRefresh()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  const config = server.config
  const tools = server.tools ?? []

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="shrink-0 px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2.5 mb-1.5">
          <h2 className="text-[14px] font-semibold text-text-primary">{server.name}</h2>
          {server.scope && <ScopeBadge scope={server.scope} />}
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <StatusDot status={server.status} />
          <span className={server.status === 'connected' ? 'text-emerald-400' : server.status === 'failed' ? 'text-red-400' : 'text-text-muted'}>
            {STATUS_LABELS[server.status] ?? server.status}
          </span>
          {server.serverInfo && (
            <span className="text-text-muted/60">
              {server.serverInfo.name} v{server.serverInfo.version}
            </span>
          )}
        </div>
        {server.error && (
          <div className="mt-1.5 text-[11px] text-red-400 bg-red-400/10 rounded-md px-2.5 py-1.5">
            {server.error}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Config section */}
        {config && (
          <div>
            <div className="text-[10px] font-semibold text-text-muted tracking-wider mb-1.5">CONFIG</div>
            <div className="bg-bg-secondary/60 rounded-lg px-3 py-2.5 text-[11px] font-mono text-text-secondary space-y-1">
              {config.type && <div><span className="text-text-muted">type:</span> {config.type}</div>}
              {config.command && <div><span className="text-text-muted">command:</span> {config.command}</div>}
              {config.args && config.args.length > 0 && (
                <div><span className="text-text-muted">args:</span> {JSON.stringify(config.args)}</div>
              )}
              {config.url && <div><span className="text-text-muted">url:</span> {config.url}</div>}
              {config.env && Object.keys(config.env).length > 0 && (
                <div>
                  <span className="text-text-muted">env:</span>
                  {Object.entries(config.env).map(([k, v]) => (
                    <div key={k} className="pl-3">{k}: {v.length > 20 ? v.slice(0, 8) + '...' + v.slice(-4) : v}</div>
                  ))}
                </div>
              )}
              {config.headers && Object.keys(config.headers).length > 0 && (
                <div>
                  <span className="text-text-muted">headers:</span>
                  {Object.entries(config.headers).map(([k, v]) => (
                    <div key={k} className="pl-3">{k}: {v.length > 20 ? v.slice(0, 8) + '...' : v}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        {isActionable && (
          <div className="flex items-center gap-2">
            {server.status !== 'not_started' && server.status !== 'pending' && (
              <button
                onClick={handleReconnect}
                disabled={isBusy}
                className="px-2.5 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-[11px] text-amber-400 font-medium transition-colors cursor-default disabled:opacity-40"
              >
                {isBusy ? 'Reconnecting...' : server.status === 'connected' ? 'Restart' : 'Reconnect'}
              </button>
            )}
            <button
              onClick={handleToggle}
              disabled={isBusy}
              className={`px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-colors cursor-default disabled:opacity-40 ${
                server.status === 'disabled' || server.status === 'not_started'
                  ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/30 text-emerald-400'
                  : 'bg-text-muted/10 hover:bg-text-muted/20 border-text-muted/20 text-text-muted'
              }`}
            >
              {server.status === 'disabled' || server.status === 'not_started' ? 'Enable' : 'Disable'}
            </button>
            {isEditable && (
              <button
                onClick={handleDelete}
                disabled={isBusy}
                className="px-2.5 py-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-[11px] text-red-400 font-medium transition-colors cursor-default disabled:opacity-40"
              >
                Delete
              </button>
            )}
          </div>
        )}

        {/* Tools section */}
        {tools.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold text-text-muted tracking-wider mb-1.5">
              TOOLS ({tools.length})
            </div>
            <div className="space-y-0.5">
              {tools.map((tool) => (
                <div key={tool.name} className="flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-bg-hover/50">
                  <span className="text-[11px] font-mono text-accent shrink-0">{tool.name}</span>
                  {tool.description && (
                    <span className="text-[10px] text-text-muted truncate">{tool.description}</span>
                  )}
                  <div className="ml-auto flex gap-1 shrink-0">
                    {tool.annotations?.readOnly && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400">RO</span>
                    )}
                    {tool.annotations?.destructive && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/10 text-red-400">!</span>
                    )}
                    {tool.annotations?.openWorld && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400">net</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tools.length === 0 && server.status === 'connected' && (
          <div className="text-[11px] text-text-muted/60">No tools exposed by this server</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyDetail(): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-text-muted">
      <div className="text-center">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2 opacity-40">
          <path d="M12 22v-5" />
          <path d="M9 8V2" />
          <path d="M15 8V2" />
          <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8Z" />
        </svg>
        <p className="text-[12px]">Select a server to view details</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function McpDialog({ open, onClose, cwd, routingId }: McpDialogProps): React.JSX.Element | null {
  console.log('[McpDialog] render', { open, cwd, routingId })
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Build server list from config files (no session required)
  const loadFromConfig = useCallback(async (): Promise<McpServerInfo[]> => {
    const results: McpServerInfo[] = []
    const scopes: Array<{ scope: McpServerScope; needsCwd: boolean }> = [
      { scope: 'user', needsCwd: false },
      { scope: 'project', needsCwd: true },
      { scope: 'local', needsCwd: true },
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
            scope,
          })
        }
      } catch {
        // Scope may not exist — fine
      }
    }
    return results
  }, [cwd])

  // Fetch live status from SDK, enriching servers with full info
  const loadFromSdk = useCallback(async (): Promise<McpServerInfo[] | null> => {
    if (!routingId) return null
    try {
      const raw = await window.api.mcpServerStatus(routingId)
      console.log('[McpDialog] SDK mcpServerStatus raw:', JSON.stringify(raw, null, 2))
      if (!raw || !Array.isArray(raw) || raw.length === 0) return null
      // Normalize SDK response — the SDK may return objects with different field names
      // or shapes than our McpServerInfo. Map them defensively.
      const result: McpServerInfo[] = (raw as unknown as Array<Record<string, unknown>>).map((entry) => ({
        name: (entry.name ?? entry.serverName ?? '') as string,
        status: (entry.status ?? 'pending') as McpServerConnectionStatus,
        serverInfo: entry.serverInfo as McpServerInfo['serverInfo'],
        error: entry.error as string | undefined,
        config: entry.config as McpServerConfig | undefined,
        scope: entry.scope as McpServerScope | undefined,
        tools: (entry.tools ?? []) as McpServerInfo['tools'],
      })).filter((s) => s.name) // drop entries without a name
      console.log('[McpDialog] SDK normalized:', JSON.stringify(result.map(s => ({ name: s.name, status: s.status, tools: s.tools?.length })), null, 2))
      return result.length > 0 ? result : null
    } catch (err) {
      console.error('[McpDialog] SDK mcpServerStatus error:', err)
    }
    return null
  }, [routingId])

  // Primary load: always start with config files, then overlay SDK status
  const refreshServers = useCallback(async () => {
    setActionLoading(null)

    // Step 1: Load static config from files
    const fromConfig = await loadFromConfig()
    console.log('[McpDialog] fromConfig:', fromConfig.map(s => s.name))

    // Step 2: Try to get live status from SDK
    const fromSdk = await loadFromSdk()
    console.log('[McpDialog] fromSdk:', fromSdk?.map(s => ({ name: s.name, status: s.status })) ?? null)

    if (fromSdk && fromSdk.length > 0) {
      // SDK returned live data — merge with config for scope/config info
      const configByName = new Map(fromConfig.map((s) => [s.name, s]))
      const merged = fromSdk.map((sdk) => {
        const cfg = configByName.get(sdk.name)
        // SDK returns scope: "dynamic" for servers passed via mcpServers option.
        // Prefer the config file's scope (user/project/local) since that's the real origin.
        const knownScope = sdk.scope && SCOPE_ORDER.includes(sdk.scope) ? sdk.scope : undefined
        return {
          ...sdk,
          scope: knownScope ?? cfg?.scope ?? 'managed',
          config: sdk.config ?? cfg?.config,
        }
      })
      // Also include config-only servers not in SDK response
      const sdkNames = new Set(fromSdk.map((s) => s.name))
      const extras = fromConfig.filter((s) => !sdkNames.has(s.name))
      setServers([...merged, ...extras])
    } else {
      // No SDK data — show config-only servers
      setServers(fromConfig)
    }
  }, [loadFromConfig, loadFromSdk])

  // Load on open
  useEffect(() => {
    console.log('[McpDialog] useEffect fired', { open, routingId })
    if (!open) return
    console.log('[McpDialog] calling refreshServers...')
    setLoading(true)
    refreshServers().catch(err => console.error('[McpDialog] refreshServers error:', err)).finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, routingId])

  // Reset on close
  useEffect(() => {
    if (!open) {
      setFilter('')
      setShowAddForm(false)
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

  // Filtered servers
  const filteredServers = useMemo(() => {
    if (!filter) return servers
    const q = filter.toLowerCase()
    return servers.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.status.toLowerCase().includes(q) ||
      (s.scope && s.scope.toLowerCase().includes(q))
    )
  }, [servers, filter])

  // Group by scope
  const groups = useMemo<ServerGroup[]>(() => {
    const map = new Map<McpServerScope, McpServerInfo[]>()
    for (const s of filteredServers) {
      const scope = s.scope ?? 'managed'
      const list = map.get(scope) || []
      list.push(s)
      map.set(scope, list)
    }
    return SCOPE_ORDER
      .filter((scope) => map.has(scope))
      .map((scope) => ({
        scope,
        label: SCOPE_META[scope]?.label ?? scope,
        servers: map.get(scope)!,
      }))
  }, [filteredServers])

  // Selected server object
  const selectedServer = useMemo(
    () => servers.find((s) => s.name === selected) ?? null,
    [servers, selected]
  )

  const connectedCount = servers.filter((s) => s.status === 'connected').length

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() },
    [onClose]
  )

  const handleAddDone = useCallback(() => {
    setShowAddForm(false)
    refreshServers()
  }, [refreshServers])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-bg-primary border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 920, height: 580, maxHeight: '85vh', maxWidth: '95vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <path d="M12 22v-5" />
              <path d="M9 8V2" />
              <path d="M15 8V2" />
              <path d="M18 8v5a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V8Z" />
            </svg>
            <span className="text-[14px] font-medium text-text-primary">MCP Servers</span>
            <span className="text-[11px] text-text-muted">
              {connectedCount}/{servers.length} connected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent/15 hover:bg-accent/25 border border-accent/30 text-[11px] text-accent font-medium transition-colors cursor-default"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add Server
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body: dual panels */}
        <div className="flex-1 flex min-h-0">
          {/* Left panel: server list */}
          <div className="w-[280px] shrink-0 border-r border-border flex flex-col">
            {/* Filter input */}
            <div className="px-3 py-2.5 border-b border-border">
              <div className="relative">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  placeholder="Filter servers..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-md bg-bg-secondary border border-border text-[12px] text-text-primary placeholder-text-muted/50 outline-none focus:border-accent/50 transition-colors"
                />
              </div>
            </div>

            {/* Scrollable list */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
              {loading && (
                <div className="flex items-center justify-center py-8 text-text-muted text-[12px]">
                  Loading servers...
                </div>
              )}
              {!loading && groups.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 text-text-muted text-[12px] text-center px-4 gap-2">
                  <span>{filter ? 'No matching servers' : 'No MCP servers configured'}</span>
                  {!filter && (
                    <span className="text-[10px] text-text-muted/60">
                      Click &ldquo;Add Server&rdquo; to configure one
                    </span>
                  )}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.scope}>
                  {/* Group header */}
                  <div className="flex items-baseline justify-between px-1 mb-1">
                    <span className="text-[10px] font-semibold text-text-muted tracking-wider">
                      {group.label.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-text-muted/50">{group.servers.length}</span>
                  </div>
                  {/* Server rows */}
                  <div className="space-y-0.5">
                    {group.servers.map((server) => (
                      <ServerRow
                        key={server.name}
                        server={server}
                        selected={selected === server.name && !showAddForm}
                        onSelect={() => { setSelected(server.name); setShowAddForm(false) }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right panel: detail or add form */}
          {showAddForm ? (
            <AddServerForm cwd={cwd} routingId={routingId} onDone={handleAddDone} />
          ) : selectedServer ? (
            <ServerDetail
              server={selectedServer}
              routingId={routingId}
              cwd={cwd}
              onRefresh={refreshServers}
              actionLoading={actionLoading}
              setActionLoading={setActionLoading}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-5 py-2.5 border-t border-border text-[11px] text-text-muted">
          <span>
            {servers.length} server{servers.length !== 1 ? 's' : ''} total
            {filter && filteredServers.length !== servers.length && (
              <span> &middot; {filteredServers.length} shown</span>
            )}
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded-md bg-bg-secondary hover:bg-bg-hover border border-border text-text-secondary hover:text-text-primary transition-colors cursor-default"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
