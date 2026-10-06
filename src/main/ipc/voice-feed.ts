/**
 * The desktop window's voice AUDIO feed — the `ipcMain` half of desktop voice.
 *
 * The window captures its own microphone (`renderer/src/lib/voice/`) and pushes
 * ~150 ms base64 PCM batches as fire-and-forget `voice:audio` messages. They land
 * here and go straight into the relay under the SENDER's owner key, which is the
 * key `voice:start-recording` registered the capture under
 * (`desktopVoiceOwnerKey`) — so audio from any other webContents, or from this
 * one with no live capture, is dropped in silence (relay rule 2).
 *
 * Deliberately NOT a registry command. The control verbs are, and are audited;
 * the audio is ~7 messages a second of microphone content, which is never
 * audited or logged (security.md §Audit) — the same split the WebSocket
 * transport makes with its `voice-audio` lane frame. Validation is a type check;
 * the relay bounds the size.
 *
 * Owner death: the capture lives in the renderer's DOCUMENT, so anything that
 * ends the document releases it — the webContents being destroyed (window
 * closed), its renderer process going away (crash, OOM kill), or a main-frame
 * cross-document navigation (a reload). The webContents id survives the last
 * two, so without them the relay would keep a capture open for a page that no
 * longer exists, holding a Deepgram stream until the engine died. This is the
 * desktop counterpart of a socket closing on the remote side.
 */

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { desktopVoiceOwnerKey, voiceRelay } from '../../core/services/voice-relay'

const VOICE_AUDIO_CHANNEL = 'voice:audio'

/**
 * Wire the feed for `win`. Called from `createWindow()` for every window
 * generation (macOS re-creates on dock activate), so the listener is replaced
 * rather than stacked.
 */
export function installDesktopVoiceFeed(win: BrowserWindow): void {
  ipcMain.removeAllListeners(VOICE_AUDIO_CHANNEL)
  ipcMain.on(VOICE_AUDIO_CHANNEL, (event, _routingId: unknown, dataB64: unknown) => {
    if (typeof dataB64 !== 'string') return
    voiceRelay.feed(desktopVoiceOwnerKey(event.sender.id), dataB64)
  })

  // Read now: a destroyed webContents throws on property access.
  const ownerKey = desktopVoiceOwnerKey(win.webContents.id)
  const release = (): void => voiceRelay.releaseOwner(ownerKey)
  win.webContents.once('destroyed', release)
  win.webContents.on('render-process-gone', release)
  win.webContents.on('did-start-navigation', (details) => {
    // Same-document navigations (the SPA's hash routing) keep the document — and
    // the capture — alive; sub-frames (plugin webviews, mockup iframes) are not it.
    if (details.isMainFrame && !details.isSameDocument) release()
  })
}
