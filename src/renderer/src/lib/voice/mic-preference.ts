/**
 * The preferred microphone — PER CLIENT, in this renderer's `localStorage`.
 *
 * Never in the synced UISettings: a phone and the Mac have different
 * microphones, and a deviceId from one means nothing on the other. Storage can
 * be missing or throw (a private window, blocked site data), so every access is
 * guarded and a failure reads as "no preference" — the system default, which is
 * exactly what an unconfigured client gets anyway.
 *
 * Subscribers hear every change made through {@link writeMicPreference} (the
 * Settings picker and an open test meter stay in step), and a change made in
 * another window of the same origin via the `storage` event.
 */

import type { MicPreference } from './mic-devices'

export const MIC_PREFERENCE_KEY = 'claudeui.voice.micPreference'

const listeners = new Set<(preference: MicPreference | null) => void>()

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function parse(raw: string | null): MicPreference | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<MicPreference> | null
    if (!value || typeof value !== 'object') return null
    const deviceId = typeof value.deviceId === 'string' ? value.deviceId : ''
    const label = typeof value.label === 'string' ? value.label : ''
    if (!deviceId && !label) return null
    return { deviceId, label }
  } catch {
    return null
  }
}

/** The remembered microphone, or null for the system default. Never throws. */
export function readMicPreference(): MicPreference | null {
  try {
    return parse(storage()?.getItem(MIC_PREFERENCE_KEY) ?? null)
  } catch {
    return null
  }
}

/**
 * Remember `preference` (null = the system default). Never throws; listeners
 * hear the new value even when storage refused it, so the open Settings page
 * reflects the choice for this session.
 */
export function writeMicPreference(preference: MicPreference | null): void {
  try {
    const store = storage()
    if (preference) store?.setItem(MIC_PREFERENCE_KEY, JSON.stringify(preference))
    else store?.removeItem(MIC_PREFERENCE_KEY)
  } catch {
    /* storage refused — the choice still holds for listeners this session */
  }
  for (const listener of [...listeners]) listener(preference)
}

/** Hear preference changes (this window's writes, and other windows' via `storage`). */
export function onMicPreferenceChange(
  listener: (preference: MicPreference | null) => void
): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key === MIC_PREFERENCE_KEY) listener(parse(event.newValue))
  }
  globalThis.addEventListener?.('storage', onStorage)
  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener?.('storage', onStorage)
  }
}
