/**
 * The on-device speech pack, as this client sees it (ADR-101 §6): one store
 * behind the notice pill's Download button and Settings › Voice input's model
 * row, so both read one status and one set of in-flight commands.
 *
 * ## Where the truth is
 *
 * `voice:pack-status` is the truth; `voice:pack-changed` carries the whole status
 * on every change and, while installing, at most four times a second. The event
 * is subscribed once for the app (`useClaudeEvents`) so the store follows an
 * install another device started even while nothing is looking; consumers call
 * {@link refreshVoicePackStatus} when they appear, because the event ring
 * replays on reconnect and a stale `installing` must not outlive the install.
 * A read that was in flight when an event landed loses to it.
 *
 * ## Remote clients
 *
 * Install, cancel and remove need `admin`. A refusal is the registry's
 * "Permission denied" shape (`isPermissionDenied`) and reads as one plain
 * sentence, not as a failure of the install. `voice:pack-install` resolves only
 * when the install does, and the web transport gives up on an invoke after 30 s:
 * a timeout is an install still running on the host, so it is no error — the
 * events and the next read carry on.
 */

import { create } from 'zustand'
import type { VoicePackStatus } from '../../../../shared/voice-pack'
import { ipcErrorMessage, isInvokeTimeout, isPermissionDenied } from '../../utils/ipc-error'

/** What a refused Download says (a remote client without `admin`). */
export const VOICE_PACK_INSTALL_ADMIN_MESSAGE =
  'Installing the speech model needs admin access on this host'
/**
 * What a refused cancel or remove says, and the one read-only line Settings shows
 * once any command was refused: every write needs `admin`, so the rest would fail
 * the same way.
 */
export const VOICE_PACK_ADMIN_MESSAGE = 'Managing the speech model needs admin access on this host'

type PackCommand = 'install' | 'cancel' | 'remove'

interface VoicePackState {
  /** The host's last word, or null before the first read. */
  status: VoicePackStatus | null
  /** This client's command in flight, if any. */
  pending: PackCommand | null
  /** The last command failed (not refused): cleared by the next command or a change of state. */
  error: string | null
  /**
   * A command was refused for want of `admin`. Latched, like the harness store's:
   * the buttons would only fail the same way, so Settings swaps them for one
   * read-only line.
   */
  denied: boolean
  /**
   * The last command did not run (refused or failed): the status is not an outcome
   * of it, and the pill must not present it as one. Cleared by the next command.
   */
  commandFailed: boolean
  /** The status read failed and nothing has arrived since. */
  readFailed: boolean
}

const INITIAL: VoicePackState = {
  status: null,
  pending: null,
  error: null,
  denied: false,
  commandFailed: false,
  readFailed: false
}

export const useVoicePackStore = create<VoicePackState>(() => INITIAL)

/** Bumped by every pushed status, so an older read cannot overwrite a newer event. */
let eventSeq = 0

/** A status pushed by `voice:pack-changed`. */
export function applyVoicePackStatus(status: VoicePackStatus): void {
  eventSeq++
  // A progress tick arrives four times a second and must not wipe a failure the
  // speaker has not read yet: only a change of state does.
  useVoicePackStore.setState((prev) => ({
    status,
    readFailed: false,
    error: prev.status?.state === status.state ? prev.error : null
  }))
}

/** Re-read `voice:pack-status`. Never throws: an old host without the channel keeps the last answer. */
export async function refreshVoicePackStatus(): Promise<void> {
  const seq = eventSeq
  try {
    const status = await window.api.voicePackStatus()
    if (seq !== eventSeq) return
    useVoicePackStore.setState({ status, readFailed: false })
  } catch {
    // No host for it, or the read failed: keep the last answer. With none yet,
    // Settings says so instead of waiting forever.
    if (seq === eventSeq) useVoicePackStore.setState({ readFailed: true })
  }
}

/**
 * Send one command. Resolves to the sentence to show when it was refused or
 * failed, or null (done, or still running on the host).
 *
 * A failure is returned at once and the status re-read is left to follow: the
 * command did not change the status, and waiting for the read would let a view
 * built from the stale status stand in for the reason.
 */
async function run(
  command: PackCommand,
  send: () => Promise<unknown>,
  deniedMessage: string
): Promise<string | null> {
  useVoicePackStore.setState({ pending: command, error: null, commandFailed: false })
  let message: string | null = null
  let denied = false
  try {
    await send()
  } catch (err) {
    // An install the web transport stopped waiting for is still running.
    if (!isInvokeTimeout(err)) {
      denied = isPermissionDenied(err)
      message = denied ? deniedMessage : ipcErrorMessage(err)
    }
  }
  useVoicePackStore.setState((prev) => ({
    pending: null,
    // Settings words a refusal itself (the latched line): only a failure is an error there.
    error: denied ? null : message,
    denied: prev.denied || denied,
    commandFailed: message !== null
  }))
  if (message !== null) {
    void refreshVoicePackStatus()
    return message
  }
  // The result says how the command ended; the status says where the pack is.
  await refreshVoicePackStatus()
  return null
}

/**
 * Download and install the pack. Resolves when the install ends (or the remote
 * invoke times out); a failed INSTALL is the status' `failed`, not a rejection —
 * only a refused or broken COMMAND resolves to a message.
 */
export function installVoicePack(): Promise<string | null> {
  return run('install', () => window.api.voicePackInstall(), VOICE_PACK_INSTALL_ADMIN_MESSAGE)
}

/** Abort the install in flight, for every client. */
export function cancelVoicePackInstall(): Promise<string | null> {
  return run('cancel', () => window.api.voicePackInstallCancel(), VOICE_PACK_ADMIN_MESSAGE)
}

/** Delete the installed pack. */
export function removeVoicePack(): Promise<string | null> {
  return run('remove', () => window.api.voicePackRemove(), VOICE_PACK_ADMIN_MESSAGE)
}

/** Reset to the initial state. Test seam only. */
export function resetVoicePackStoreForTests(): void {
  eventSeq = 0
  useVoicePackStore.setState(INITIAL)
}
