/**
 * @vitest-environment node
 *
 * The words of a voice refusal. The decision is `capabilities.voice`; what is
 * tested is that each engine is told its own cause (ADR-101 §8).
 */

import { describe, expect, it } from 'vitest'
import { VOICE_NEEDS_PATCHED_HARNESS, VOICE_UNSUPPORTED, voiceRefusal } from '../voice-gate'
import { voicePlatformUnsupportedMessage } from '../../../shared/voice-pack'
import { onHostPlatform } from '../../../test/helpers/host-platform'
import type { EngineId } from '../../../shared/types'

const session = (engineId: EngineId | undefined, voice: boolean) => ({
  engineId,
  capabilities: { voice }
})

describe('voiceRefusal', () => {
  it('is null whenever the session can take voice', () => {
    for (const engineId of ['claude', 'opencode', 'pi', 'codex'] as const) {
      expect(voiceRefusal(session(engineId, true))).toBeNull()
    }
  })

  it('names the missing patch for Claude — unchanged', () => {
    expect(voiceRefusal(session('claude', false))).toBe(VOICE_NEEDS_PATCHED_HARNESS)
  })

  it.each(['opencode', 'pi', 'codex'] as const)(
    '%s without voice means the host has no speech runtime — and says so',
    (engineId) => {
      const message = onHostPlatform('win32', 'arm64', () => voiceRefusal(session(engineId, false)))

      expect(message).toBe('On-device voice input is not available on this host (win32-arm64)')
      expect(message).toBe(voicePlatformUnsupportedMessage('win32', 'arm64'))
      expect(message).not.toBe(VOICE_UNSUPPORTED)
    }
  )

  it('keeps the generic wording for an engine with no voice story at all', () => {
    expect(voiceRefusal(session(undefined, false))).toBe(VOICE_UNSUPPORTED)
  })
})
