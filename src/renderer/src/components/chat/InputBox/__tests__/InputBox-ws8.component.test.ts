/**
 * WS8 guard tests for InputBox:
 *  - failed send preserves draft + surfaces an error (gpt#15)
 *  - attachments are read per-session, so switching sessions swaps them (gpt#14)
 *  - a queued (mid-turn) prompt carries its attachments (Low)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { FileAttachment } from '../../../../../../shared/types'
import type { InputBoxViewProps } from '../View'
import { InputBox } from '../InputBox'
import { resolveSendAction } from '../utils'

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

function att(id: string): FileAttachment {
  return {
    id,
    fileName: `${id}.png`,
    fileType: 'image',
    mediaType: 'image/png',
    base64Data: 'AAAA',
    previewUrl: 'data:image/png;base64,AAAA'
  }
}

// ---------------------------------------------------------------------------
// resolveSendAction — queue-prompt carries attachments (Low)
// ---------------------------------------------------------------------------

describe('resolveSendAction — queued prompt keeps attachments', () => {
  it('includes attachments in the queue-prompt action while a turn runs', () => {
    const action = resolveSendAction({
      text: 'hi',
      attachedFiles: [att('x')],
      isDisabled: false,
      activeSessionId: 'r',
      isRunning: true,
      queueEnabled: true
    })
    expect(action.type).toBe('queue-prompt')
    // Pre-fix, queue-prompt carried no attachments and the image was dropped.
    expect(action.type === 'queue-prompt' && action.attachments).toBeTruthy()
    expect(action.type === 'queue-prompt' && action.attachments?.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Rendered InputBox — failed send + attachment isolation
// ---------------------------------------------------------------------------

describe('InputBox FC — WS8 behaviors', () => {
  const ROUTE = 'ws8-route'
  const ipcCalls: Record<string, unknown[][]> = {}
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

  function renderFC(): void {
    render(createElement(InputBox))
  }

  beforeEach(async () => {
    resetFactoryCounter()
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()
    for (const key of Object.keys(ipcCalls)) delete ipcCalls[key]

    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [
      { engineId: 'claude', vendorId: 'anthropic', vendorName: 'Anthropic', models: [] }
    ])
    app.bridge.ipcMain.handle('session:scan-custom-commands', () => [])
    app.bridge.ipcMain.handle('file:list-dir', () => [])

    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
      lastSelectedEngineId: 'claude',
      availableModels: []
    })
    useSessionStore.getState().createNewSession(ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
  })

  it('preserves draft text and surfaces an error when the send fails (gpt#15)', async () => {
    // createSession rejects → doSend throws → handleSend must NOT clear the draft.
    app.bridge.ipcMain.handle('session:create', () => {
      throw new Error('spawn failed')
    })
    app.bridge.ipcMain.handle('session:send', () => null)

    useSessionStore.getState().setDraftText('unsent prompt')
    renderFC()
    expect(viewProps.text).toBe('unsent prompt')

    await act(async () => {
      await viewProps.onSend()
    })

    const session = useSessionStore.getState().sessions[ROUTE]
    // Pre-fix, the draft was cleared before the await and lost on failure.
    expect(session.draftText).toBe('unsent prompt')
    expect(session.errors.length).toBeGreaterThan(0)
  })

  it('clears the draft only after a successful send', async () => {
    app.bridge.ipcMain.handle('session:create', () => null)
    app.bridge.ipcMain.handle('session:send', () => null)

    useSessionStore.getState().setDraftText('good prompt')
    renderFC()

    await act(async () => {
      await viewProps.onSend()
    })

    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('')
  })

  it('reads attachments from the active session and swaps them on session switch (gpt#14)', () => {
    // Seed two sessions with different draft attachments.
    useSessionStore.getState().createNewSession('OTHER', '/test/cwd')
    useSessionStore.getState().addDraftAttachments(ROUTE, [att('a')])
    useSessionStore.getState().addDraftAttachments('OTHER', [att('b1'), att('b2')])
    useSessionStore.setState({ activeSessionId: ROUTE })

    renderFC()
    expect(viewProps.attachedFiles.map((f) => f.id)).toEqual(['a'])

    act(() => {
      useSessionStore.setState({ activeSessionId: 'OTHER' })
    })
    // Pre-fix, attachments were component-local useState → shared across sessions.
    expect(viewProps.attachedFiles.map((f) => f.id)).toEqual(['b1', 'b2'])
  })
})
