/**
 * A send with attachments is busy while it is in flight (R11): send is off, the draft is held, and
 * on failure it stays for a retry. The web client's chunked upload reports progress, which the
 * thumbnails show as rings; a send that never reports (the desktop) shows none.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { FileAttachment } from '../../../../../../shared/types'
import type { InvokeProgress } from '../../../../../../shared/remote-protocol'
import type { InputBoxViewProps } from '../View'
import { InputBox } from '../InputBox'
import { FileAttachmentBar } from '../../FileAttachmentBar'

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

const ROUTE = 'upload-route'

function file(id: string, chars: number): FileAttachment {
  return {
    id,
    fileName: `${id}.png`,
    fileType: 'image',
    mediaType: 'image/png',
    base64Data: 'A'.repeat(chars),
    previewUrl: 'blob:x'
  }
}

describe('InputBox — a send with attachments', () => {
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>
  let sendPrompt: ReturnType<typeof vi.fn>
  let release: { resolve: () => void; reject: (e: Error) => void }
  let progress: ((p: InvokeProgress) => void) | undefined

  beforeEach(async () => {
    resetFactoryCounter()
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()
    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [])
    app.bridge.ipcMain.handle('file:list-dir', () => [])
    progress = undefined
    sendPrompt = vi.fn((...args: unknown[]) => {
      progress = args[3] as ((p: InvokeProgress) => void) | undefined
      return new Promise<void>((resolve, reject) => {
        release = { resolve, reject }
      })
    })
    window.api.sendPrompt = sendPrompt as unknown as typeof window.api.sendPrompt

    const store = useSessionStore.getState()
    store.createNewSession(ROUTE, '/repo/app')
    useSessionStore.setState({ activeSessionId: ROUTE })
    store.markSdkActive(ROUTE)
    store.setDraftText('look at these')
    store.setDraftAttachments(ROUTE, [file('a', 1000), file('b', 3000)])
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    vi.clearAllMocks()
  })

  const draft = (): { text: string; files: number } => {
    const s = useSessionStore.getState().sessions[ROUTE]
    return { text: s.draftText, files: s.draftAttachments.length }
  }

  it('is busy while in flight, ignores a second tap, then clears the draft on success', async () => {
    render(createElement(InputBox))
    expect(viewProps.sending).toBe(false)

    let first!: Promise<void>
    await act(async () => {
      first = viewProps.onSend() as unknown as Promise<void>
    })
    expect(viewProps.sending).toBe(true)
    expect(draft()).toEqual({ text: 'look at these', files: 2 })

    await act(async () => {
      await viewProps.onSend() // double tap: must not send the turn twice
    })
    expect(sendPrompt).toHaveBeenCalledTimes(1)

    await act(async () => {
      release.resolve()
      await first
    })
    expect(viewProps.sending).toBe(false)
    expect(draft()).toEqual({ text: '', files: 0 })
  })

  it('keeps the draft and attachments when the send fails, so the user can retry', async () => {
    render(createElement(InputBox))
    let first!: Promise<void>
    await act(async () => {
      first = viewProps.onSend() as unknown as Promise<void>
    })
    await act(async () => {
      release.reject(new Error('Connection lost: session:send'))
      await first
    })
    expect(viewProps.sending).toBe(false)
    expect(draft()).toEqual({ text: 'look at these', files: 2 })
  })

  it('a text-only send is not busy and passes no progress callback', async () => {
    useSessionStore.getState().setDraftAttachments(ROUTE, [])
    render(createElement(InputBox))
    await act(async () => {
      void viewProps.onSend()
    })
    expect(viewProps.sending).toBe(false)
    expect(sendPrompt.mock.calls[0]).toHaveLength(3)
  })

  it('maps upload progress onto each attachment, and shows none before any arrives', async () => {
    render(createElement(InputBox))
    await act(async () => {
      void viewProps.onSend()
    })
    expect(viewProps.uploadProgress).toBeUndefined() // the desktop never reports

    await act(async () => {
      progress?.({ done: 1100, total: 4300, phase: 'uploading' })
    })
    const p = viewProps.uploadProgress!
    expect(p.a).toBeGreaterThan(0.5)
    expect(p.a).toBeLessThanOrEqual(1)
    expect(p.b).toBe(0)

    await act(async () => {
      progress?.({ done: 4300, total: 4300, phase: 'uploading' })
    })
    expect(viewProps.uploadProgress).toEqual({ a: 1, b: 1 })
  })
})

describe('FileAttachmentBar — upload ring', () => {
  afterEach(cleanup)

  it('draws a ring only for an attachment that has progress', () => {
    render(
      createElement(FileAttachmentBar, {
        attachments: [file('a', 10), file('b', 10)],
        onRemove: () => {},
        uploadProgress: { a: 0.5 }
      })
    )
    const rings = screen.getAllByTestId('FileAttachmentBar.ring')
    expect(rings).toHaveLength(1)
    expect(rings[0].getAttribute('data-progress')).toBe('0.50')
  })

  it('draws none when nothing reports', () => {
    render(createElement(FileAttachmentBar, { attachments: [file('a', 10)], onRemove: () => {} }))
    expect(screen.queryByTestId('FileAttachmentBar.ring')).toBeNull()
  })
})
