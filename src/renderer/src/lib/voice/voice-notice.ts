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
import type { VoiceNoticeTone } from '../../../../shared/types'

export interface VoiceNotice {
  /** Unique per notice, so a fade or a cleared warning removes only its own. */
  id: number
  text: string
  tone: VoiceNoticeTone
}

interface VoiceNoticeState {
  notices: Record<string, VoiceNotice>
  /** Show `text` for `routingId`, replacing whatever it showed. Returns the notice id. */
  show(routingId: string, text: string, tone?: VoiceNoticeTone): number
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

  show(routingId, text, tone = 'warn') {
    const id = ++nextId
    set((state) => {
      const notices = { ...state.notices }
      for (const key of keysFor(notices, routingId)) delete notices[key]
      notices[resolveRekeyed(routingId)] = { id, text, tone }
      return { notices }
    })
    return id
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
  tone: VoiceNoticeTone = 'warn'
): number {
  return useVoiceNoticeStore.getState().show(routingId, text, tone)
}

export function dismissVoiceNotice(routingId: string, id?: number): void {
  useVoiceNoticeStore.getState().dismiss(routingId, id)
}

/** Drop every notice. Test seam only. */
export function resetVoiceNoticesForTests(): void {
  useVoiceNoticeStore.setState({ notices: {} })
}
