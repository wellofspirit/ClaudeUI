/**
 * The usage hub's stored configuration, and the perimeter that sanitises it
 * (ADR-072 §6).
 *
 * ## Where the credential lives, and why it is not in the vault
 *
 * A device authenticates to the hub with a Cloudflare Access service token: an
 * id and a secret, pasted in once. Three places could hold it and two are wrong.
 *
 *   - `settings.json` — no. `config:save-settings` is reachable from a remote
 *     client, so anything settings carry is remotely writable;
 *   - the auth vault — no. It is plaintext JSON at mode 0600, and ADR-072 §6's
 *     original "OS credential store through the existing vault" was wrong on
 *     both counts (there is no `safeStorage` or keytar anywhere in this app);
 *   - the operational database — yes, beside `remote_config`'s password hash,
 *     which is there for exactly this reason.
 *
 * So the row is in SQLite, `setHubSecret` is its only writer, and no read that
 * can reach an IPC channel returns it. {@link getHubConfig} answers
 * `hasSecret: boolean`; the secret itself is read once per request by
 * {@link hubCredential}, which hands it straight to a header.
 *
 * ## The URL is sanitised where it arrives
 *
 * `https:` only, with `http://localhost` and `http://127.0.0.1` allowed because
 * that is what the fake hub and a `wrangler dev` run serve on. No path, no
 * query, no fragment, and no credentials in the URL — a `https://id:secret@host`
 * form would put the token in every log line that ever prints the hub's address.
 */

import {
  deleteHubConfig,
  getHubConfigRow,
  truncateHubRemoteTables,
  upsertHubConfig,
  type HubConfigRow
} from '../db'
import { logger } from '../logger'
import { defaultDeviceName, deviceId, forgetAnnounced } from './device'

const LOG_SOURCE = 'UsageHub'

/** The config as anything outside this module may see it — no secret, ever. */
export interface HubConfigView {
  url: string
  deviceName: string
  clientId: string
  enabled: boolean
  /** Whether a device secret is stored. The secret itself never leaves the DB. */
  hasSecret: boolean
  cursorRowid: number
  remoteRev: number
  remoteWindowRev: number
  remoteEpoch: number | null
  lastPushAt: number | null
  lastPullAt: number | null
  lastError: string | null
}

/** What the `usage-hub:configure` command may set. The secret has its own channel. */
export interface HubConfigureInput {
  url: string
  deviceName: string
  clientId: string
  enabled: boolean
}

/** A URL a caller offered that this build refuses to talk to. */
export class HubUrlError extends Error {}

/**
 * Accept a hub address, or say why not.
 *
 * Returns the ORIGIN with no trailing slash, so every route is built by
 * concatenation and a configured `/v1` suffix cannot produce `/v1/v1/events`.
 */
export function sanitizeHubUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new HubUrlError('no hub URL')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new HubUrlError('not a URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new HubUrlError('credentials in a URL are not accepted')
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new HubUrlError('the hub must be https, or http on localhost')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new HubUrlError('the hub URL carries no path — the routes are under /v1/')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new HubUrlError('the hub URL carries no query or fragment')
  }
  return url.origin
}

/** The longest device name and client id this build stores. Bounded, not validated. */
const MAX_FIELD_LENGTH = 200
/** An Access service-token secret is 64 hex characters; the bound is generous. */
const MAX_SECRET_LENGTH = 512

/**
 * Accept a `usage-hub:configure` payload from the wire, or throw.
 *
 * Every field is sanitised HERE, at the perimeter, the way
 * `sanitizeDashboardRange` does: the channel is reachable from a remote client,
 * so a handler that trusted its argument would be trusting whoever is connected.
 */
export function sanitizeHubConfigureInput(raw: unknown): HubConfigureInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HubUrlError('no hub configuration was given')
  }
  const input = raw as Record<string, unknown>
  const enabled = input.enabled === true
  // An empty URL is accepted only while sync is OFF — the same rule
  // {@link configureHub} applies to the stored row. Turning the hub off must not
  // require re-typing its address, and enabling it without one would arm a
  // client that can never reach anything. Only an ABSENT or blank string counts
  // as empty: a number or an object still goes through `sanitizeHubUrl` and is
  // refused, so junk from the wire is never read as "clear the address".
  const offered = input.url
  const blank =
    offered === undefined ||
    offered === null ||
    (typeof offered === 'string' && offered.trim() === '')
  const url = blank && !enabled ? '' : sanitizeHubUrl(offered)
  return {
    url,
    deviceName: clamp(input.deviceName, MAX_FIELD_LENGTH),
    clientId: clamp(input.clientId, MAX_FIELD_LENGTH),
    enabled
  }
}

