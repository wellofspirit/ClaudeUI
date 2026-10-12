/**
 * @vitest-environment node
 *
 * `BaseSession.voiceStartServer` (ADR-101): every engine that does not bring its
 * own transcription server — opencode, pi, Codex — starts voice input on the
 * host's on-device worker. The session adds nothing of its own; what must hold is
 * that it is the worker's endpoint, token included, that reaches the relay, and
 * that a missing speech pack surfaces as the error the relay turns into the
 * download offer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AttachmentUpload, EngineId } from '../../../shared/types'
import type { ResolvedCapabilities } from '../../../shared/model-capabilities'

vi.mock('../../services/sync-host', () => ({
  emitEvent: vi.fn(),
  addExtraSink: vi.fn(),
  removeExtraSink: vi.fn(),
  extraSinks: () => new Set()
}))
vi.mock('../../services/db', () => ({ dispatchedCostsByRouting: () => [] }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const acquire = vi.hoisted(() => vi.fn())
vi.mock('../../voice/local-voice-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../voice/local-voice-server')>()
  return { ...actual, localVoiceServer: { acquire } }
})

import { BaseSession } from '../BaseSession'
import { VoicePackMissingError, isVoicePackMissing } from '../../voice/local-voice-server'

class ProbeSession extends BaseSession {
  readonly engineId: EngineId = 'pi'
  readonly capabilities = {} as ResolvedCapabilities
  readonly willQueue = false
  getSessionId(): string | null {
    return null
  }
  async run(
    _prompt: string | null,
    _attachments?: AttachmentUpload[],
    _clientUserMessageId?: string
  ): Promise<void> {}
  async interrupt(): Promise<void> {}
  cancel(): void {}
  resolveApproval(): void {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  dispose(): void {}
}

describe('BaseSession.voiceStartServer', () => {
  beforeEach(() => {
    acquire.mockReset()
  })

  it("returns the host worker's port and start fields", async () => {
    acquire.mockResolvedValue({ port: 4242, startFields: { token: 'secret' } })
    const session = new ProbeSession('rid', null, '/cwd')

    await expect(session.voiceStartServer()).resolves.toEqual({
      port: 4242,
      startFields: { token: 'secret' }
    })
  })

  it('lets a missing speech pack through as the error the relay recognises', async () => {
    acquire.mockImplementation(async () => {
      throw new VoicePackMissingError()
    })
    const session = new ProbeSession('rid', null, '/cwd')

    const failure = await session.voiceStartServer().catch((err: unknown) => err)
    expect(isVoicePackMissing(failure)).toBe(true)
  })
})
