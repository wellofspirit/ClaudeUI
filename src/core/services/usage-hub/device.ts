/**
 * This machine's identity on the usage hub (ADR-072 §5).
 *
 * Three facts leave the machine per push and this module is where each comes
 * from: a device id, a name, and the build plus OS family.
 *
 * The ID is a uuid generated ONCE into the `meta` table, not derived from a
 * hostname, a MAC address or a machine guid. A derived id would change when the
 * user renames the machine or swaps a network card, and the hub keys a device's
 * whole history on it — ADR-072 §6 keeps a retired machine's rows, so an id that
 * can change is an id that can orphan them. A stored uuid also means the hub
 * learns nothing about the machine it was not told.
 */

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getMeta, setMeta } from '../db'
import { hostAppVersion } from '../../host'

/** Where the id lives. `meta` is the key/value table v23 added for exactly this kind of marker. */
export const DEVICE_ID_META_KEY = 'hub.device_id'

/**
 * This device's id, generated on first use and kept for the machine's life.
 *
 * Deliberately NOT cleared by `forgetHub()`: a machine that is re-added to the
 * same hub must come back as the device it was, or its old rows would be
 * orphaned under an id nothing sends any more.
 */
export function deviceId(): string {
  const stored = getMeta(DEVICE_ID_META_KEY)
  if (stored !== null && stored.trim() !== '') return stored
  const fresh = randomUUID()
  setMeta(DEVICE_ID_META_KEY, fresh)
  return fresh
}

/**
 * The stored id, or null — a READ, with no side effect.
 *
 * `usage-hub:status` is a query and must not write (an audited query that
 * mutated the database was a round-2 finding), so it asks this. The generating
 * form above is called at the two moments that are already writing: enabling
 * sync, and `start()`.
 */
export function storedDeviceId(): string | null {
  const stored = getMeta(DEVICE_ID_META_KEY)
  return stored !== null && stored.trim() !== '' ? stored : null
}

/**
 * The machine's default display name.
 *
 * The hostname, because it is the name the user already calls the machine. It is
 * editable (the hub settings group, S5b) and the stored value wins — this is
 * only the seed, and the one the hub shows until someone picks better.
 */
export function defaultDeviceName(): string {
  try {
    const name = hostname()
    return name.trim() === '' ? 'this machine' : name
  } catch {
    return 'this machine'
  }
}

/** The OS FAMILY, never a build string: `win32`, `darwin`, `linux`. */
export function deviceOs(): string {
  return process.platform
}

/** The build this process is, or `unknown` — see `setHostAppVersion` in `core/host.ts`. */
export function deviceAppVersion(): string {
  return hostAppVersion()
}

/**
 * The name a push reports, from the stored one or the default.
 *
 * ONE helper for the push and for `status()`: they used to disagree — the push
 * fell back to the device uuid and the status to the hostname — so the hub's
 * machine list could show a uuid for a machine whose own settings screen showed
 * a name.
 */
export function hubDeviceName(stored: string): string {
  return stored.trim() === '' ? defaultDeviceName() : stored
}
