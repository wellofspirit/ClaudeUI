/**
 * Voice client service — the DESKTOP capture: the host machine's microphone,
 * streamed to the voice server running inside cli.js.
 *
 * The socket, the newline-JSON protocol and the state machine are
 * {@link VoiceStreamClient}'s; this class supplies the two halves that are
 * specific to a host-local capture:
 *
 *  - the AUDIO SOURCE — `voice-capture.ts`'s native NAPI module, which already
 *    emits exactly 16 kHz i16LE mono PCM, so there is no conversion here at all
 *    (the browser path's `shared/audio/pcm16.ts` exists precisely because a
 *    browser cannot hand us that);
 *  - the DELIVERY — `voice:state` / `voice:transcript` go to the owning window,
 *    because microphone capture belongs to the machine with the microphone.
 *
 * Since phase 5 S3 it is no longer the only implementation: a remote browser's
 * capture is `services/remote-voice.ts`, and its transcripts ride the volatile
 * lane to the one connection that started it.
 */

import type { HostWindowHandle } from '../host'
import { emitEvent } from './sync-host'
import { startRecording, stopRecording } from './voice-capture'
import { VoiceStreamClient } from './voice-stream-client'
import type { VoiceState } from '../../shared/types'

export class VoiceClient extends VoiceStreamClient {
  private win: HostWindowHandle
  private routingId: string

  constructor(port: number, win: HostWindowHandle, routingId: string) {
    super(port, 'VoiceClient')
    this.win = win
    this.routingId = routingId
  }

  /**
   * Take over live audio capture. Native recording is already active (started by
   * `ClaudeSession.voiceStartRecording` for zero-latency buffering while the SDK
   * spawns), so this swaps the callback rather than starting from cold.
   */
  protected startAudioSource(): boolean {
    stopRecording()
    return startRecording((buffer) => this.pushAudio(buffer))
  }

  protected stopAudioSource(): void {
    stopRecording()
  }

  /** The shipped desktop wording — "restart", because capture was already running. */
  protected audioSourceFailureMessage(): string {
    return 'Failed to restart audio capture. Check microphone access.'
  }

  protected emitState(state: VoiceState): void {
    this.send('voice:state', this.routingId, state)
  }

  protected emitTranscript(text: string, isFinal: boolean): void {
    this.send('voice:transcript', this.routingId, { text, isFinal })
  }

  /**
   * `voice:error` is the one channel this client raises that is NOT host-local.
   *
   * It is classified `replicated` because `ClaudeSession` also raises it through
   * `BaseSession.send` (an early-capture failure), so it rings and reaches every
   * client — an anomaly `shared/sync/channels.ts` records rather than papers over.
   * Since SyncCore phase 4c the desktop renderer subscribes to it on the sync
   * transport, so a targeted `webContents.send` would land nowhere: it has to go
   * through the funnel like every other replicated event.
   *
   * S3 did NOT change that. What it changed is the third emitter it might have
   * added: a REMOTE capture's errors never come through here and never enter the
   * event lane at all — they are targeted lane frames to the connection that is
   * holding the microphone (`services/remote-voice.ts`). See the NOTE in
   * `shared/sync/channels.ts`.
   */
  protected emitError(message: string): void {
    emitEvent('voice:error', [this.routingId, message])
  }

  /**
   * Guarded webContents.send for this client's HOST-LOCAL channels
   * (`voice:state`, `voice:transcript` — microphone capture belongs to the machine
   * with the microphone). `voice:error` does NOT come through here; see
   * {@link VoiceClient.emitError}.
   *
   * The window can be destroyed while a voice session is still finalizing (user
   * closes the window mid-transcription); sending to a destroyed webContents throws
   * and would surface as an uncaughtException. `isDestroyed?.()` tolerates the
   * plain test double.
   */
  private send(channel: string, ...args: unknown[]): void {
    const wc = this.win.webContents
    if (this.win.isDestroyed?.() || wc?.isDestroyed?.()) return
    wc.send(channel, ...args)
  }
}
