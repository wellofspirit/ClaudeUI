/**
 * Layer 1: the speech pack's client store (ADR-101 §6) — one status fed by the
 * replicated `voice:pack-changed` and re-read from `voice:pack-status`, and the
 * three admin commands with the refusals a remote client meets: no `admin`
 * (one plain sentence) and the web transport's 30 s invoke timeout on an install
 * that is still running on the host (NOT a failure).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyVoicePackStatus,
  cancelVoicePackInstall,
  installVoicePack,
  refreshVoicePackStatus,
  removeVoicePack,
  resetVoicePackStoreForTests,
  useVoicePackStore,
  VOICE_PACK_ADMIN_MESSAGE,
  VOICE_PACK_INSTALL_ADMIN_MESSAGE
} from '../voice-pack-store'
import type { VoicePackState, VoicePackStatus } from '../../../../../shared/voice-pack'

const status = (state: VoicePackState, over: Partial<VoicePackStatus> = {}): VoicePackStatus => ({
  state,
  packId: 'parakeet-tdt-0.6b-v2-int8',
  label: 'Parakeet TDT 0.6B v2 (English)',
  approxBytes: 700_000_000,
  ...over
})

type Api = {
  voicePackStatus: ReturnType<typeof vi.fn>
  voicePackInstall: ReturnType<typeof vi.fn>
  voicePackInstallCancel: ReturnType<typeof vi.fn>
  voicePackRemove: ReturnType<typeof vi.fn>
}
let api: Api

beforeEach(() => {
  resetVoicePackStoreForTests()
  api = {
    voicePackStatus: vi.fn(async () => status('missing')),
    voicePackInstall: vi.fn(async () => ({ status: 'installed' })),
    voicePackInstallCancel: vi.fn(async () => ({ status: 'cancelled' })),
    voicePackRemove: vi.fn(async () => ({ status: 'removed' }))
  }
  ;(window as unknown as { api: Api }).api = api
})
afterEach(() => resetVoicePackStoreForTests())

const state = (): ReturnType<typeof useVoicePackStore.getState> => useVoicePackStore.getState()

const PERMISSION_DENIED = (channel: string): string =>
  `Permission denied: "${channel}" requires the "admin" capability`

describe('voice pack store — status', () => {
  it('reads voice:pack-status, and a pushed status replaces it', async () => {
    await refreshVoicePackStatus()
    expect(state().status?.state).toBe('missing')
    applyVoicePackStatus(status('installing', { progress: { receivedBytes: 1, totalBytes: 2 } }))
    expect(state().status?.state).toBe('installing')
  })

  it('a read that was in flight when an event landed loses to the event', async () => {
    let answer!: (s: VoicePackStatus) => void
    api.voicePackStatus.mockImplementation(
      () => new Promise<VoicePackStatus>((resolve) => (answer = resolve))
    )
    const reading = refreshVoicePackStatus()
    applyVoicePackStatus(status('ready'))
    answer(status('missing'))
    await reading
    expect(state().status?.state).toBe('ready')
  })

  it('a first read that fails is flagged (Settings must not wait forever); the next answer or event clears it', async () => {
    api.voicePackStatus.mockRejectedValueOnce(
      new Error('No handler registered for voice:pack-status')
    )
    await refreshVoicePackStatus()
    expect(state().status).toBeNull()
    expect(state().readFailed).toBe(true)

    await refreshVoicePackStatus()
    expect(state().readFailed).toBe(false)
    expect(state().status?.state).toBe('missing')

    api.voicePackStatus.mockRejectedValueOnce(new Error('gone'))
    await refreshVoicePackStatus()
    applyVoicePackStatus(status('ready'))
    expect(state().readFailed).toBe(false)
  })

  it('a failed read (an old host without the channel, a missing API) keeps the last answer and never throws', async () => {
    applyVoicePackStatus(status('ready'))
    api.voicePackStatus.mockRejectedValue(new Error('No handler registered for voice:pack-status'))
    await expect(refreshVoicePackStatus()).resolves.toBeUndefined()
    expect(state().status?.state).toBe('ready')

    delete (window.api as unknown as Partial<Api>).voicePackStatus
    await expect(refreshVoicePackStatus()).resolves.toBeUndefined()
    expect(state().status?.state).toBe('ready')
  })
})

describe('voice pack store — commands', () => {
  it('install is pending while it runs, then re-reads the status and reports nothing wrong', async () => {
    let finish!: () => void
    api.voicePackInstall.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ status: 'installed' })))
    )
    api.voicePackStatus.mockResolvedValue(status('ready'))
    const running = installVoicePack()
    expect(state().pending).toBe('install')
    finish()
    await expect(running).resolves.toBeNull()
    expect(state().pending).toBeNull()
    expect(state().status?.state).toBe('ready')
  })

  it('a FAILED install is the status’ business, not a command error', async () => {
    api.voicePackInstall.mockResolvedValue({ status: 'failed', message: 'sha mismatch' })
    api.voicePackStatus.mockResolvedValue(status('failed', { error: 'sha mismatch' }))
    await expect(installVoicePack()).resolves.toBeNull()
    expect(state().error).toBeNull()
    expect(state().status).toMatchObject({ state: 'failed', error: 'sha mismatch' })
  })

  it('a remote client without admin gets one plain sentence — keyed on the registry’s refusal shape', async () => {
    api.voicePackInstall.mockRejectedValue(new Error(PERMISSION_DENIED('voice:pack-install')))
    await expect(installVoicePack()).resolves.toBe(VOICE_PACK_INSTALL_ADMIN_MESSAGE)
    expect(VOICE_PACK_INSTALL_ADMIN_MESSAGE).toBe(
      'Installing the speech model needs admin access on this host'
    )
    // A refusal is the latched `denied`, not an error: Settings words it once.
    expect(state().denied).toBe(true)
    expect(state().error).toBeNull()

    // The desktop wraps a handler's throw; the shape under the wrapper is the same.
    api.voicePackRemove.mockRejectedValue(
      new Error(
        `Error invoking remote method 'voice:pack-remove': Error: ${PERMISSION_DENIED('voice:pack-remove')}`
      )
    )
    await expect(removeVoicePack()).resolves.toBe(VOICE_PACK_ADMIN_MESSAGE)
    expect(VOICE_PACK_ADMIN_MESSAGE).toBe(
      'Managing the speech model needs admin access on this host'
    )
  })

  it('a refused Cancel reads the managing sentence, and denied stays latched afterwards', async () => {
    api.voicePackInstallCancel.mockRejectedValue(
      new Error(PERMISSION_DENIED('voice:pack-install-cancel'))
    )
    await expect(cancelVoicePackInstall()).resolves.toBe(VOICE_PACK_ADMIN_MESSAGE)
    expect(state().denied).toBe(true)
    // A later command that works does not un-deny the connection.
    await removeVoicePack()
    expect(state().denied).toBe(true)
  })

  it('a refusal is returned BEFORE the status re-read finishes (the stale status must not stand in for the reason)', async () => {
    let answer!: (s: VoicePackStatus) => void
    api.voicePackStatus.mockImplementation(
      () => new Promise<VoicePackStatus>((resolve) => (answer = resolve))
    )
    api.voicePackInstall.mockRejectedValue(new Error(PERMISSION_DENIED('voice:pack-install')))
    // Resolves although the read has not answered; a successful command would wait for it.
    await expect(installVoicePack()).resolves.toBe(VOICE_PACK_INSTALL_ADMIN_MESSAGE)
    expect(state().commandFailed).toBe(true)
    expect(state().pending).toBeNull()
    answer(status('missing'))
  })

  it('a command that works clears commandFailed at its start', async () => {
    api.voicePackInstall.mockRejectedValueOnce(new Error('boom'))
    await installVoicePack()
    expect(state().commandFailed).toBe(true)
    await installVoicePack()
    expect(state().commandFailed).toBe(false)
  })

  it('does NOT key on wording: a different failure that mentions admin is shown as it is', async () => {
    api.voicePackInstall.mockRejectedValue(new Error('the admin password is wrong'))
    await expect(installVoicePack()).resolves.toBe('the admin password is wrong')
  })

  it('the web transport’s 30 s invoke timeout on install is an install still running, not a failure', async () => {
    api.voicePackInstall.mockRejectedValue(new Error('Timeout: voice:pack-install'))
    api.voicePackStatus.mockResolvedValue(
      status('installing', { progress: { receivedBytes: 10, totalBytes: 100 } })
    )
    await expect(installVoicePack()).resolves.toBeNull()
    expect(state().error).toBeNull()
    expect(state().pending).toBeNull()
    // The host is still installing: the re-read says so.
    expect(state().status?.state).toBe('installing')
  })

  it('cancel and remove go to their channels; a new command clears the last error', async () => {
    api.voicePackInstallCancel.mockRejectedValue(new Error('boom'))
    await expect(cancelVoicePackInstall()).resolves.toBe('boom')
    expect(state().error).toBe('boom')

    await expect(removeVoicePack()).resolves.toBeNull()
    expect(api.voicePackRemove).toHaveBeenCalledTimes(1)
    expect(state().error).toBeNull()
  })

  it('progress ticks (four a second) do not wipe a failure; a change of state does', async () => {
    const installing = status('installing', { progress: { receivedBytes: 1, totalBytes: 100 } })
    applyVoicePackStatus(installing)
    api.voicePackStatus.mockResolvedValue(installing)
    api.voicePackInstallCancel.mockRejectedValue(new Error('boom'))
    await cancelVoicePackInstall()
    expect(state().error).toBe('boom')

    for (let received = 2; received < 10; received++) {
      applyVoicePackStatus(
        status('installing', { progress: { receivedBytes: received, totalBytes: 100 } })
      )
    }
    expect(state().error).toBe('boom')

    applyVoicePackStatus(status('missing'))
    expect(state().error).toBeNull()
  })
})
