/**
 * Layer 2: Component tests for McpDialog FC.
 *
 * The FC loads MCP server lists from config files + SDK, and handles
 * toggle/reconnect/delete/add operations. We mock the View to capture props.
 *
 * Tested flows:
 *   1. loads servers from config on open
 *   2. merges SDK status when routingId set
 *   3. onToggleServer (with routingId) → mcpToggleServer IPC
 *   4. onToggleServer (no routingId, has cwd) → mcpToggleDisabled IPC
 *   5. onReconnectServer → mcpReconnectServer IPC
 *   6. onDeleteServer → removeMcpServer IPC
 *   7. onSubmitAddForm → saveMcpServers IPC
 *   8. onSubmitAddForm with duplicate name returns error
 *   9. filter prop flows through
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  },
}))

const CWD = '/d/repo'
const ROUTING_ID = 'route-mcp'

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { type: 'stdio', command: 'npx', ...overrides }
}

describe('McpDialog FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let loadCalls: Array<{ scope: string; cwd: string | undefined }>
  let saveCalls: Array<{ scope: string; servers: Record<string, McpServerConfig>; cwd: string | undefined }>
  let toggleCalls: Array<{ routingId: string; name: string; enabled: boolean }>
  let toggleDisabledCalls: Array<{ cwd: string; name: string; enabled: boolean }>
  let reconnectCalls: Array<{ routingId: string; name: string }>
  let removeCalls: Array<{ scope: string; name: string; cwd: string | undefined }>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    loadCalls = []
    saveCalls = []
    toggleCalls = []
    toggleDisabledCalls = []
    reconnectCalls = []
    removeCalls = []

    app.bridge.ipcMain.handle('mcp:load-servers', async (_e, scope: string, cwd?: string) => {
      loadCalls.push({ scope, cwd })
      if (scope === 'user') return { 'user-srv': makeConfig() }
      if (scope === 'project') return { 'proj-srv': makeConfig() }
      return {}
    })
    app.bridge.ipcMain.handle('mcp:save-servers', async (_e, scope: string, servers: Record<string, McpServerConfig>, cwd?: string) => {
      saveCalls.push({ scope, servers, cwd })
    })
    app.bridge.ipcMain.handle('mcp:remove-server', async (_e, scope: string, name: string, cwd?: string) => {
      removeCalls.push({ scope, name, cwd })
    })
    app.bridge.ipcMain.handle('mcp:read-disabled', async () => [])
    app.bridge.ipcMain.handle('mcp:status', async () => null)
    app.bridge.ipcMain.handle('mcp:toggle', async (_e, routingId: string, name: string, enabled: boolean) => {
      toggleCalls.push({ routingId, name, enabled })
      return { ok: true, data: undefined }
    })
    app.bridge.ipcMain.handle('mcp:toggle-disabled', async (_e, cwd: string, name: string, enabled: boolean) => {
      toggleDisabledCalls.push({ cwd, name, enabled })
    })
    app.bridge.ipcMain.handle('mcp:reconnect', async (_e, routingId: string, name: string) => {
      reconnectCalls.push({ routingId, name })
      return { ok: true, data: undefined }
    })
    app.bridge.ipcMain.handle('mcp:set-servers', async () => ({ ok: true, data: undefined }))
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(props: { open: boolean; cwd: string | null; routingId: string | null } = { open: true, cwd: CWD, routingId: null }): Promise<ReturnType<typeof render>> {
    const { McpDialog } = await import('../McpDialog')
    return render(React.createElement(McpDialog, { ...props, onClose: onClose as () => void }))
  }

  it('loads servers from config on open', async () => {
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(loadCalls.some((c) => c.scope === 'user')).toBe(true)
    expect(loadCalls.some((c) => c.scope === 'project')).toBe(true)
    expect(viewProps.servers.length).toBeGreaterThan(0)
    expect(viewProps.servers.some((s) => s.name === 'user-srv')).toBe(true)
  })

  it('falls back to config-only when SDK returns nothing', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: ROUTING_ID }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(viewProps.servers.length).toBeGreaterThan(0)
    expect(viewProps.hasRoutingId).toBe(true)
  })

  it('onToggleServer with routingId uses mcpToggleServer IPC', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: ROUTING_ID }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const server = viewProps.servers[0]
    await act(async () => { await viewProps.onToggleServer(server) })

    expect(toggleCalls).toHaveLength(1)
    expect(toggleCalls[0].routingId).toBe(ROUTING_ID)
    expect(toggleCalls[0].name).toBe(server.name)
  })

  it('onToggleServer without routingId uses mcpToggleDisabled IPC', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: null }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const server = viewProps.servers[0]
    await act(async () => { await viewProps.onToggleServer(server) })

    expect(toggleDisabledCalls).toHaveLength(1)
    expect(toggleDisabledCalls[0].cwd).toBe(CWD)
    expect(toggleDisabledCalls[0].name).toBe(server.name)
  })

  it('onReconnectServer calls mcpReconnectServer IPC', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: ROUTING_ID }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const server = viewProps.servers[0]
    await act(async () => { await viewProps.onReconnectServer(server) })

    expect(reconnectCalls).toHaveLength(1)
    expect(reconnectCalls[0].name).toBe(server.name)
  })

  it('onDeleteServer calls removeMcpServer IPC', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: null }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const server = viewProps.servers.find((s: McpServerInfo) => s.scope === 'user')!
    await act(async () => { await viewProps.onDeleteServer(server) })

    expect(removeCalls).toHaveLength(1)
    expect(removeCalls[0].scope).toBe('user')
    expect(removeCalls[0].name).toBe(server.name)
  })

  it('onSubmitAddForm persists via saveMcpServers', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: null }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const result = await act(async () => {
      return viewProps.onSubmitAddForm({
        name: 'new-server',
        scope: 'project',
        config: makeConfig({ command: 'node' }),
      })
    })

    expect(result).toBeUndefined()
    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].scope).toBe('project')
    expect(saveCalls[0].servers['new-server']).toBeDefined()
  })

  it('onSubmitAddForm returns error when name already exists', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: null }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 'user-srv' already exists in the user scope (from the load stub)
    const result = await act(async () => {
      return viewProps.onSubmitAddForm({
        name: 'user-srv',
        scope: 'user',
        config: makeConfig(),
      })
    })

    expect(result).toEqual({ error: expect.stringContaining('already exists') })
    expect(saveCalls).toHaveLength(0)
  })

  it('onChangeFilter updates filter prop', async () => {
    await act(async () => { await renderFC() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    act(() => { viewProps.onChangeFilter('user') })

    expect(viewProps.filter).toBe('user')
  })

  // NOTE: TestIpcBridge.handle() uses Map.set internally, so re-registering
  // a channel handler silently overrides the earlier one (last-wins).
  // Tests below re-register mcp:* handlers after beforeEach has set its
  // defaults — relying on last-wins is safe but worth knowing when
  // debugging mysterious assertion failures.

  it('onSubmitAddForm notifies the SDK via mcpSetServers when routingId is active', async () => {
    const setServerCalls: Array<{ routingId: string; servers: Record<string, McpServerConfig> }> = []
    app.bridge.ipcMain.handle('mcp:set-servers', async (_e, routingId: string, servers: Record<string, McpServerConfig>) => {
      setServerCalls.push({ routingId, servers })
      return { ok: true, data: undefined }
    })

    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: ROUTING_ID }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    await act(async () => {
      await viewProps.onSubmitAddForm({
        name: 'sdk-srv',
        scope: 'project',
        config: makeConfig({ command: 'node' }),
      })
    })

    expect(saveCalls.length).toBeGreaterThanOrEqual(1)
    expect(setServerCalls.length).toBeGreaterThanOrEqual(1)
    expect(setServerCalls[0].routingId).toBe(ROUTING_ID)
  })

  it('onDeleteServer notifies the SDK with the remaining servers when routingId is active', async () => {
    const setServerCalls: Array<Record<string, McpServerConfig>> = []
    app.bridge.ipcMain.handle('mcp:set-servers', async (_e, _routingId: string, servers: Record<string, McpServerConfig>) => {
      setServerCalls.push(servers)
      return { ok: true, data: undefined }
    })

    // Load sees user-srv; after delete, loadMcpServers should be called again and returns empty
    let loadCalls = 0
    app.bridge.ipcMain.handle('mcp:load-servers', async (_e, scope: string) => {
      loadCalls++
      if (scope === 'user' && loadCalls <= 2) return { 'user-srv': makeConfig() }
      return {}
    })

    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: ROUTING_ID }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const server = viewProps.servers.find((s) => s.name === 'user-srv')!
    await act(async () => { await viewProps.onDeleteServer(server) })

    expect(removeCalls).toHaveLength(1)
    expect(setServerCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('onReconnectServer is a no-op when routingId is null', async () => {
    await act(async () => { await renderFC({ open: true, cwd: CWD, routingId: null }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const server = viewProps.servers[0]
    await act(async () => { await viewProps.onReconnectServer(server) })

    expect(reconnectCalls).toHaveLength(0)
  })
})
