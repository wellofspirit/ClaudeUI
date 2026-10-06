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
 * Owner death: the window's webContents being destroyed releases its capture, the
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
  win.webContents.once('destroyed', () => voiceRelay.releaseOwner(ownerKey))
}
