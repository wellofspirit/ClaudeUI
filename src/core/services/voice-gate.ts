/**
 * Why a session cannot take voice input — the wording of the refusal that the
 * desktop IPC (`voice:start-server`, `voice:start-recording`) and the remote
 * `voice:start` verb give.
 *
 * The decision itself is `session.capabilities.voice` and nothing else. This
 * only picks the words: for Claude that flag is false exactly when the spawned
 * binary lacks our voice-server patch (`ClaudeSession.capabilities`; static
 * Claude capabilities always have voice), which "Provider does not support
 * voice" would misdescribe.
 */
import type { EngineId } from '../../shared/types'

export interface VoiceGatedSession {
  readonly engineId?: EngineId
  readonly capabilities: { readonly voice: boolean }
}

export const VOICE_UNSUPPORTED = 'Provider does not support voice'

export const VOICE_NEEDS_PATCHED_HARNESS =
  'Voice input needs the patched Claude Code binary; the one this session runs lacks the voice-server patch'

/** The refusal message for `session`, or null when it can take voice input. */
export function voiceRefusal(session: VoiceGatedSession): string | null {
  if (session.capabilities.voice) return null
  return session.engineId === 'claude' ? VOICE_NEEDS_PATCHED_HARNESS : VOICE_UNSUPPORTED
}
