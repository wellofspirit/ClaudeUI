/**
 * The ChatGPT plan's usage as the image endpoint's last response stated it
 * (`x-codex-primary-used-percent`, `x-codex-primary-reset-after-seconds`). In memory only: it is
 * a meter for the Settings page and the job card, refreshed by every plan image call.
 */
import type { MediaPlanUsage } from '../../../shared/media-generation'

let snapshot: MediaPlanUsage | undefined

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** Read the usage headers of a plan response; keeps and returns the snapshot, or undefined when it states none. */
export function recordPlanUsage(
  headers: Headers,
  now: number = Date.now()
): MediaPlanUsage | undefined {
  const usedPercent = headerNumber(headers, 'x-codex-primary-used-percent')
  const resetsInSeconds = headerNumber(headers, 'x-codex-primary-reset-after-seconds')
  if (usedPercent === null && resetsInSeconds === null) return undefined
  snapshot = { usedPercent, resetsInSeconds, at: now }
  return snapshot
}

export function getPlanUsage(): MediaPlanUsage | undefined {
  return snapshot
}

/** Test seam. */
export function resetPlanUsage(): void {
  snapshot = undefined
}
