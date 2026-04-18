import { useState, useMemo } from 'react'
import type {
  McpServerInfo,
  McpServerScope,
  McpServerConnectionStatus,
  McpServerTransport,
  McpServerConfig
} from '../../../../shared/types'
import type { ServerGroup, AddServerPayload } from './utils'
import { SCOPE_META } from './utils'

export type { ServerGroup, AddServerPayload }

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

export interface McpDialogViewProps {
  servers: McpServerInfo[]
  filteredServers: McpServerInfo[]
  groups: ServerGroup[]
  loading: boolean
  selected: string | null
  selectedServer: McpServerInfo | null
  filter: string
  showAddForm: boolean
  actionLoading: string | null
  hasRoutingId: boolean
  hasCwd: boolean
  onSelect: (name: string) => void
  onChangeFilter: (value: string) => void
  onOpenAddForm: () => void
  onCancelAddForm: () => void
  onSubmitAddForm: (payload: AddServerPayload) => Promise<{ error?: string } | void>
  onToggleServer: (server: McpServerInfo) => Promise<void>
  onReconnectServer: (server: McpServerInfo) => Promise<void>
  onDeleteServer: (server: McpServerInfo) => Promise<void>
  onClose: () => void
}

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

function AddServerForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void
  onSubmit: (payload: AddServerPayload) => Promise<{ error?: string } | void>
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

      const result = await onSubmit({ name: name.trim(), scope, config })
      if (result && result.error) {
        setError(result.error)
      }
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

      <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
        <button
          onClick={onCancel}
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

function ServerDetail({
  server,
  hasRoutingId,
  hasCwd,
  actionLoading,
  onToggle,
  onReconnect,
  onDelete,
}: {
  server: McpServerInfo
  hasRoutingId: boolean
  hasCwd: boolean
  actionLoading: string | null
  onToggle: (server: McpServerInfo) => Promise<void>
  onReconnect: (server: McpServerInfo) => Promise<void>
  onDelete: (server: McpServerInfo) => Promise<void>
}): React.JSX.Element {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const isActionable = hasRoutingId
  const isEditable = server.scope && ['user', 'project', 'local'].includes(server.scope)
  const isBusy = actionLoading === server.name

  const config = server.config
  const tools = server.tools ?? []

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
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

        {(isActionable || hasCwd) && (
          <div className="flex items-center gap-2">
            {isActionable && server.status !== 'not_started' && server.status !== 'pending' && (
              <button
                onClick={() => onReconnect(server)}
                disabled={isBusy}
                className="px-2.5 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-[11px] text-amber-400 font-medium transition-colors cursor-default disabled:opacity-40"
              >
                {isBusy ? 'Reconnecting...' : server.status === 'connected' ? 'Restart' : 'Reconnect'}
              </button>
            )}
            <button
              onClick={() => onToggle(server)}
              disabled={isBusy}
              className={`px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-colors cursor-default disabled:opacity-40 ${
                server.status === 'disabled' || server.status === 'not_started'
                  ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/30 text-emerald-400'
                  : 'bg-text-muted/10 hover:bg-text-muted/20 border-text-muted/20 text-text-muted'
              }`}
            >
              {server.status === 'disabled' || server.status === 'not_started' ? 'Enable' : 'Disable'}
            </button>
            {isEditable && !confirmingDelete && (
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={isBusy}
                className="px-2.5 py-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-[11px] text-red-400 font-medium transition-colors cursor-default disabled:opacity-40"
              >
                Delete
              </button>
            )}
          </div>
        )}

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

      {/* Delete confirmation popup */}
      {confirmingDelete && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 backdrop-blur-[2px] rounded-r-xl">
          <div className="bg-bg-primary border border-red-500/30 rounded-xl shadow-2xl px-5 py-4 mx-6 max-w-[320px]">
            <div className="flex items-center gap-2 mb-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400 shrink-0">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
              <h3 className="text-[13px] font-semibold text-text-primary">Delete Server</h3>
            </div>
            <p className="text-[12px] text-text-secondary mb-1">
              Are you sure you want to delete <span className="font-semibold text-text-primary">{server.name}</span>?
            </p>
            <p className="text-[11px] text-text-muted mb-4">
              This will remove it from your {server.scope} config. This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                disabled={isBusy}
                className="px-3 py-1.5 rounded-md bg-bg-secondary hover:bg-bg-hover border border-border text-[12px] text-text-secondary hover:text-text-primary transition-colors cursor-default disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={async () => { await onDelete(server); setConfirmingDelete(false) }}
                disabled={isBusy}
                className="px-3 py-1.5 rounded-md bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-[12px] text-red-400 font-medium transition-colors cursor-default disabled:opacity-40"
              >
                {isBusy ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

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

export function McpDialogView({
  servers,
  filteredServers,
  groups,
  loading,
  selected,
  selectedServer,
  filter,
  showAddForm,
  actionLoading,
  hasRoutingId,
  hasCwd,
  onSelect,
  onChangeFilter,
  onOpenAddForm,
  onCancelAddForm,
  onSubmitAddForm,
  onToggleServer,
  onReconnectServer,
  onDeleteServer,
  onClose,
}: McpDialogViewProps): React.JSX.Element {
  const connectedCount = useMemo(() => servers.filter((s) => s.status === 'connected').length, [servers])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
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
              onClick={onOpenAddForm}
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
          <div className="w-[280px] shrink-0 border-r border-border flex flex-col">
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
                  onChange={(e) => onChangeFilter(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-md bg-bg-secondary border border-border text-[12px] text-text-primary placeholder-text-muted/50 outline-none focus:border-accent/50 transition-colors"
                />
              </div>
            </div>

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
                  <div className="flex items-baseline justify-between px-1 mb-1">
                    <span className="text-[10px] font-semibold text-text-muted tracking-wider">
                      {group.label.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-text-muted/50">{group.servers.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.servers.map((server) => (
                      <ServerRow
                        key={server.name}
                        server={server}
                        selected={selected === server.name && !showAddForm}
                        onSelect={() => onSelect(server.name)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right panel */}
          {showAddForm ? (
            <AddServerForm onCancel={onCancelAddForm} onSubmit={onSubmitAddForm} />
          ) : selectedServer ? (
            <ServerDetail
              server={selectedServer}
              hasRoutingId={hasRoutingId}
              hasCwd={hasCwd}
              actionLoading={actionLoading}
              onToggle={onToggleServer}
              onReconnect={onReconnectServer}
              onDelete={onDeleteServer}
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
