/**
 * Voice notices — the ONE place a voice message goes, on every client.
 *
 * Voice never writes to the session's error stack (`addError` / `FloatingError`),
 * errors included: a refused microphone or "No speech detected" is about the mic
 * button the speaker is holding, not about the conversation. Every voice message
 * is a single pill anchored above the mic (`InputBox/View.tsx`): grey for an
 * outcome, amber for an error or something to fix.
 *
 * One notice per session, and a newer one REPLACES the older — a pill stack
 * would be a second error list. The fade (held vs released, hover) is the pill's
 * business; this store only holds what to show.
 *
 * Client-local by construction: not replicated, not persisted, not in the
 * session store. Where messages come from:
 *  - main's `voice:error` (with its `tone`) — `useClaudeEvents`;
 *  - the renderer's own start/stop failures and microphone faults — `InputBox`;
 *  - the live silence warning — `InputBox`, from the voice controller.
 *
 * Keyed by routing id, read THROUGH the rekey map: a first press spawns cli.js,
 * which rekeys a brand-new session mid-capture, and a notice raised under the old
 * id must still be the one the session shows under its new one.
 */

import { create } from 'zustand'
import { resolveRekeyed } from '../../stores/replica'
import type { VoiceNoticeAction, VoiceNoticeTone } from '../../../../shared/types'

export interface VoiceNotice {
  /** Unique per notice, so a fade or a cleared warning removes only its own. */
  id: number
  text: string
  tone: VoiceNoticeTone
  /**
   * A step the speaker has to take, offered as a button in the pill (ADR-101 §6:
   * `install-voice-pack`). Carried as data from main, never inferred from `text`
   * (ADR-070). What the pill shows for it follows the speech pack's live status
   * (`voice-pack-notice.ts`), not this notice's text.
   */
  action?: VoiceNoticeAction
  /**
   * The speaker pressed the action's button: the pill follows the pack from here
   * to its outcome (progress, ready, failed, cancelled) instead of offering the
   * step again.
   */
  following?: boolean
  /**
   * What a followed notice ended as (ready, failed, cancelled — see
   * `voice-pack-notice.ts`), latched the moment it did: a later change of the
   * pack's status (a Remove in Settings during the linger) must not rewrite a
   * "ready" the speaker was just shown into "cancelled".
   */
  outcome?: VoiceNoticeOutcome
}

/** A latched outcome: exactly what the pill showed. */
export interface VoiceNoticeOutcome {
  text: string
  tone: VoiceNoticeTone
  phase: string
}

interface VoiceNoticeState {
  notices: Record<string, VoiceNotice>
  /** Show `text` for `routingId`, replacing whatever it showed. Returns the notice id. */
  show(routingId: string, text: string, tone?: VoiceNoticeTone, action?: VoiceNoticeAction): number
  /** Mark notice `id` as acted on (see {@link VoiceNotice.following}) — only if it is still the one shown. */
  follow(routingId: string, id: number): void
  /** Latch notice `id`'s outcome (see {@link VoiceNotice.outcome}) — only if it is still the one shown and has none. */
  latchOutcome(routingId: string, id: number, outcome: VoiceNoticeOutcome): void
  /**
   * Remove `routingId`'s notice — only if it is still notice `id`, when given, so
   * a stale timer or a cleared warning never removes a newer message.
   */
  dismiss(routingId: string, id?: number): void
}

let nextId = 0

/** Every stored key that names the same session as `routingId` (rekeys followed). */
function keysFor(notices: Record<string, VoiceNotice>, routingId: string): string[] {
  const live = resolveRekeyed(routingId)
  return Object.keys(notices).filter((key) => key === live || resolveRekeyed(key) === live)
}

