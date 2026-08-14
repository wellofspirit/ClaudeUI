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
 * the fields `CanonicalState` holds, equivalently the channels
 * `docs/architecture/sync-channels.md` marks `canonical: true`. If the reducer
 * folds it, the replica writes it.
 *
 * The complement is just as deliberate. Channels classified `canonical: false`
 * (usage, git summaries, error/warning/sandbox toasts, MCP status, auth banners,
 * vendor-auth cards, automation, mockup reloads) have **no snapshot field to fold
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
 * The lists are string literals rather than `keyof` gymnastics because the lint
 * rule needs the same names as a regex, and one source beating two is the whole
 * point. The `satisfies` clauses below are what keep them honest at compile time.
 */

import type { PerSessionSnapshot, FullStateSnapshot } from '../../../shared/remote-protocol'

/**
 * Per-session store fields written ONLY by the replica projection.
 *
 * Names are the STORE's, which differ from the wire's in exactly one place —
 * `queuedItems` mirrors `PerSessionSnapshot.queue` — so the mapping is spelled out
 * in {@link SEALED_SESSION_FIELD_SOURCE} rather than assumed.
 */
export const SEALED_SESSION_FIELDS = [
  'cwd',
  'messages',
  'streamingText',
  'streamingThinking',
  'status',
  'pendingApprovals',
  'todos',
  'sentFiles',
  'queuedItems',
  'taskNotifications',
  'activeTasks',
  'taskProgressMap',
  'subagentMessages',
  'subagentStreamingText',
  'subagentStreamingThinking',
  'permissionMode',
  'effort',
  'thinkingMode',
  'reasoningVariant',
  'statusLine',
  'metering',
  'sdkActive',
  'selectedEngineId',
  'selectedModel',
  /**
   * Not a snapshot field of its own: the per-session mirror of the app-level
   * `worktreeInfoMap`, projected from it. Sealed with the map so the two cannot
   * disagree — which they did, since `setWorktreeInfo` wrote both and
   * `session:status`'s worktree-exit rule only cleared one path.
   */
  'worktreeInfo',
  /**
   * Also not a snapshot field: a PRESENTATION clock derived from
   * `streamingThinking` (stamped when the buffer fills, cleared when the reducer
   * seals the span). Sealed because the projection is its only writer.
   */
  'thinkingStartedAt'
] as const

/** Wire field each sealed per-session store field projects from. */
export const SEALED_SESSION_FIELD_SOURCE: Readonly<
  Record<string, keyof PerSessionSnapshot | 'worktreeInfoMap'>
> = {
  cwd: 'cwd',
  messages: 'messages',
  streamingText: 'streamingText',
  streamingThinking: 'streamingThinking',
  status: 'status',
  pendingApprovals: 'pendingApprovals',
  todos: 'todos',
  sentFiles: 'sentFiles',
  queuedItems: 'queue',
  taskNotifications: 'taskNotifications',
  activeTasks: 'activeTasks',
  taskProgressMap: 'taskProgressMap',
  subagentMessages: 'subagentMessages',
  subagentStreamingText: 'subagentStreamingText',
  subagentStreamingThinking: 'subagentStreamingThinking',
  permissionMode: 'permissionMode',
  effort: 'effort',
  thinkingMode: 'thinkingMode',
  reasoningVariant: 'reasoningVariant',
  statusLine: 'statusLine',
  metering: 'metering',
  sdkActive: 'sdkActive',
  selectedEngineId: 'selectedEngineId',
  selectedModel: 'selectedModel',
  worktreeInfo: 'worktreeInfoMap',
  thinkingStartedAt: 'streamingThinking'
}

/**
 * App-level store fields written ONLY by the replica projection.
 *
 * `hiddenSessionIds` / `hiddenProjectKeys` are the store's names for the wire's
 * `hiddenSessions` / `hiddenProjects`; `slashCommands` and `sdkSkillNames` are
 * app-level here but replicated per session on the wire (an as-built quirk
 * `toSnapshot` preserves).
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
  'hiddenSessionIds',
  'hiddenProjectKeys',
  'slashCommands',
  'sdkSkillNames'
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
  hiddenSessionIds: 'hiddenSessions',
  hiddenProjectKeys: 'hiddenProjects',
  // Per-session on the wire, app-level in canonical AND in this store.
  slashCommands: 'sessions',
  sdkSkillNames: 'sessions'
}

/**
 * Per-session fields fed by `canonical: false` channels. **Deliberately not
 * sealed** — no snapshot field exists to fold into, so they are transient client
 * state that a resync drops (the as-built behavior; each belongs to its own
 * surface's later phase). Their store writers and per-channel listeners stay.
 */
export const TRANSIENT_SESSION_FIELDS = [
  'errors', // session:error, voice:error
  'warnings', // session:warning
  'sandboxViolations', // session:sandbox-violation
  'gitStatus', // git:status-update
  'vendorAuthRequired', // session:vendor-auth-required
  'bashOutputs', // session:bash-output   (volatile lane, no snapshot field)
  'backgroundOutputs', // session:background-output
  'voiceState', // voice:state   (host-local)
  'voiceInterimTranscript' // voice:transcript (host-local)
] as const

/** App-level equivalents of {@link TRANSIENT_SESSION_FIELDS}. */
export const TRANSIENT_APP_FIELDS = [
  'accountUsage', // usage:data
  'blockUsage', // usage:block-data
  'authState', // auth:state       (host-local)
  'authSource', // session:auth-source
  'vendorAuth', // derived from session:auth-source
  'accountsState', // account:changed  (host-local)
  'pluginViews' // plugin:views-changed (host-local)
] as const

export type SealedSessionField = (typeof SEALED_SESSION_FIELDS)[number]
export type SealedAppField = (typeof SEALED_APP_FIELDS)[number]
