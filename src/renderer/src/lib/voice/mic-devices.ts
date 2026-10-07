/**
 * Which microphone to open — pure, so the whole policy is a unit-test table.
 *
 * The policy (Daniel, 2026-10-06): a PREFERRED microphone is used whenever it is
 * connected; otherwise the SYSTEM DEFAULT is, and a capture follows the default
 * when it changes mid-press. The preference is per client (`mic-preference.ts`):
 * a phone and the Mac have different microphones.
 *
 * Browser facts this leans on:
 *  - Chromium lists two SYNTHETIC inputs: `default` (whatever the OS default is
 *    right now — labelled "Default - <name>", sharing the real device's
 *    `groupId`) and, on Windows, `communications`. The first is how an OS default
 *    change is visible at all; the second is never what anyone means.
 *  - Firefox and Safari have no `default` entry; the first input is the default.
 *  - A `deviceId` can ROTATE (cleared site data, a new browser profile, some
 *    Bluetooth reconnects), so a preference also remembers the label and matches
 *    on it exactly when the id is gone.
 *  - Before microphone permission, labels (and on some browsers ids) are empty.
 */

/** One audio input, reduced to what the policy reads. */
export interface MicDevice {
  deviceId: string
  label: string
  groupId: string
}

/** A remembered choice. `null` everywhere means "the system default". */
export interface MicPreference {
  deviceId: string
  label: string
}

export const DEFAULT_DEVICE_ID = 'default'
const COMMUNICATIONS_DEVICE_ID = 'communications'

/**
 * Where a capture should be bound:
 *  - `preferred`: the remembered microphone, which is connected;
 *  - `default`: the system default — because there is no preference, or because
 *    the preferred one is not connected (`preferredMissing`).
 */
export type MicTarget =
  | { kind: 'preferred'; device: MicDevice }
  | { kind: 'default'; device: MicDevice | null; preferredMissing: boolean }

/** The audio inputs of an `enumerateDevices()` answer, `communications` dropped. */
export function audioInputs(devices: ReadonlyArray<Partial<MediaDeviceInfo>>): MicDevice[] {
  const inputs: MicDevice[] = []
  for (const d of devices) {
    if (d.kind !== 'audioinput') continue
    if (d.deviceId === COMMUNICATIONS_DEVICE_ID) continue
    inputs.push({ deviceId: d.deviceId ?? '', label: d.label ?? '', groupId: d.groupId ?? '' })
  }
  return inputs
}

/** The real microphones — the synthetic `default` entry left out. */
export function realInputs(inputs: readonly MicDevice[]): MicDevice[] {
  return inputs.filter((d) => d.deviceId !== DEFAULT_DEVICE_ID)
}

/** Chromium's synthetic `default` entry, if this browser has one. */
export function defaultEntry(inputs: readonly MicDevice[]): MicDevice | null {
  return inputs.find((d) => d.deviceId === DEFAULT_DEVICE_ID) ?? null
}

/**
 * The real device behind the system default: the input sharing the `default`
 * entry's `groupId` (Chromium), else the first input (Firefox, Safari), else the
 * `default` entry itself when it is all there is.
 */
export function systemDefault(inputs: readonly MicDevice[]): MicDevice | null {
  const entry = defaultEntry(inputs)
  const real = realInputs(inputs)
  if (entry) {
    const twin = entry.groupId ? real.find((d) => d.groupId === entry.groupId) : undefined
    return twin ?? entry
  }
  return real[0] ?? null
}

/** The system default's name, without Chromium's "Default - " prefix. Empty if unknown. */
export function systemDefaultLabel(inputs: readonly MicDevice[]): string {
  const device = systemDefault(inputs)
  if (!device) return ''
  return device.label.replace(/^Default\s*[-–—]\s*/, '')
}

/** The connected device a preference names: by id, else (ids rotate) by exact label. */
export function findPreferred(
  inputs: readonly MicDevice[],
  preference: MicPreference | null
): MicDevice | null {
  if (!preference) return null
  const real = realInputs(inputs)
  const byId = preference.deviceId
    ? real.find((d) => d.deviceId === preference.deviceId)
    : undefined
  if (byId) return byId
  if (!preference.label) return null
  return real.find((d) => d.label === preference.label) ?? null
}

/** Where to bind, given what is connected and what was chosen. */
export function resolveMic(
  inputs: readonly MicDevice[],
  preference: MicPreference | null
): MicTarget {
  const preferred = findPreferred(inputs, preference)
  if (preferred) return { kind: 'preferred', device: preferred }
  return { kind: 'default', device: systemDefault(inputs), preferredMissing: preference !== null }
}

/**
 * Does the live track already sit where `target` says? A capture switches only
 * when this is false.
 *
 * Preferred: the track's `deviceId` is the preferred device's. Default: the
 * capture must not be bound to an explicit device (it was preferred and has now
 * gone), and when Chromium's `default` entry is visible its `groupId` must be the
 * track's — that is how an OS default change shows. Without a `default` entry
 * (Firefox, Safari) a default change is invisible, and only an unplug moves it.
 */
export function trackMatchesTarget(
  target: MicTarget,
  live: { boundTo: 'preferred' | 'default'; deviceId: string; groupId: string },
  inputs: readonly MicDevice[]
): boolean {
  if (target.kind === 'preferred') return live.deviceId === target.device.deviceId
  if (live.boundTo === 'preferred') return false
  const entry = defaultEntry(inputs)
  if (!entry || !entry.groupId || !live.groupId) return true
  return entry.groupId === live.groupId
}
