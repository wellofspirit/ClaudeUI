/**
 * The speech pack's channels (ADR-101 §6, local-voice-spec C6), declared ONCE and
 * served by both transports: the notice pill's Download button and Settings ›
 * Voice input drive these from the desktop and from a phone alike.
 *
 * ## Capabilities
 *
 * - `voice:pack-status` declares `chat`, a `query`: the pill needs to know
 *   whether to offer the download, and every connection that can start a capture
 *   (`chat`) can hit that wall.
 * - The three writes declare `admin`, as `harness:install` does: installing puts
 *   native code and 650 MB on the host, and removing it takes voice away from
 *   every client of the host. A base remote connection never holds `admin`; a
 *   passkey or break-glass one does, and at the `strong` tier a write also needs
 *   the mutation window. The desktop renderer's host connection holds every
 *   capability. The three are pinned in `PINNED_CAPABILITIES`.
 *
 * ## Results
 *
 * Discriminated by `status`, never an `ok` key: the preload and web `unwrap`
 * treat any object carrying `ok` as their own envelope and would return its
 * `.data` (undefined).
 *
 * ## Events (`startVoicePackEvents`)
 *
 * `voice:pack-changed (status)` — the whole {@link VoicePackStatus} on every state
 * change and, while installing, at most four times a second. A replicated sync
 * event, so the desktop renderer and every remote client follow the one install.
 *
 * ## One install, one cancel
 *
 * `voice:pack-install` resolves when the install does (minutes, on a slow link),
 * and a second call joins it. `voice:pack-install-cancel` ends it for everyone:
 * all clients watch the same status, so there is one Cancel.
 */

import type {
  VoicePackInstallCancelResult,
  VoicePackInstallResult,
  VoicePackRemoveResult,
  VoicePackStatus
} from '../../shared/voice-pack'
import { voicePackInstaller, type VoicePackInstaller } from '../voice/pack-installer'
import type { CommandRegistration } from './command-registry'

/** The channels declared here; `registerSessionIpc` unbinds them before re-registering. */
export const VOICE_PACK_CHANNELS = [
  'voice:pack-status',
  'voice:pack-install',
  'voice:pack-install-cancel',
  'voice:pack-remove'
] as const

/** The work these commands hand off; injected in tests, the app's installer otherwise. */
export interface VoicePackCommandDeps {
  installer?: VoicePackInstaller
}

export function voicePackCommands(
  deps: VoicePackCommandDeps = {}
): Array<Omit<CommandRegistration, 'transport'>> {
  const installer = deps.installer ?? voicePackInstaller
  return [
    {
      channel: 'voice:pack-status',
      capability: 'chat',
      kind: 'query',
      handler: async (): Promise<VoicePackStatus> => installer.status()
    },
    {
      channel: 'voice:pack-install',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<VoicePackInstallResult> => installer.install()
    },
    {
      channel: 'voice:pack-install-cancel',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<VoicePackInstallCancelResult> => ({
        status: installer.cancel() ? 'cancelled' : 'not-running'
      })
    },
    {
      channel: 'voice:pack-remove',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<VoicePackRemoveResult> => installer.remove()
    }
  ]
}

// ── Events ────────────────────────────────────────────────────────────────────

export type VoicePackEventEmitter = (channel: string, args: unknown[]) => void

let stopEvents: (() => void) | null = null

/**
 * Forward the installer's status changes to the sync funnel (`emitEvent`), from
 * `startCoreServices`. A second call replaces the first (a test that boots core
 * twice), so each event goes out once. Returns the unsubscribe function.
 */
export function startVoicePackEvents(
  emit: VoicePackEventEmitter,
  installer: VoicePackInstaller = voicePackInstaller
): () => void {
  stopEvents?.()
  const off = installer.onChange((status) => {
    try {
      emit('voice:pack-changed', [status])
    } catch {
      // No subscriber can take it (shutdown): the next voice:pack-status read is the truth.
    }
  })
  const stop = (): void => {
    off()
    if (stopEvents === stop) stopEvents = null
  }
  stopEvents = stop
  return stop
}
