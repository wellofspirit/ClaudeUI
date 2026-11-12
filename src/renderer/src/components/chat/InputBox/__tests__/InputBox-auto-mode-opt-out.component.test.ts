/**
 * ADR-050 at the composer: `disableAutoMode` is Claude Code's own setting, so
 * with it set the mode picker does not offer Auto to a Claude session and the
 * pre-session label does not promise it. opencode and pi are not bound by it.
 * `autoAvailable` is what the mobile picker (MobileConfigSheet) disables its
 * Auto row on; `permissionMode` with no session is the mode the session created
 * from this composer will start in.
 *
 * Renders <InputBox /> against `bootTestApp` with a View mock (the pattern of
 * InputBox-engine-models.component.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { seedLocalApp } from '../../../../stores/replica'
import type { InputBoxViewProps } from '../View'
import type { EngineId } from '../../../../../../shared/types'
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

const ROUTE = 'auto-opt-out-route'
const ENGINES: EngineId[] = ['claude', 'opencode', 'pi']
const NOT_CLAUDE: EngineId[] = ['opencode', 'pi']

describe('InputBox and auto mode turned off in Claude settings', () => {
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
      availableModels: [],
      lastSelectedEngineId: 'claude',
      defaultPermissionMode: 'auto',
      // `resetReplicaSeam` empties the replica without projecting; match it.
      autoModeDisabledBySettings: false
    })
    mirrorStoreIntoReplica()
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  async function mount(): Promise<void> {
    render(createElement(InputBox))
    await act(async () => {})
  }

  /** A session on `engineId` is the active one. */
  function activeSessionOn(engineId: EngineId): void {
    seedSession(ROUTE, { cwd: '/test/cwd', selectedEngineId: engineId, permissionMode: 'default' })
    useSessionStore.setState({ activeSessionId: ROUTE })
  }

  it.each(ENGINES)('%s: the picker offers Auto while the setting is off', async (engineId) => {
    activeSessionOn(engineId)
    await mount()
    expect(lastProps?.showModePicker).toBe(true)
    expect(lastProps?.autoAvailable).toBe(true)
  })

  it('claude: the picker does not offer Auto with the setting on', async () => {
    activeSessionOn('claude')
    seedLocalApp({ autoModeDisabledBySettings: true })
    await mount()
    expect(lastProps?.showModePicker).toBe(true)
    expect(lastProps?.autoAvailable).toBe(false)
  })

  it.each(NOT_CLAUDE)(
    '%s: the picker still offers Auto with the setting on, which is not its setting',
    async (engineId) => {
      activeSessionOn(engineId)
      seedLocalApp({ autoModeDisabledBySettings: true })
      await mount()
      expect(lastProps?.showModePicker).toBe(true)
      expect(lastProps?.autoAvailable).toBe(true)
    }
  )

  it('a client that learns the setting after mounting stops offering Auto to a Claude session', async () => {
    activeSessionOn('claude')
    await mount()
    expect(lastProps?.autoAvailable).toBe(true)
    // The host snapshot, or a change made in Settings, lands after the composer is up.
    await act(async () => {
      seedLocalApp({ autoModeDisabledBySettings: true })
    })
    expect(lastProps?.autoAvailable).toBe(false)
    await act(async () => {
      seedLocalApp({ autoModeDisabledBySettings: false })
    })
    expect(lastProps?.autoAvailable).toBe(true)
  })

  it('claude: with no session yet the composer shows Default once the setting is on', async () => {
    await mount()
    expect(lastProps?.permissionMode).toBe('auto')
    await act(async () => {
      seedLocalApp({ autoModeDisabledBySettings: true })
    })
    expect(lastProps?.permissionMode).toBe('default')
  })

  it.each(NOT_CLAUDE)(
    '%s: with no session yet the composer keeps showing Auto with the setting on',
    async (engineId) => {
      useSessionStore.setState({ lastSelectedEngineId: engineId })
      await mount()
      expect(lastProps?.permissionMode).toBe('auto')
      await act(async () => {
        seedLocalApp({ autoModeDisabledBySettings: true })
      })
      expect(lastProps?.permissionMode).toBe('auto')
    }
  )
})
