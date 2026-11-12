/**
 * The SEALED set — SyncCore phase 4c (ADR-051 §"Clients never compute state").
 *
 * A sealed field is one the **replica fold owns**: its only writer is
 * `stores/replica.ts`, projecting `applyEvent`'s output (or a snapshot's) into the
 * store. Nothing else may `set()` it, which is what makes "would this survive a
 * crash + resync?" answerable by looking at one module instead of forty actions.
 *
 * ## Where the boundary comes from (it is not a judgement call)
 *
 * The sealed set is *derived*: it is exactly the snapshot-carried state —
 * `PerSessionSnapshot` per session, `FullStateSnapshot` app-level, equivalently
 * the fields `CanonicalState` holds, equivalently the channels `CHANNEL_SPECS`
 * (`core/shared/sync/channels.ts`) classifies `canonical: true`. If the reducer
 * folds it, the replica writes it.
 *
 * The complement is just as deliberate. Channels classified `canonical: false`
 * (usage, git summaries, error/warning/sandbox toasts, MCP status, auth banners,
 * automation, mockup reloads) have **no snapshot field to fold
 * into**: they are transient client state that a resync legitimately drops — the
 * as-built behavior, recorded in sync-channels.md rather than invented here. They
 * keep their per-channel listeners and their store writers, and
 * {@link TRANSIENT_SESSION_FIELDS} / {@link TRANSIENT_APP_FIELDS} name them so a
 * reader can tell "deliberately not sealed" from "forgotten".
 *
 * ## How the seal is enforced
 *
 * Two halves, because neither alone is enough:
 *
 *  - **Lint** (`eslint.config.mjs`, `no-restricted-syntax`): a `set(...)` call in
 *    the renderer whose object literal names a sealed key is an error outside
 *    `stores/replica.ts`. That catches the actual failure mode — someone
 *    re-introducing `setTodos` — at the point of writing.
 *  - **A guard test** (`sealed-fields.unit.test.ts`) pins the lint pattern against
 *    the lists below AND against the canonical types, so the two cannot drift: add
 *    a snapshot field without sealing it and the test fails; seal a field that is
 *    not in the snapshot and it fails too.
 *
 * The per-session list is derived from `SESSION_FIELDS` (`core/shared/sync/state.ts`)
 * and the two exception constants below, so a new canonical field is sealed without
 * an edit here. `eslint.config.mjs` reads the member names of `CanonicalSessionState`
 * itself and restates the exceptions; `sealed-fields.unit.test.ts` pins the two
 * against each other. The app-level lists stay literals.
 */

import type { FullStateSnapshot } from '../../../shared/remote-protocol'
import { SESSION_FIELDS, type CanonicalSessionState } from '../../../core/shared/sync/state'

/**
 * Canonical per-session fields with no store field: `routingId` is the record key,
 * and `seeded` is replica-internal (`hydrateReplica` reads it to set the store's
 * per-client `evicted` flag).
 */
export const SESSION_FIELDS_WITHOUT_STORE_FIELD = ['routingId', 'seeded'] as const

/** The store's name for a canonical per-session field that is named differently. */
export const STORE_NAME_OF_SESSION_FIELD = { queue: 'queuedItems' } as const

type CanonicalWithStoreField = Exclude<
  keyof CanonicalSessionState,
  (typeof SESSION_FIELDS_WITHOUT_STORE_FIELD)[number]
>
type StoreNameOf<K extends keyof CanonicalSessionState> =
  K extends keyof typeof STORE_NAME_OF_SESSION_FIELD ? (typeof STORE_NAME_OF_SESSION_FIELD)[K] : K

/** Per-session store fields written ONLY by the replica projection. */
export type SealedSessionField = StoreNameOf<CanonicalWithStoreField> | 'worktreeInfo'

/**
 * Wire field each sealed per-session store field projects from. Store names equal the
 * canonical ones except `queuedItems` (`queue`); `worktreeInfo` is not a snapshot field
 * of its own: the per-session mirror of the app-level `worktreeInfoMap`, projected from
 * it (an explicit entry wins), else synthesised from the directory listing's
 * `linkedWorktree` marker for the session's cwd. Sealed so the mirror and the map cannot
 * disagree. `session:status` no longer drops an entry on its cwd (slice 3: the status
 * cwd is always the spawn cwd, so that rule erased every detected entry); an
 * `ExitWorktree` result or an opencode `session.moved` forgets it in main instead.
 */
