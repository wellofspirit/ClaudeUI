import type {
  VoicePackInstallCancelResult,
  VoicePackInstallResult,
  VoicePackRemoveResult,
  VoicePackStatus
} from '../../voice-pack'
import type { VoiceState, VoiceTranscript } from '../voice'

/**
 * The voice TRANSPORT. Capture is the renderer's (`renderer/src/lib/voice/`, one
 * implementation for the desktop window and the web client); these only bind its
 * pushed audio to a session's transcription server in the main process.
 */
export interface VoiceAPI {
  /**
   * Bind this client's audio to `routingId`'s voice server. Rejects on refusal.
   * `opts.preview: false` turns the on-device recognizer's live preview off for
   * this capture (the client's setting, ADR-101 §7); cli.js ignores it.
   */
  voiceStart(routingId: string, language: string, opts?: { preview?: boolean }): Promise<void>
  /** One ~150 ms batch of base64 16 kHz i16LE mono PCM. Fire-and-forget. */
  voiceAudio(routingId: string, dataB64: string): void
  /** End this client's capture; transcripts still in flight arrive afterwards. */
  voiceStop(routingId: string): Promise<void>
  onVoiceTranscript(cb: (routingId: string, data: VoiceTranscript) => void): () => void
  onVoiceState(cb: (routingId: string, state: VoiceState) => void): () => void
  /** Where the on-device speech pack stands on the host (`chat`). */
  voicePackStatus(): Promise<VoicePackStatus>
  /**
   * Download and install the speech pack (`admin`). Resolves when the install
   * does — minutes on a slow link — so a remote client's call can time out while
   * the host keeps installing; follow `voice:pack-changed` instead.
   */
  voicePackInstall(): Promise<VoicePackInstallResult>
  /** Abort the install in flight, for every client (`admin`). */
  voicePackInstallCancel(): Promise<VoicePackInstallCancelResult>
  /** Delete the installed pack (`admin`). */
  voicePackRemove(): Promise<VoicePackRemoveResult>
}
