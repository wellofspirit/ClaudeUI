/**
 * Why a session cannot take voice input — the wording of the refusal that the
 * desktop IPC (`voice:start-recording`) and the remote `voice:start` verb give
 * (both through `voice-relay.ts`, which re-checks it).
 *
 * The decision itself is `session.capabilities.voice` and nothing else. This
 * only picks the words: for Claude that flag is false exactly when the spawned
 * binary lacks our voice-server patch (`ClaudeSession.capabilities`; static
 * Claude capabilities always have voice), and for opencode, pi and Codex exactly
 * when the host has no speech runtime — "Provider does not support voice" would
 * misdescribe both.
 */
import type { EngineId } from '../../shared/types'
import { voicePlatformUnsupportedMessage } from '../../shared/voice-pack'

export interface VoiceGatedSession {
  readonly engineId?: EngineId
  readonly capabilities: { readonly voice: boolean }
}

export const VOICE_UNSUPPORTED = 'Provider does not support voice'

export const VOICE_NEEDS_PATCHED_HARNESS =
  'Voice input needs the patched Claude Code binary; the one this session runs lacks the voice-server patch'

/** The engines whose voice is the host's on-device worker (ADR-101). */
const ON_DEVICE_ENGINES: ReadonlySet<EngineId> = new Set<EngineId>(['opencode', 'pi', 'codex'])

/**
 * The refusal message for `session`, or null when it can take voice input.
 *
 * For an on-device engine the flag is static `true` narrowed by the host's
 * platform, so `false` can only mean this host has no speech runtime — say so,
 * rather than "Provider does not support voice", which would be untrue.
 */
export function voiceRefusal(session: VoiceGatedSession): string | null {
  if (session.capabilities.voice) return null
  if (session.engineId === 'claude') return VOICE_NEEDS_PATCHED_HARNESS
  if (session.engineId && ON_DEVICE_ENGINES.has(session.engineId)) {
    return voicePlatformUnsupportedMessage()
  }
  return VOICE_UNSUPPORTED
}
