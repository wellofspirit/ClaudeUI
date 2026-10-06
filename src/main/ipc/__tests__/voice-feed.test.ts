/**
 * @vitest-environment node
 *
 * The desktop window's `voice:audio` feed (main/ipc/voice-feed.ts): audio is
 * keyed by the IPC SENDER — the key `voice:start-recording` registered the
 * capture under — and the window's webContents dying releases its capture.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const relay = vi.hoisted(() => ({ feed: vi.fn(), releaseOwner: vi.fn() }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { ipcMain: new Emitter() }
})
vi.mock('../../../core/services/voice-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/services/voice-relay')>()
  return { ...actual, voiceRelay: relay }
})

import { installDesktopVoiceFeed } from '../voice-feed'
import { ipcMain as electronIpcMain, type BrowserWindow } from 'electron'

/** The mocked `ipcMain` — a plain emitter, so a test can play the renderer. */
const ipcMain = electronIpcMain as unknown as EventEmitter

function makeWindow(id: number): { win: BrowserWindow; webContents: EventEmitter } {
  const webContents = Object.assign(new EventEmitter(), { id })
  return { win: { webContents } as unknown as BrowserWindow, webContents }
}

/** What `ipcRenderer.send('voice:audio', …)` from webContents `senderId` delivers. */
function sendAudio(senderId: number, ...args: unknown[]): void {
  ipcMain.emit('voice:audio', { sender: { id: senderId } }, ...args)
}

beforeEach(() => {
  ipcMain.removeAllListeners()
  relay.feed.mockClear()
  relay.releaseOwner.mockClear()
})

describe('desktop voice feed', () => {
  it("feeds audio under the SENDER's owner key", () => {
    installDesktopVoiceFeed(makeWindow(3).win)

    sendAudio(3, 'rid-1', 'AAEC')
    sendAudio(9, 'rid-1', 'BBBB')

    expect(relay.feed.mock.calls).toEqual([
      ['desktop:3', 'AAEC'],
      // Another webContents gets ITS key, which holds no capture: the relay
      // drops it in silence (rule 2) rather than this layer deciding.
      ['desktop:9', 'BBBB']
    ])
  })

  it('drops a non-string payload before it reaches the relay', () => {
    installDesktopVoiceFeed(makeWindow(3).win)

    sendAudio(3, 'rid-1', { evil: true })
    sendAudio(3, 'rid-1')

    expect(relay.feed).not.toHaveBeenCalled()
  })

  it('a re-created window replaces the listener rather than stacking a second', () => {
    installDesktopVoiceFeed(makeWindow(3).win)
    installDesktopVoiceFeed(makeWindow(4).win)

    sendAudio(4, 'rid-1', 'AAEC')

    expect(relay.feed).toHaveBeenCalledTimes(1)
  })

  it("releases the window's capture when its webContents is destroyed", () => {
    const { win, webContents } = makeWindow(5)
    installDesktopVoiceFeed(win)
    expect(relay.releaseOwner).not.toHaveBeenCalled()

    webContents.emit('destroyed')

    expect(relay.releaseOwner).toHaveBeenCalledWith('desktop:5')
  })
})
