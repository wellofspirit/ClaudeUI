/**
 * "Live preview while speaking" — PER CLIENT, in this renderer's `localStorage`
 * (ADR-098 §3, ADR-101 §7), the same module shape as `mic-preference.ts`.
 *
 * It is a property of the speaker's device and patience, not of the host: a phone
 * on a slow link may want the final text only, while the desktop wants words as
 * they are said. So it never joins the synced UISettings. The voice controller
 * reads it at every start and sends it as `{ preview }` with the start; only the
 * on-device recognizer (opencode, pi and Codex sessions) has a preview to turn
 * off — cli.js ignores the field.
 *
 * Default ON. Storage can be missing or throw (a private window, blocked site
 * data), so every access is guarded and a failure reads as the default — which is
 * what an unconfigured client gets anyway.
 */

export const LIVE_PREVIEW_KEY = 'claudeui.voice.livePreview'

const listeners = new Set<(enabled: boolean) => void>()

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Only an explicit "false" turns the preview off: anything else (absent, garbled) is the default. */
function parse(raw: string | null): boolean {
  return raw !== 'false'
}

/** Is the live preview wanted on this client? Never throws. */
export function readLivePreview(): boolean {
  try {
    return parse(storage()?.getItem(LIVE_PREVIEW_KEY) ?? null)
  } catch {
    return true
  }
}

/**
 * Remember the choice. Never throws; listeners hear the new value even when
 * storage refused it, so the open Settings page reflects it for this session.
 */
export function writeLivePreview(enabled: boolean): void {
  try {
    // Both values are written: a choice made on purpose must outlive a change of
    // the default.
    storage()?.setItem(LIVE_PREVIEW_KEY, String(enabled))
  } catch {
    /* storage refused — the choice still holds for listeners this session */
  }
  for (const listener of [...listeners]) listener(enabled)
}

/** Hear changes (this window's writes, and other windows' via `storage`). */
export function onLivePreviewChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key === LIVE_PREVIEW_KEY || event.key === null) listener(parse(event.newValue))
  }
  globalThis.addEventListener?.('storage', onStorage)
  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener?.('storage', onStorage)
  }
}
