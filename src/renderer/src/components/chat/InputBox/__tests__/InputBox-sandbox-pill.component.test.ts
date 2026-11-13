/**
 * The composer's sandbox pill follows the replicated shared switch (`claudeSandbox.settings.enabled`),
 * Claude Code's own setting; a change made on the Claude page or in the settings file reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { seedLocalApp } from '../../../../stores/replica'
import type { InputBoxViewProps } from '../View'
import { DEFAULT_SANDBOX } from '../../../../../../shared/types'
import { InputBox } from '../InputBox'
import { mirrorStoreIntoReplica, resetReplicaSeam, seedSession } from '@test/helpers/replica-seed'

let lastProps: InputBoxViewProps | undefined
vi.mock('../View', () => ({
  InputBoxView: (props: InputBoxViewProps) => {
    lastProps = props
    return null
  }
}))
vi.mock('../../../../hooks/useSlashMenu', () => ({
  useSlashMenu: () => ({
    slashMenuOpen: false,
    slashMenuIndex: 0,
    slashFilter: '',
    filteredCommands: [],
    handleInputChange: () => {},
    handleKeyDown: () => false,
    handleSelect: () => {}
  })
}))
vi.mock('../../../../hooks/useFileMention', () => ({
  useFileMention: () => ({
    fileMentionOpen: false,
    fileMentionIndex: 0,
    filteredEntries: [],
    handleInputChange: () => {},
    handleKeyDown: () => false,
    handleConfirm: () => {}
  })
}))
vi.mock('../../../../hooks/useIsMobile', () => ({ useIsMobile: () => true }))

const ROUTE = 'sandbox-pill-route'

describe('InputBox sandbox pill', () => {
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()
    resetReplicaSeam()
    lastProps = undefined
    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [])
    app.bridge.ipcMain.handle('provider-account:list', () => ({ ok: true, data: null }))
    app.bridge.ipcMain.handle('file:list-dir', () => [])
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
      claudeSandbox: { settings: DEFAULT_SANDBOX, supported: true }
    })
    mirrorStoreIntoReplica()
    seedSession(ROUTE, { cwd: '/test/cwd', selectedEngineId: 'claude', permissionMode: 'default' })
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  it('follows the replicated switch, also when it changes after mounting', async () => {
    render(createElement(InputBox))
    await act(async () => {})
    expect(lastProps?.sandboxEnabled).toBe(false)
    await act(async () => {
      seedLocalApp({
        claudeSandbox: { settings: { ...DEFAULT_SANDBOX, enabled: true }, supported: true }
      })
    })
    expect(lastProps?.sandboxEnabled).toBe(true)
  })

  it('does not read the engine config', async () => {
    useSessionStore.setState({ engineConfig: { sandbox: { enabled: true } } as never })
    render(createElement(InputBox))
    await act(async () => {})
    expect(lastProps?.sandboxEnabled).toBe(false)
  })
})