/**
 * Accept a secret from the wire.
 *
 * Length-bounded and nothing else: the value is opaque to this app, and a
 * "validation" that rejected a token Cloudflare later changes the shape of would
 * be a bug with a helpful error message. An empty string clears it.
 */
export function sanitizeHubSecret(raw: unknown): string {
  if (typeof raw !== 'string') throw new HubUrlError('no secret was given')
  const secret = raw.trim()
  if (secret.length > MAX_SECRET_LENGTH) throw new HubUrlError('that is not a service-token secret')
  return secret
}

function clamp(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** The stored row, with the secret replaced by whether there is one. */
export function getHubConfig(): HubConfigView {
  const row = getHubConfigRow()
  if (!row) {
    return {
      url: '',
      deviceName: defaultDeviceName(),
      clientId: '',
      enabled: false,
      hasSecret: false,
      cursorRowid: 0,
      remoteRev: 0,
      remoteWindowRev: 0,
      remoteEpoch: null,
      lastPushAt: null,
      lastPullAt: null,
      lastError: null
    }
  }
  return {
    url: row.url,
    deviceName: row.deviceName === '' ? defaultDeviceName() : row.deviceName,
    clientId: row.clientId,
    enabled: row.enabled,
    hasSecret: row.clientSecret !== null && row.clientSecret !== '',
    cursorRowid: row.cursorRowid,
    remoteRev: row.remoteRev,
    remoteWindowRev: row.remoteWindowRev,
    remoteEpoch: row.remoteEpoch,
    lastPushAt: row.lastPushAt,
    lastPullAt: row.lastPullAt,
    lastError: row.lastError
  }
}

/**
 * Write the non-secret settings.
 *
 * **Enabling moves no cursor** (owner, 2026-09-22, reversing the 2026-09-21
 * "start fresh" rule this used to implement). Attribution is the trust
 * boundary, not the instant sync was switched on: every properly attributed row
 * is pushed however old it is, and an `unknown` one never is. So a fresh
 * configuration syncs from rowid 0 and a re-enable keeps the mark it had — the
 * first rule cost the owner a whole day of one subscription's history, which
 * had been written before the switch was flipped at midday.
 */
export function configureHub(input: HubConfigureInput): HubConfigView {
  const before = getHubConfigRow()
  const patch: Partial<HubConfigRow> = {
    // An empty URL is accepted only while sync is OFF: turning the hub off must
    // not require re-typing the address, and turning it on without one would
    // arm a client that can never reach anything.
    url: input.url.trim() === '' && !input.enabled ? '' : sanitizeHubUrl(input.url),
    deviceName: input.deviceName.trim() === '' ? defaultDeviceName() : input.deviceName.trim(),
    clientId: input.clientId.trim(),
    enabled: input.enabled
  }
  if (input.enabled && !(before?.enabled ?? false)) {
    // A freshly enabled hub has no error to show, and the last one may be from
    // the previous configuration entirely.
    patch.lastError = null
    // The OFF → ON edge is one of the two places the device id is created (the
    // other is `start()`), and both already write. `status()` must not.
    deviceId()
  }
  upsertHubConfig(patch)
  logger.info(LOG_SOURCE, `hub configured: ${patch.enabled ? 'enabled' : 'disabled'}`)
  return getHubConfig()
}

/**
 * Store the device secret. The one writer, and it logs nothing but the fact.
 *
 * An empty string CLEARS it, which is how a user removes a token without
 * forgetting the whole hub.
 */
export function setHubSecret(secret: string): void {
  upsertHubConfig({ clientSecret: secret === '' ? null : secret })
  logger.info(LOG_SOURCE, `device secret ${secret === '' ? 'cleared' : 'stored'}`)
}

/** Forget the hub entirely: the row, the secret, and every cached remote row. */
export function forgetHub(): void {
  deleteHubConfig()
  forgetAnnounced()
  logger.info(LOG_SOURCE, 'hub forgotten — config and cached remote rows deleted')
}

/**
 * Drop the cached remote rows and BOTH watermarks, keeping the configuration.
 *
 * Both, because the buckets and the windows are paged by two independent hub
 * counters (ADR-072 §4): a reset that zeroed only the bucket rev would leave the
 * window watermark pointing into a generation that no longer exists, and every
 * later pass would ask for changes since a revision the hub had rewound past.
 */
export function resetRemoteCache(): void {
  truncateHubRemoteTables()
  upsertHubConfig({ remoteRev: 0, remoteWindowRev: 0 })
}

/** The two header values for one request, or null when the hub is not fully configured. */
export function hubCredential(): { clientId: string; clientSecret: string } | null {
  const row = getHubConfigRow()
  if (!row || row.clientId === '' || !row.clientSecret) return null
  return { clientId: row.clientId, clientSecret: row.clientSecret }
}