export const SEALED_SESSION_FIELD_SOURCE: Readonly<
  Record<SealedSessionField, keyof CanonicalSessionState | 'worktreeInfoMap'>
> = (() => {
  const source: Record<string, string> = {}
  const noStoreField: readonly string[] = SESSION_FIELDS_WITHOUT_STORE_FIELD
  const renamed: Readonly<Record<string, string>> = STORE_NAME_OF_SESSION_FIELD
  for (const key of SESSION_FIELDS) {
    if (noStoreField.includes(key)) continue
    source[renamed[key] ?? key] = key
  }
  source.worktreeInfo = 'worktreeInfoMap'
  return source as Record<SealedSessionField, keyof CanonicalSessionState | 'worktreeInfoMap'>
})()

/** The sealed per-session store fields, in `SESSION_FIELDS` order, `worktreeInfo` last. */
export const SEALED_SESSION_FIELDS = Object.keys(
  SEALED_SESSION_FIELD_SOURCE
) as readonly SealedSessionField[]

/**
 * App-level store fields written ONLY by the replica projection.
 *
 * `hiddenSessionIds` / `hiddenProjectKeys` are the store's names for the wire's
 * `hiddenSessions` / `hiddenProjects`.
 */
export const SEALED_APP_FIELDS = [
  'directories',
  'settings',
  'autoModeDisabledBySettings',
  'recentSessionIds',
  'pinnedSessionIds',
  'customTitles',
  'worktreeInfoMap',
  'sessionEngines',
  'sessionLinks',
  'sessionRefs',
  'hiddenSessionIds',
  'hiddenProjectKeys'
] as const

/** Wire field each sealed app-level store field projects from. */
export const SEALED_APP_FIELD_SOURCE: Readonly<Record<string, keyof FullStateSnapshot>> = {
  directories: 'directories',
  settings: 'settings',
  autoModeDisabledBySettings: 'autoModeDisabledBySettings',
  recentSessionIds: 'recentSessionIds',
  pinnedSessionIds: 'pinnedSessionIds',
  customTitles: 'customTitles',
  worktreeInfoMap: 'worktreeInfoMap',
  sessionEngines: 'sessionEngines',
  sessionLinks: 'sessionLinks',
  sessionRefs: 'sessionRefs',
  hiddenSessionIds: 'hiddenSessions',
  hiddenProjectKeys: 'hiddenProjects'
}

/**
 * Per-session fields fed by `canonical: false` channels. **Deliberately not
 * sealed** — no snapshot field exists to fold into, so they are transient client
 * state that a resync drops (the as-built behavior; each belongs to its own
 * surface's later phase). Their store writers and per-channel listeners stay.
 */
export const TRANSIENT_SESSION_FIELDS = [
  'errors', // session:error (voice messages go to the mic's notice pill instead)
  'warnings', // session:warning
  'sandboxViolations', // session:sandbox-violation
  'gitStatus', // git:status-update
  'bashOutputs', // session:bash-output   (volatile lane, no snapshot field)
  'backgroundOutputs', // session:background-output
  'voiceState', // voice:state   (host-local)
  'voiceInterimTranscript' // voice:transcript (host-local)
] as const

/** App-level equivalents of {@link TRANSIENT_SESSION_FIELDS}. */
export const TRANSIENT_APP_FIELDS = [
  'accountUsage', // usage:data
  'providerAccounts', // provider-account:list   (host-local read)
  'chatgptLimits', // usage:chatgpt-limits    (host-local read, nudged by usage:chatgpt-limits-changed)
  'blockUsage', // usage:block-data
  'authState', // auth:state       (host-local)
  'authSource', // session:auth-source
  'vendorAuth', // derived from session:auth-source
  'accountsState', // account:changed  (host-local)
  'pluginViews' // plugin:views-changed (host-local)
] as const

export type SealedAppField = (typeof SEALED_APP_FIELDS)[number]
