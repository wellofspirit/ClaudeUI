/**
 * "Start new sessions in a worktree": the worktree is made at the FIRST SEND (not when the
 * directory is picked), branched from the remote's default branch; a failure holds the message and
 * the welcome screen offers Retry / Send without a worktree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { WorktreeInfo } from '../../../../../../shared/types'
import type { InputBoxViewProps } from '../View'
import { InputBox } from '../InputBox'
import { WelcomeState } from '../../ChatPanel/WelcomeState'

let viewProps: InputBoxViewProps

vi.mock('../View', () => ({
  InputBoxView: (props: InputBoxViewProps) => {
    viewProps = props
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

vi.mock('../../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

const ROUTE = 'wt-route'
const CWD = '/repo/app'

function infoFor(name: string): WorktreeInfo {
  return {
    worktreePath: `${CWD}/.claude/worktrees/${name}`,
    worktreeBranch: `worktree-${name}`,
    worktreeName: name,
    originalCwd: CWD,
    gitRoot: CWD,
    originalHeadCommit: 'abc123',
    createdAt: 1,
    origin: 'created'
  }
}

describe('InputBox — start in a worktree at the first send', () => {
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>
  let worktreeCalls: unknown[][]
  let createCalls: unknown[][]
  let worktreeFailsWith: () => string | null

  beforeEach(async () => {
    resetFactoryCounter()
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()
    worktreeCalls = []
    createCalls = []
    worktreeFailsWith = () => null

    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [
      { engineId: 'claude', vendorId: 'anthropic', vendorName: 'Anthropic', models: [] }
    ])
    app.bridge.ipcMain.handle('session:scan-custom-commands', () => [])
    app.bridge.ipcMain.handle('file:list-dir', () => [])
    app.bridge.ipcMain.handle('session:send', () => null)
    app.bridge.ipcMain.handle('session:create', (_e: unknown, ...args: unknown[]) => {
      createCalls.push(args)
      return null
    })
    app.bridge.ipcMain.handle('worktree:create', (_e: unknown, ...args: unknown[]) => {
      worktreeCalls.push(args)
      const failure = worktreeFailsWith()
      if (failure) throw new Error(failure)
      return infoFor(args[1] as string)
    })

    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
      lastSelectedEngineId: 'claude',
      availableModels: []
    })
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
  })

  /** A session in `CWD`, in a project whose effective setting is `on`. */
  function startSession(on: boolean): void {
    const store = useSessionStore
    store.setState({ settings: { ...store.getState().settings, startInWorktree: on } })
    store.getState().createNewSession(ROUTE, CWD)
    store.setState({ activeSessionId: ROUTE })
    store.getState().setIsGitRepo(ROUTE, true)
    store.getState().setDraftText('build it')
  }

  it('C3 starts on for a project whose effective value is on, creates nothing before the send, then spawns in the worktree', async () => {
    startSession(true)
    const pending = useSessionStore.getState().sessions[ROUTE].pendingWorktree
    expect(pending?.enabled).toBe(true)

    render(createElement(InputBox))
    expect(worktreeCalls).toEqual([])

    await act(async () => {
      await viewProps.onSend()
    })

    expect(worktreeCalls).toHaveLength(1)
    expect(worktreeCalls[0][0]).toBe(CWD)
    expect(worktreeCalls[0][1]).toBe(pending!.name)
    expect(worktreeCalls[0][2]).toEqual({ base: 'default' })
    const info = infoFor(pending!.name)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][1]).toBe(info.worktreePath)
    const state = useSessionStore.getState()
    expect(state.worktreeInfoMap[ROUTE]).toMatchObject({ worktreePath: info.worktreePath })
    expect(state.sessions[ROUTE].pendingWorktree).toBeNull()
    expect(state.sessions[ROUTE].draftText).toBe('')
  })

  it('a second send while the first is still spawning starts nothing twice', async () => {
    startSession(true)
    render(createElement(InputBox))

    await act(async () => {
      const first = viewProps.onSend()
      const second = viewProps.onSend()
      await Promise.all([first, second])
    })

    expect(worktreeCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
  })

  it('a spawned session carries no pending worktree, whether or not one was asked for', async () => {
    startSession(false)
    render(createElement(InputBox))
    expect(useSessionStore.getState().sessions[ROUTE].pendingWorktree).toBeTruthy()

    await act(async () => {
      await viewProps.onSend()
    })

    expect(useSessionStore.getState().sessions[ROUTE].pendingWorktree).toBeNull()
  })

  it('markSdkActive clears the intent for spawn paths that bypass the send (review bar, push-to-talk)', () => {
    startSession(true)
    expect(useSessionStore.getState().sessions[ROUTE].pendingWorktree?.enabled).toBe(true)

    useSessionStore.getState().markSdkActive(ROUTE)

    expect(useSessionStore.getState().sessions[ROUTE].pendingWorktree).toBeNull()
  })

  it('an auto-generated name that is taken is re-rolled and retried', async () => {
    startSession(true)
    const original = useSessionStore.getState().sessions[ROUTE].pendingWorktree!.name
    let n = 0
    worktreeFailsWith = () =>
      n++ === 0 ? `fatal: a branch named 'worktree-${original}' already exists` : null

    render(createElement(InputBox))
    await act(async () => {
      await viewProps.onSend()
    })

    expect(worktreeCalls).toHaveLength(2)
    expect(worktreeCalls[1][1]).not.toBe(original)
    expect(createCalls).toHaveLength(1)
    expect(String(createCalls[0][1])).toContain(worktreeCalls[1][1] as string)
  })

  it('gives up on a taken auto-generated name after three attempts', async () => {
    startSession(true)
    worktreeFailsWith = () => "fatal: 'path' already exists"

    render(createElement(InputBox))
    render(createElement(WelcomeState))
    await act(async () => {
      await viewProps.onSend()
    })

    expect(worktreeCalls).toHaveLength(3)
    expect(createCalls).toEqual([])
    expect(screen.getByTestId('WelcomeState.worktreeError')).toBeTruthy()
  })

  it('a name the user typed that is taken fails at once, for them to change', async () => {
    startSession(true)
    useSessionStore.getState().setPendingWorktree(ROUTE, { name: 'mine', nameTouched: true })
    worktreeFailsWith = () => "fatal: a branch named 'worktree-mine' already exists"

    render(createElement(InputBox))
    render(createElement(WelcomeState))
    await act(async () => {
      await viewProps.onSend()
    })

    expect(worktreeCalls).toHaveLength(1)
    expect(createCalls).toEqual([])
    expect(screen.getByTestId('WelcomeState.worktreeErrorText')).toHaveTextContent('already exists')
  })

  it('C5 spawns in the chosen directory, with no worktree, when the toggle is off at the send', async () => {
    startSession(true)
    useSessionStore.getState().setPendingWorktree(ROUTE, { enabled: false })

    render(createElement(InputBox))
    await act(async () => {
      await viewProps.onSend()
    })

    expect(worktreeCalls).toEqual([])
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][1]).toBe(CWD)
  })

  it('treats a directory that is not a git repository as no worktree, not a failure', async () => {
    startSession(true)
    worktreeFailsWith = () => `Not inside a git repository: ${CWD}`

    render(createElement(InputBox))
    await act(async () => {
      await viewProps.onSend()
    })

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][1]).toBe(CWD)
    expect(useSessionStore.getState().sessions[ROUTE].pendingWorktree).toBeNull()
  })

  describe('C4 a worktree that cannot be made', () => {
    async function sendAndFail(): Promise<void> {
      startSession(true)
      worktreeFailsWith = () => 'fatal: a branch named worktree-x already exists'
      useSessionStore.getState().setPendingWorktree(ROUTE, { nameTouched: true })
      render(createElement(InputBox))
      render(createElement(WelcomeState))
      await act(async () => {
        await viewProps.onSend()
      })
    }

    it('does not spawn, keeps the draft, and shows the error with both buttons', async () => {
      await sendAndFail()

      expect(createCalls).toEqual([])
      const session = useSessionStore.getState().sessions[ROUTE]
      expect(session.draftText).toBe('build it')
      expect(session.errors).toEqual([])
      expect(session.cwd).toBe(CWD)
      expect(screen.getByTestId('WelcomeState.worktreeError')).toHaveTextContent(
        "Couldn't create the worktree"
      )
      expect(screen.getByTestId('WelcomeState.worktreeErrorText')).toHaveTextContent(
        'a branch named worktree-x already exists'
      )
      expect(screen.getByTestId('WelcomeState.worktreeRetry')).toBeTruthy()
      expect(screen.getByTestId('WelcomeState.worktreeSendWithout')).toBeTruthy()
    })

    it('Retry makes the worktree again and sends', async () => {
      await sendAndFail()
      worktreeFailsWith = () => null

      await act(async () => {
        fireEvent.click(screen.getByTestId('WelcomeState.worktreeRetry'))
      })

      expect(worktreeCalls).toHaveLength(2)
      expect(createCalls).toHaveLength(1)
      expect(String(createCalls[0][1])).toContain('.claude/worktrees/')
    })

    it('Send without a worktree clears the intent and spawns in the chosen directory', async () => {
      await sendAndFail()

      await act(async () => {
        fireEvent.click(screen.getByTestId('WelcomeState.worktreeSendWithout'))
      })

      expect(worktreeCalls).toHaveLength(1)
      expect(createCalls).toHaveLength(1)
      expect(createCalls[0][1]).toBe(CWD)
      expect(useSessionStore.getState().sessions[ROUTE].pendingWorktree).toBeNull()
    })
  })
})
