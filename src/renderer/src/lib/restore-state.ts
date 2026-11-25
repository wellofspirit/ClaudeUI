/**
 * Picking up where the client left off across a restart (relaunch arc, design
 * §5): the open session and the unsent drafts, which otherwise live only in
 * this client's memory.
 *
 * - Desktop: before a relaunch main asks for {@link collectRestoreState}
 *   (`app:collect-restore`), keeps it beside the relaunch job, and the next
 *   window takes it once at startup ({@link restoreAfterRelaunch}).
 * - Web: when the host comes back on another build the page stashes the same
 *   record in sessionStorage and reloads (`src/web/build-reload.ts`), then
 *   applies it after its first sync.
 *
 * Applying opens the session through the normal cold-load path
 * (`openSessionById`) and puts each draft back on its session; an id no
 * listing knows any more is skipped.
 */

import type { RestoreRecord } from '../../../shared/relaunch'
import { useSessionStore } from '../stores/session-store'
import { openSessionById } from './session-links'
import { ensureTranscriptLoaded } from './session-history-load'

/** This client's open session and every non-empty draft. */
export function collectRestoreState(): RestoreRecord {
  const state = useSessionStore.getState()
  const drafts: Record<string, string> = {}
  for (const [id, session] of Object.entries(state.sessions))
    if (session.draftText) drafts[id] = session.draftText
  return { activeSessionId: state.activeSessionId, drafts }
}

/** Open the record's session and put its drafts back. Unknown sessions are skipped. */
export async function applyRestoreState(record: RestoreRecord): Promise<void> {
  if (record.activeSessionId) {
    try {
      await openSessionById(record.activeSessionId)
    } catch {
      /* a failed cold load leaves the welcome screen, as a click would */
    }
  }
  for (const [id, text] of Object.entries(record.drafts)) {
    if (!text) continue
    if (!useSessionStore.getState().sessions[id]) {
      try {
        if ((await ensureTranscriptLoaded(id)) === 'unlisted') continue
      } catch {
        continue
      }
    }
    // A draft typed since the restart wins over the one carried across it.
    const session = useSessionStore.getState().sessions[id]
    if (session && !session.draftText) useSessionStore.getState().setDraftText(text, id)
  }
}

let restored = false

/**
 * Desktop startup, after the first sync: take the record a relaunch left (one
 * shot on the host side too) and apply it. Runs once per renderer.
 */
export async function restoreAfterRelaunch(): Promise<void> {
  if (restored) return
  restored = true
  const record: RestoreRecord | null = await window.api.takeRestore().catch(() => null)
  if (record) await applyRestoreState(record)
}

/** Test seam: forget that the startup restore ran. */
export function resetRestoreForTests(): void {
  restored = false
}
