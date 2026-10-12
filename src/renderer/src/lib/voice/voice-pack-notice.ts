/**
 * What the notice pill shows for a notice that carries an action (ADR-101 §6).
 *
 * Main sends the `install-voice-pack` action with a warn notice when a start
 * finds no speech pack. The pill then goes through the download in place, so this
 * is a pure function of the notice and the pack's live status:
 *
 *   offer      "Voice input for this engine needs the on-device speech model
 *              (~700 MB)" [Download] — stays until acted on (30 s once released)
 *   installing "Downloading speech model… 42%" [Cancel] — stays while it runs
 *   ready      "Speech model ready — hold the mic to talk" — an outcome, fades
 *   failed     the host's error (warn) — fades
 *   cancelled  "Speech model download cancelled" — fades
 *
 * The outcomes (`ready`, `failed`, `cancelled`) are shown only to a pill the
 * speaker pressed Download on (`notice.following`): an offer that merely finds an
 * old failure (or a stale `ready`) in the status must still offer the download. Nothing here reads the
 * notice's wording — the action is data (ADR-070).
 */

import type { VoicePackStatus } from '../../../../shared/voice-pack'
import type { VoiceNoticeTone } from '../../../../shared/types'
import type { VoiceNotice, VoiceNoticeOutcome } from './voice-notice'

/** An offer, once released, lingers this long instead of the outcome's 5 s. */
export const VOICE_NOTICE_ACTION_LINGER_MS = 30_000

export const SPEECH_MODEL_READY_TEXT = 'Speech model ready — hold the mic to talk'
export const SPEECH_MODEL_CANCELLED_TEXT = 'Speech model download cancelled'
const SPEECH_MODEL_FAILED_TEXT = 'Downloading the speech model failed'
const SPEECH_MODEL_UNSUPPORTED_TEXT = 'On-device voice input is not available on this host'

/** What the pill renders. A bare {@link VoiceNotice} is a valid view of itself. */
export interface VoiceNoticeView {
  id: number
  text: string
  tone: VoiceNoticeTone
  /** The one inline text button, if any. */
  button?: 'download' | 'cancel'
  /** Names the stage, so a view that changes under one notice id restarts the pill's linger. */
  phase?: string
  /**
   * How long the pill stays once released and not hovered. Omitted: the usual 5 s.
   * `null`: it does not fade at all (a download is running).
   */
  lingerMs?: number | null
  /**
   * A notice that asks something of the speaker can be put away (a small ×): it
   * only hides the pill, a download it follows carries on (Settings still shows it).
   */
  dismissible?: boolean
  /**
   * What a screen reader announces in place of `text`, when `text` changes too
   * often to be read out (a download's percentage): it changes with the phase only.
   */
  liveText?: string
}

/** The pack as the pill needs it: the host's status and this client's install call. */
export interface PackForNotice {
  status: VoicePackStatus | null
  /** This client's `voicePackInstall` is in flight. */
  installPending: boolean
  /**
   * This client's last pack command was REFUSED or failed (no `admin`): whatever
   * the status says, it is not an outcome of the speaker's press. The caller is
   * about to replace the notice with the reason.
   */
  commandFailed?: boolean
}

/** "42%" from a progress report, or null while the size is unknown. */
export function packProgressPercent(status: VoicePackStatus | null): number | null {
  const progress = status?.progress
  if (!progress || progress.totalBytes <= 0) return null
  return Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))
}

/** The phases that are an end of the download (as opposed to the offer and the running state). */
const OUTCOME_PHASES = new Set(['ready', 'failed', 'cancelled', 'unsupported'])

/** `view` as a latchable outcome, or null while it is the offer or a running download. */
export function outcomeOf(view: VoiceNoticeView): VoiceNoticeOutcome | null {
  return view.phase !== undefined && OUTCOME_PHASES.has(view.phase)
    ? { text: view.text, tone: view.tone, phase: view.phase }
    : null
}

export function voiceNoticeView(notice: VoiceNotice, pack: PackForNotice): VoiceNoticeView {
  if (notice.action !== 'install-voice-pack') {
    return { id: notice.id, text: notice.text, tone: notice.tone }
  }
  // Over is over: what the pill ended on stays, whatever the pack does next.
  if (notice.outcome) return { id: notice.id, ...notice.outcome }
  const state = pack.status?.state
  const following = notice.following === true && !pack.commandFailed

  // Running: by anyone's install (an offer also shows one started elsewhere), or
  // this client's press still waiting for the host's first word. `ready` beats a
  // stale pending: the host has it.
  if (state === 'installing' || (following && pack.installPending && state !== 'ready')) {
    const percent = packProgressPercent(pack.status)
    return {
      id: notice.id,
      text: `Downloading speech model…${percent === null ? '' : ` ${percent}%`}`,
      tone: 'info',
      button: 'cancel',
      phase: 'installing',
      lingerMs: null,
      dismissible: true,
      liveText: 'Downloading speech model…'
    }
  }
  // Like the other outcomes, only for a pill the speaker pressed: a `ready` in
  // a status that predates this offer (the pack was deleted behind the host's
  // back) must not flash over the offer; pressing Download on it ends here at once.
  if (following && state === 'ready') {
    return { id: notice.id, text: SPEECH_MODEL_READY_TEXT, tone: 'info', phase: 'ready' }
  }
  if (following && state === 'failed') {
    return {
      id: notice.id,
      text: pack.status?.error || SPEECH_MODEL_FAILED_TEXT,
      tone: 'warn',
      phase: 'failed'
    }
  }
  if (following && state === 'missing') {
    return { id: notice.id, text: SPEECH_MODEL_CANCELLED_TEXT, tone: 'info', phase: 'cancelled' }
  }
  if (following && state === 'unsupported') {
    return {
      id: notice.id,
      text: SPEECH_MODEL_UNSUPPORTED_TEXT,
      tone: 'warn',
      phase: 'unsupported'
    }
  }
  return {
    id: notice.id,
    text: notice.text,
    tone: notice.tone,
    button: 'download',
    phase: 'offer',
    lingerMs: VOICE_NOTICE_ACTION_LINGER_MS,
    dismissible: true
  }
}
