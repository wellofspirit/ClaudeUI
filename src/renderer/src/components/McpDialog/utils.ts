import type { McpServerInfo, McpServerScope, McpServerConfig } from '../../../../shared/types'

export interface ServerGroup {
  scope: McpServerScope
  label: string
  servers: McpServerInfo[]
}

export interface AddServerPayload {
  name: string
  scope: 'user' | 'project' | 'local'
  config: McpServerConfig
}

export const SCOPE_ORDER: McpServerScope[] = ['user', 'project', 'local', 'managed', 'claudeai']

export const SCOPE_META: Record<McpServerScope, { label: string; color: string }> = {
  user: { label: 'User', color: 'bg-purple-500/15 text-purple-400' },
  project: { label: 'Project', color: 'bg-accent/15 text-accent' },
  local: { label: 'Local', color: 'bg-amber-500/15 text-amber-400' },
  managed: { label: 'Managed', color: 'bg-text-muted/15 text-text-muted' },
  claudeai: { label: 'Claude AI', color: 'bg-sky-500/15 text-sky-400' },
}
