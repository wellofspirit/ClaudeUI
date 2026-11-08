/**
 * Layer 2: Component tests for McpDialog FC.
 *
 * The FC loads the cold list from the catalog (source-labelled) + the live SDK
 * status, and routes toggle/reconnect/delete/add. We mock the View to capture props.
 *
 * Tested flows:
 *   1. the cold list comes from `mcp:load-catalog`, grouped by source
 *   2. a live entry keeps priority but takes the catalog's source for `dynamic`
 *   3. onToggleServer (with routingId) → mcpToggleServer IPC
 *   4. onToggleServer (no routingId) → mcpToggleDisabled by the Claude name (plugin:p:s)
 *   5. onReconnectServer → mcpReconnectServer IPC
 *   6. onDeleteServer: native scope → `claude mcp remove` (+ live reload); legacy → file
 *      removal (no live set push: it would drop the hosted servers); plugin/managed → refused
 *   7. onSubmitAddForm → `claude mcp add-json` (cli.js's error text surfaced, no push)
 *   8. filter prop flows through
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { McpDialogViewProps } from '../View'
import type { McpServerConfig, McpServerInfo } from '../../../../../shared/types'

let viewProps: McpDialogViewProps
vi.mock('../View', () => ({
  McpDialogView: (props: McpDialogViewProps) => {
    viewProps = props
    return null
  }
}))

const CWD = '/d/repo'
const ROUTING_ID = 'route-mcp'

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { type: 'stdio', command: 'npx', ...overrides }
}

// The desktop label, the mobile switch and both toggle writes share this predicate: a cold
// `not_started` row is an ENABLED server (its button reads "Disable"), never "off".
describe('isServerEnabled', () => {
  it('is off only for an explicitly disabled server', async () => {
    const { isServerEnabled } = await import('../utils')
    expect(isServerEnabled({ status: 'disabled' })).toBe(false)
    expect(isServerEnabled({ status: 'not_started' })).toBe(true)
    expect(isServerEnabled({ status: 'connected' })).toBe(true)
    expect(isServerEnabled({ status: 'failed' })).toBe(true)
  })
})

describe('McpDialog FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let catalog: Array<{ name: string; source: string; config: McpServerConfig }>
  let statusResult: unknown
  let addCalls: Array<{
    scope: string
    name: string
    config: McpServerConfig
    cwd: string | undefined
  }>
  let addResult: { error?: string }
  let cliRemoveCalls: Array<{ scope: string; name: string; cwd: string | undefined }>
  let reloadCalls: string[]
  let reloadExpects: unknown[]
  let setServerCalls: Array<Record<string, McpServerConfig>>
  let toggleCalls: Array<{ routingId: string; name: string; enabled: boolean }>
  let toggleDisabledCalls: Array<{ cwd: string; name: string; enabled: boolean }>
  let reconnectCalls: Array<{ routingId: string; name: string }>
  let removeCalls: Array<{ scope: string; name: string; cwd: string | undefined }>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    catalog = [
      { name: 'user-srv', source: 'user', config: makeConfig() },
      { name: 'proj-srv', source: 'project', config: makeConfig() },
      { name: 'plugin:acme:search', source: 'plugin', config: makeConfig() },
      { name: 'corp', source: 'managed', config: makeConfig() },
      { name: 'old', source: 'claudeui', config: makeConfig({ command: 'legacy' }) }
    ]
    statusResult = null
    addCalls = []
    addResult = {}
    cliRemoveCalls = []
    reloadCalls = []
    reloadExpects = []
    setServerCalls = []
    toggleCalls = []
    toggleDisabledCalls = []
    reconnectCalls = []
    removeCalls = []

    app.bridge.ipcMain.handle('mcp:load-catalog', async () => ({ servers: catalog, skipped: [] }))
    app.bridge.ipcMain.handle(
      'mcp:cli-add',
      async (_e, scope: string, name: string, config: McpServerConfig, cwd?: string) => {
        addCalls.push({ scope, name, config, cwd })
        return addResult
      }
    )
    app.bridge.ipcMain.handle(
      'mcp:cli-remove',
      async (_e, scope: string, name: string, cwd?: string) => {
        cliRemoveCalls.push({ scope, name, cwd })
        return {}
      }
    )
    app.bridge.ipcMain.handle('mcp:reload', async (_e, routingId: string, expect?: unknown) => {
      reloadCalls.push(routingId)
      reloadExpects.push(expect)
      return { ok: true, data: undefined }
    })
    app.bridge.ipcMain.handle(
      'mcp:remove-server',
      async (_e, scope: string, name: string, cwd?: string) => {
        removeCalls.push({ scope, name, cwd })
      }
    )
    app.bridge.ipcMain.handle('mcp:read-disabled', async () => [])
    app.bridge.ipcMain.handle('mcp:status', async () => statusResult)
    app.bridge.ipcMain.handle(
      'mcp:toggle',
      async (_e, routingId: string, name: string, enabled: boolean) => {
        toggleCalls.push({ routingId, name, enabled })
        return { ok: true, data: undefined }
      }
    )
    app.bridge.ipcMain.handle(
      'mcp:toggle-disabled',
      async (_e, cwd: string, name: string, enabled: boolean) => {
        toggleDisabledCalls.push({ cwd, name, enabled })
      }
    )
    app.bridge.ipcMain.handle('mcp:reconnect', async (_e, routingId: string, name: string) => {
      reconnectCalls.push({ routingId, name })
      return { ok: true, data: undefined }
    })
    app.bridge.ipcMain.handle(
      'mcp:set-servers',
      async (_e, _routingId: string, servers: Record<string, McpServerConfig>) => {
        setServerCalls.push(servers)
        return { ok: true, data: undefined }
      }
    )
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(
    props: { open: boolean; cwd: string | null; routingId: string | null } = {
      open: true,
      cwd: CWD,
      routingId: null
    }
  ): Promise<ReturnType<typeof render>> {
    const { McpDialog } = await import('../McpDialog')
    return render(React.createElement(McpDialog, { ...props, onClose: onClose as () => void }))
  }

  async function openFC(routingId: string | null): Promise<void> {
    await act(async () => {
      await renderFC({ open: true, cwd: CWD, routingId })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('lists the catalog on open, grouped by source', async () => {
    await openFC(null)

    expect(viewProps.groups.map((g) => [g.scope, g.label])).toEqual([
      ['user', 'User'],
      ['project', 'Project'],
      ['plugin', 'Plugin'],
      ['managed', 'Managed'],
      ['claudeui', 'ClaudeUI (legacy)']
    ])
    expect(viewProps.servers.find((s) => s.name === 'plugin:acme:search')?.scope).toBe('plugin')
  })

  it('a live entry wins, and a `dynamic` scope falls back to the catalog source', async () => {
    // After reload_plugins cli.js reports native servers as `dynamic`
    statusResult = [
      { name: 'user-srv', status: 'connected', scope: 'dynamic', tools: [] },
      { name: 'plugin:acme:search', status: 'failed', scope: 'dynamic', tools: [] }
    ]
    await openFC(ROUTING_ID)

    const live = viewProps.servers.filter((s) => s.status !== 'not_started')
    expect(live.map((s) => [s.name, s.status, s.scope])).toEqual([
      ['user-srv', 'connected', 'user'],
      ['plugin:acme:search', 'failed', 'plugin']
    ])
    // catalog-only entries are still listed
    expect(viewProps.servers.some((s) => s.name === 'old' && s.status === 'not_started')).toBe(true)
    expect(viewProps.hasRoutingId).toBe(true)
  })

  it('onToggleServer with routingId uses mcpToggleServer IPC', async () => {
    await openFC(ROUTING_ID)

    const server = viewProps.servers[0]
    await act(async () => {
      await viewProps.onToggleServer(server)
    })

    expect(toggleCalls).toHaveLength(1)
    expect(toggleCalls[0].routingId).toBe(ROUTING_ID)
    expect(toggleCalls[0].name).toBe(server.name)
  })

  it('cold toggle of an enabled plugin server disables it under its full plugin:<p>:<s> key', async () => {
    await openFC(null)

    const server = viewProps.servers.find((s) => s.scope === 'plugin')!
    await act(async () => {
      await viewProps.onToggleServer(server)
    })

    expect(toggleDisabledCalls).toEqual([{ cwd: CWD, name: 'plugin:acme:search', enabled: false }])
  })

  // A dialog opened on a session that has not spawned yet still has a routing id; main
  // answers "No active session" to the live toggle, so the cold write must take over.
  it('falls back to the cold toggle when the live session is not running', async () => {
    catalog = [{ name: 'user-srv', source: 'user', config: makeConfig(), disabled: true } as never]
    app.bridge.ipcMain.removeHandler('mcp:toggle')
    app.bridge.ipcMain.handle('mcp:toggle', async (_e, routingId: string, name: string) => {
      toggleCalls.push({ routingId, name, enabled: true })
      return { ok: false, error: 'No active session' }
    })
    await openFC(ROUTING_ID)

    const server = viewProps.servers.find((s) => s.name === 'user-srv')!
    expect(server.status).toBe('disabled')
    await act(async () => {
      await viewProps.onToggleServer(server)
    })

    expect(toggleCalls).toHaveLength(1)
    expect(toggleDisabledCalls).toEqual([{ cwd: CWD, name: 'user-srv', enabled: true }])
  })

  it('a cold-disabled server stays listed as disabled and can be re-enabled', async () => {
    // The catalog flags what disabledMcpServers names; the toggle round-trips through it
    let disabled = true
    catalog = [{ name: 'user-srv', source: 'user', config: makeConfig(), disabled } as never]
    app.bridge.ipcMain.handle('mcp:load-catalog', async () => ({
      servers: [
        {
          name: 'user-srv',
          source: 'user',
          config: makeConfig(),
          ...(disabled ? { disabled } : {})
        }
      ],
      skipped: []
    }))
    app.bridge.ipcMain.handle(
      'mcp:toggle-disabled',
      async (_e, cwd: string, name: string, enabled: boolean) => {
        toggleDisabledCalls.push({ cwd, name, enabled })
        disabled = !enabled
      }
    )
    await openFC(null)
    expect(viewProps.servers.map((s) => [s.name, s.status])).toEqual([['user-srv', 'disabled']])

    await act(async () => {
      await viewProps.onToggleServer(viewProps.servers[0])
    })

    expect(toggleDisabledCalls).toEqual([{ cwd: CWD, name: 'user-srv', enabled: true }])
    expect(viewProps.servers.map((s) => [s.name, s.status])).toEqual([['user-srv', 'not_started']])
  })

  it('without a cwd it lists the catalog for the home dir (no cwd sent)', async () => {
    const seen: unknown[] = []
    app.bridge.ipcMain.handle('mcp:load-catalog', async (_e, cwd?: string) => {
      seen.push(cwd)
      return { servers: [catalog[0]], skipped: [] }
    })
    await act(async () => {
      await renderFC({ open: true, cwd: null, routingId: null })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(seen[0]).toBeUndefined()
    expect(viewProps.servers.map((s) => s.scope)).toEqual(['user'])
  })

  it('onReconnectServer calls mcpReconnectServer IPC', async () => {
    await openFC(ROUTING_ID)

    const server = viewProps.servers[0]
    await act(async () => {
      await viewProps.onReconnectServer(server)
    })

    expect(reconnectCalls).toHaveLength(1)
    expect(reconnectCalls[0].name).toBe(server.name)
  })

  it('onDeleteServer on a native scope runs `claude mcp remove` and reloads the live session', async () => {
    await openFC(ROUTING_ID)

    const server = viewProps.servers.find((s: McpServerInfo) => s.scope === 'project')!
    await act(async () => {
      await viewProps.onDeleteServer(server)
    })

    expect(cliRemoveCalls).toEqual([{ scope: 'project', name: 'proj-srv', cwd: CWD }])
    expect(removeCalls).toHaveLength(0)
    expect(reloadCalls).toEqual([ROUTING_ID])
    // the reload waits (bounded, main-side) for the removed server to leave the live list
    expect(reloadExpects).toEqual([{ name: 'proj-srv', present: false }])
    // cli.js's dynamic set is not replaced wholesale any more
    expect(setServerCalls).toHaveLength(0)
  })

  // mcp_set_servers replaces the WHOLE dynamic set (hosted claude-ui servers included):
  // a legacy delete must never push it.
  it('onDeleteServer on a legacy entry removes the file entry without replacing the live dynamic set', async () => {
    await openFC(ROUTING_ID)
    catalog = [
      ...catalog.filter((s) => s.name !== 'old'),
      { name: 'old2', source: 'claudeui', config: makeConfig({ command: 'legacy2' }) }
    ]

    const server = viewProps.servers.find((s: McpServerInfo) => s.scope === 'claudeui')!
    await act(async () => {
      await viewProps.onDeleteServer(server)
    })

    expect(removeCalls).toEqual([{ scope: 'claudeui', name: 'old', cwd: CWD }])
    expect(cliRemoveCalls).toHaveLength(0)
    expect(setServerCalls).toHaveLength(0)
    expect(reloadCalls).toEqual([ROUTING_ID])
  })

  it('onDeleteServer refuses plugin and managed entries', async () => {
    await openFC(ROUTING_ID)

    for (const scope of ['plugin', 'managed']) {
      const server = viewProps.servers.find((s: McpServerInfo) => s.scope === scope)!
      await act(async () => {
        await viewProps.onDeleteServer(server)
      })
    }

    expect(cliRemoveCalls).toHaveLength(0)
    expect(removeCalls).toHaveLength(0)
    expect(reloadCalls).toHaveLength(0)
  })

  it('onSubmitAddForm adds through `claude mcp add-json` and reloads the live session', async () => {
    await openFC(ROUTING_ID)

    const result = await act(async () => {
      return viewProps.onSubmitAddForm({
        name: 'new-server',
        scope: 'project',
        config: makeConfig({ command: 'node' })
      })
    })

    expect(result).toBeUndefined()
    expect(addCalls).toEqual([
      { scope: 'project', name: 'new-server', config: makeConfig({ command: 'node' }), cwd: CWD }
    ])
    expect(reloadCalls).toEqual([ROUTING_ID])
    expect(reloadExpects).toEqual([{ name: 'new-server', present: true }])
    expect(setServerCalls).toHaveLength(0)
  })

  it('onSubmitAddForm surfaces cli.js error text and does not reload', async () => {
    await openFC(ROUTING_ID)
    addResult = { error: 'MCP server user-srv already exists in user config' }

    const result = await act(async () => {
      return viewProps.onSubmitAddForm({ name: 'user-srv', scope: 'user', config: makeConfig() })
    })

    expect(result).toEqual({ error: 'MCP server user-srv already exists in user config' })
    expect(reloadCalls).toHaveLength(0)
  })

  it('onChangeFilter updates filter prop', async () => {
    await openFC(null)

    act(() => {
      viewProps.onChangeFilter('user')
    })

    expect(viewProps.filter).toBe('user')
  })

  it('onReconnectServer is a no-op when routingId is null', async () => {
    await openFC(null)

    const server = viewProps.servers[0]
    await act(async () => {
      await viewProps.onReconnectServer(server)
    })

    expect(reconnectCalls).toHaveLength(0)
  })
})