export const useVoiceNoticeStore = create<VoiceNoticeState>((set) => ({
  notices: {},

  show(routingId, text, tone = 'warn', action) {
    const id = ++nextId
    set((state) => {
      const notices = { ...state.notices }
      // A refusal that repeats the one on screen (the speaker pressed the mic
      // again while the model downloads) must not lose what the speaker already
      // did: the replacement keeps following the download. An outcome that was
      // already latched is over — the repeat is a new offer.
      const previous = keysFor(notices, routingId)
        .map((key) => notices[key])
        .find((notice) => action !== undefined && notice.action === action)
      const following = previous?.following === true && previous.outcome === undefined
      for (const key of keysFor(notices, routingId)) delete notices[key]
      notices[resolveRekeyed(routingId)] = {
        id,
        text,
        tone,
        ...(action ? { action } : {}),
        ...(following ? { following } : {})
      }
      return { notices }
    })
    return id
  },

  follow(routingId, id) {
    set((state) => {
      const key = keysFor(state.notices, routingId).find((k) => state.notices[k].id === id)
      if (key === undefined || state.notices[key].following) return state
      return { notices: { ...state.notices, [key]: { ...state.notices[key], following: true } } }
    })
  },

  latchOutcome(routingId, id, outcome) {
    set((state) => {
      const key = keysFor(state.notices, routingId).find((k) => state.notices[k].id === id)
      if (key === undefined || state.notices[key].outcome) return state
      return { notices: { ...state.notices, [key]: { ...state.notices[key], outcome } } }
    })
  },

  dismiss(routingId, id) {
    set((state) => {
      const doomed = keysFor(state.notices, routingId).filter(
        (key) => id === undefined || state.notices[key].id === id
      )
      if (doomed.length === 0) return state
      const notices = { ...state.notices }
      for (const key of doomed) delete notices[key]
      return { notices }
    })
  }
}))

/** `routingId`'s notice, or null. Pure over the map, for selectors and tests. */
export function voiceNoticeFor(
  notices: Record<string, VoiceNotice>,
  routingId: string | null | undefined
): VoiceNotice | null {
  if (!routingId) return null
  const key = keysFor(notices, routingId)[0]
  return key === undefined ? null : notices[key]
}

/** The notice the given session's mic should show. */
export function useVoiceNotice(routingId: string | null | undefined): VoiceNotice | null {
  return useVoiceNoticeStore((state) => voiceNoticeFor(state.notices, routingId))
}

export function showVoiceNotice(
  routingId: string,
  text: string,
  tone: VoiceNoticeTone = 'warn',
  action?: VoiceNoticeAction
): number {
  return useVoiceNoticeStore.getState().show(routingId, text, tone, action)
}

/** The pill's button was pressed: follow the pack from here (see {@link VoiceNotice.following}). */
export function followVoiceNotice(routingId: string, id: number): void {
  useVoiceNoticeStore.getState().follow(routingId, id)
}

export function dismissVoiceNotice(routingId: string, id?: number): void {
  useVoiceNoticeStore.getState().dismiss(routingId, id)
}

/** The pill showed `outcome` for notice `id`: keep it that way (see {@link VoiceNotice.outcome}). */
export function latchVoiceNoticeOutcome(
  routingId: string,
  id: number,
  outcome: VoiceNoticeOutcome
): void {
  useVoiceNoticeStore.getState().latchOutcome(routingId, id, outcome)
}

/**
 * A fresh press settles an offer nobody took up: an un-pressed action notice is
 * dropped (the start either works now — the step was done elsewhere — or is
 * refused again with a new offer), while one the speaker pressed Download on is
 * left, because its download is still the news. Other notices are not touched:
 * a lingering outcome is held by the press, as it always was.
 */
export function dismissStaleVoiceOffer(routingId: string): void {
  const notice = voiceNoticeFor(useVoiceNoticeStore.getState().notices, routingId)
  if (notice?.action && !notice.following) dismissVoiceNotice(routingId, notice.id)
}

/** Drop every notice. Test seam only. */
export function resetVoiceNoticesForTests(): void {
  useVoiceNoticeStore.setState({ notices: {} })
}
