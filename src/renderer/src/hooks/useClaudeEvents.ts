/**
 * Event wiring for the renderer — SyncCore phase 4c (the reducer half).
 *
 * Before 4c this hook was the renderer's *interpretation* of the replicated
 * stream: ~40 handlers, each mapping one channel onto one store action, in
 * parallel with `shared/sync/reducer.ts` doing the same job for canonical state.
 * Two interpretations of one stream is the shape of every divergence bug the
 * shadow comparator was built to find.
 *
 * What is left is exactly the part a reducer cannot own:
 *
 *  1. **Transient handlers** — channels classified `canonical: false`
 *     (`docs/architecture/sync-channels.md`). They have no snapshot field to fold
 *     into, so they are per-client toast/banner state and keep a real listener:
 *     errors, warnings, sandbox violations, git summaries, usage, MCP/auth
 *     banners, vendor-auth cards, bash/background tails.
 *  2. **Host-local handlers** — window chrome, native OAuth, accounts, voice,
 *     plugins. Delivered by targeted `webContents.send`, meaningless remotely.
 *  3. **Post-apply observers** — the SIDE-EFFECT halves of the deleted handlers:
 *     notifications, attention marks, the disk load a resumed `session:created`
 *     triggers, the custom-command re-scan. They run after the fold has been
 *     projected (`stores/replica.ts` §onReplicaApplied), read state, and never
 *     write a sealed field.
 *
 * Everything else — messages, streams, status, approvals, todos, tasks,
 * subagents, queue, per-session config, catalogs, registry config — is
 * `applyEvent`'s output projected by the replica.
 */

import { useEffect } from 'react'
import { onSyncEvent, markSyncReady } from '../../../core/shared/sync/client-registry'
import { useSessionStore } from '../stores/session-store'
import {
  onReplicaApplied,
  seedColdSession,
  seedWatchedSession,
  getReplicaState
} from '../stores/replica'
import type { SessionStatus, TaskNotification, SlashCommandInfo } from '../../../shared/types'

/** Send a system notification if the session is not currently focused */
function notifyIfNeeded(routingId: string, title: string, body: string): void {
  const state = useSessionStore.getState()
  // Don't notify if this session is currently active and window is focused
  if (state.activeSessionId === routingId && document.hasFocus()) return
  // Don't notify if notifications not supported or denied
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  const session = state.sessions[routingId]
  const folderName = session?.cwd.split(/[\\/]/).pop() || 'Session'
  new Notification(title, { body: `${folderName}: ${body}`, silent: false })
}

/**
 * Display name for an entered worktree: the path's last segment, falling back
 * to the branch with its `worktree-` prefix stripped.
 *
 * Splits on BOTH separators — a Windows worktree path (`D:\wt\feature-x`) has
 * no `/`, so a `/`-only split yielded the ENTIRE path as the display name
 * (RN11).
 *
 * Still exported (and still tested) even though the DETECTION moved to the main
 * process in 4c: it is presentation, recomputed from the replica and never
 * stored, which is the one kind of client-side derivation sync-core.md allows.
 */
export function deriveWorktreeName(wtPath: string, wtBranch: string): string {
  return wtPath.split(/[\\/]/).pop() || wtBranch.replace(/^worktree-/, '')
}

/**
 * Task types whose completion makes cli.js AUTO-CONTINUE the conversation.
 *
 * Upstream's own interactive busy predicate counts exactly these four and
 * deliberately excludes the rest: `local_bash` is a dev-server-shaped background
 * shell (an idle session with one running is the user's turn), and the monitor
 * types (`monitor_mcp` / `monitor_ws`) stay armed across many normal turns, so
 * counting either would silence every legitimate turn-end for the session's life.
 */
const AUTO_CONTINUING_TASK_TYPES = new Set([
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow'
])

/**
 * Is delegated work still running, so this `result` is NOT the user's turn?
 *
 * cli.js emits a normal `result` when the main agent ends its turn even while a
 * background subagent runs on; when that task finishes it auto-continues with a
 * fresh `system/init` + turn of its own. Firing "Ready for input" at the first
 * `result` tells the user they are up while the session visibly keeps working.
 *
 * `activeTasks` (reducer, `session:task-started` in / `session:task-notification`
 * out) is exact at result-time in both orderings: a mid-turn completion is folded
 * into the current turn, so its notification always precedes that turn's single
 * `result`. No pending-injection tracking is needed.
 */
export function hasAutoContinuingTask(
  activeTasks: Record<string, { taskId: string; taskType: string }>
): boolean {
  return Object.values(activeTasks).some((t) => AUTO_CONTINUING_TASK_TYPES.has(t.taskType))
}

/**
 * Was this session already resident when its `session:created` arrived?
 *
 * Captured by a PRE-fold listener, because after the fold the answer is always
 * "yes" — the reducer bootstraps the entry. The observer needs it to decide
 * whether this client is the ORIGINATOR (which already registered the session
 * locally, with its engine/model pick) or a follower learning about someone
 * else's session for the first time.
 */
const wasResidentAtCreate = new Map<string, boolean>()

// ---------------------------------------------------------------------------
// The watched-session refetch (phase 5 S4)
// ---------------------------------------------------------------------------

/**
 * How long a `session:watch-update` notify waits for its neighbours.
 *
 * A watched `.jsonl` is appended to line by line, and the WATCHER already
 * debounces at 100 ms — but a catchup replays every notify the ring held, so a
 * client coming back from a background can see N of them for one session in the
 * same tick. One refetch heals all of them: the file read is not incremental, it
 * always returns the whole current transcript.
 */
const WATCH_REFETCH_DEBOUNCE_MS = 150

/**
 * …and how long it may keep waiting.
 *
 * A trailing debounce alone STARVES exactly when it matters: the watcher emits
 * every ~100 ms while a transcript is being written, so a reset-on-each-notify
 * timer never fires for as long as the agent keeps writing — which is the whole
 * period the user is watching. The bound keeps the coalescing (a quiet burst
 * still costs one read) while guaranteeing a refetch no later than this after the
 * FIRST deferred notify.
 */
const WATCH_REFETCH_MAX_WAIT_MS = 500

interface PendingRefetch {
  timer: ReturnType<typeof setTimeout>
  /** When this burst's first notify arrived — the max-wait deadline's origin. */
  firstDeferredAt: number
}

/** Pending refetches, keyed by routingId — see {@link scheduleWatchedRefetch}. */
const watchRefetchTimers = new Map<string, PendingRefetch>()

/**
 * Answer a watch-update notify with ONE refetch through the cold-history path.
 *
 * Since S4 the event carries no transcript (the ring held hundreds of them), so
 * the content comes from the same `session:load-history` query the sidebar's
 * historical loads and the resumed-`session:created` observer use. Canonical was
 * seeded before the notify was emitted, so this read cannot see less than the
 * notify announced.
 *
 * Trailing debounce, bounded by {@link WATCH_REFETCH_MAX_WAIT_MS}: a catchup that
 * replays N notifies costs one read, and a sustained cadence still gets served.
 *
 * Two guards, both about not inventing state:
 *  - the session must still be resident when the read resolves — a delete may
 *    have landed in between, and re-minting it is exactly what F7 forbids
 *    (`seedWatchedSession` no-ops on an unknown id, and the pending timer is
 *    cancelled on `session:removed`, so the race has to lose twice);
 *  - no `sessionId`/`projectKey` on the payload (an old-shape event replayed from
 *    a pre-S4 ring, which carried its content instead) means nothing to fetch —
 *    the reducer already folded that content.
 */
function scheduleWatchedRefetch(
  routingId: string,
  sessionId: string,
  projectKey: string,
  isRetry = false
): void {
  const pending = watchRefetchTimers.get(routingId)
  const firstDeferredAt = pending?.firstDeferredAt ?? Date.now()
  if (pending) clearTimeout(pending.timer)
  const wait = Math.max(
    0,
    Math.min(WATCH_REFETCH_DEBOUNCE_MS, firstDeferredAt + WATCH_REFETCH_MAX_WAIT_MS - Date.now())
  )
  const timer = setTimeout(() => {
    watchRefetchTimers.delete(routingId)
    void refetchWatchedSession(routingId, sessionId, projectKey, isRetry)
  }, wait)
  watchRefetchTimers.set(routingId, { timer, firstDeferredAt })
}

/**
 * The read itself, plus ONE repair attempt.
 *
 * A refetch that simply gave up left a resident but un-seeded stub — an entry the
 * sidebar's resident fast-path paints as an empty chat, with no further notify
 * coming until the file changes again. One retry rides the same debounced path
 * (so a notify arriving meanwhile still coalesces with it); a second failure logs
 * and stops, because the next file change heals anyway and a self-feeding retry
 * loop against a broken read would not.
 */
async function refetchWatchedSession(
  routingId: string,
  sessionId: string,
  projectKey: string,
  isRetry: boolean
): Promise<void> {
  try {
    const { messages, taskNotifications, statusLine } = await window.api.loadSessionHistory(
      sessionId,
      projectKey
    )
    if (!getReplicaState().sessions[routingId]) return
    seedWatchedSession(routingId, { messages, taskNotifications, statusLine })
  } catch (err) {
    window.api.logError(
      'useClaudeEvents',
      `Watched refetch failed for ${sessionId}${isRetry ? ' (retry)' : ''}: ${err}`
    )
    if (isRetry) return
    // Nothing to repair if the session is gone (the delete race, again).
    if (!getReplicaState().sessions[routingId]) return
    scheduleWatchedRefetch(routingId, sessionId, projectKey, true)
  }
}

/** Drop a pending refetch — the session is gone (delete) or no longer watched. */
function cancelWatchedRefetch(routingId: string): void {
  const pending = watchRefetchTimers.get(routingId)
  if (pending === undefined) return
  clearTimeout(pending.timer)
  watchRefetchTimers.delete(routingId)
}

export function useClaudeEvents(): void {
  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    if (!window.api) {
      console.error('IPC API not available')
      return
    }

    const cleanups = [
      // -------------------------------------------------------------------
      // Pre-fold capture (see wasResidentAtCreate)
      // -------------------------------------------------------------------
      onSyncEvent('session:created', (routingId) => {
        wasResidentAtCreate.set(
          routingId,
          useSessionStore.getState().sessions[routingId] !== undefined
        )
      }),

      // -------------------------------------------------------------------
      // Transient channels (canonical: false — no snapshot field to fold into)
      // -------------------------------------------------------------------
      onSyncEvent('session:error', (routingId, error) => {
        useSessionStore.getState().addError(routingId, error)
        window.api.logError('session', `[routingId=${routingId}] ${error}`)
      }),
      onSyncEvent('session:warning', (routingId, warning) => {
        useSessionStore.getState().addWarning(routingId, warning)
      }),
      onSyncEvent('session:sandbox-violation', (routingId, message) => {
        useSessionStore.getState().addSandboxViolation(routingId, message)
      }),
      onSyncEvent('session:vendor-auth-required', (routingId, data) => {
        useSessionStore.getState().setVendorAuthRequired(routingId, data)
      }),
      onSyncEvent('session:bash-output', (routingId, data) => {
        useSessionStore
          .getState()
          .setBashOutput(routingId, data.toolUseId, data.output, data.totalLines, data.totalBytes)
      }),
      onSyncEvent('session:background-output', (routingId, data) => {
        useSessionStore
          .getState()
          .setBackgroundOutput(routingId, data.toolUseId, data.tail, data.totalSize)
      }),
      // Git status updates from polling
      onSyncEvent('git:status-update', ({ cwd, status }) => {
        const store = useSessionStore.getState()
        // Find all sessions with this cwd and update them
        for (const [routingId, session] of Object.entries(store.sessions)) {
          if (session.cwd === cwd) {
            store.setGitStatus(routingId, status)
          }
        }
      }),
      // Account usage (5hr / 7-day rate limits)
      onSyncEvent('usage:data', (data) => {
        useSessionStore.getState().setAccountUsage(data)
      }),
      // Block usage analytics
      onSyncEvent('usage:block-data', (data) => {
        useSessionStore.getState().setBlockUsage(data)
      }),
      // Auth source from session init ('none' = logged out) — drives the banner
      // Also updates the vendorAuth probe so AuthBanner reads from the probe.
      onSyncEvent('session:auth-source', (_routingId, source) => {
        const store = useSessionStore.getState()
        store.setAuthSource(source)
        // Mirror the auth-source into vendorAuth so AuthBanner can consume the probe
        // (AuthState tri-state) instead of the raw string — behavior-equivalent.
        store.setVendorAuth({
          anthropic: {
            authState: source === 'authenticated' ? 'authenticated' : 'unauthenticated',
            billingType: 'unknown',
            label: undefined
          }
        })
      }),
      onSyncEvent('voice:error', (routingId, error) => {
        useSessionStore.getState().addError(routingId, error)
      }),

      // -------------------------------------------------------------------
      // Host-local channels (targeted delivery, desktop only)
      // -------------------------------------------------------------------
      // Native OAuth login-flow transitions (ADR-014)
      window.api.onAuthState((state) => {
        const store = useSessionStore.getState()
        store.setAuthState(state)
        // The running cli.js process cached the stale credential; mark the active
        // session inactive so the next normal send respawns with fresh creds
        // (Retry does its own respawn). See ADR-014.
        if (state.status === 'success' && store.activeSessionId) {
          store.markSdkInactive(store.activeSessionId)
        }
      }),
      // Multi-account state changes (ADR-015)
      window.api.onAccountsChanged((state) => {
        useSessionStore.getState().setAccountsState(state)
      }),
      // Active account changed — respawn chat sessions against the new account
      window.api.onAccountRespawnSessions(() => {
        useSessionStore.getState().respawnAllSessions()
      }),
      // Before-quit: check for active worktrees
      window.api.onBeforeQuit(() => {
        const store = useSessionStore.getState()
        const activeWorktrees = Object.entries(store.worktreeInfoMap).map(
          ([routingId, worktreeInfo]) => ({ routingId, worktreeInfo })
        )
        if (activeWorktrees.length === 0) {
          window.api.confirmQuit()
        } else {
          store.setQuitWorktrees(activeWorktrees)
        }
      }),
      // Voice input events
      window.api.onVoiceTranscript((routingId, data) => {
        useSessionStore.getState().appendVoiceTranscript(routingId, data.text, data.isFinal)
      }),
      window.api.onVoiceState((routingId, state) => {
        useSessionStore.getState().setVoiceState(routingId, state)
      }),
      // Plugin views
      window.api.onPluginViewsChanged((views) => {
        useSessionStore.getState().setPluginViews(views)
      }),

      // -------------------------------------------------------------------
      // Post-apply observers — side effects of an already-folded event
      // -------------------------------------------------------------------
      onReplicaApplied(observeReplicatedEvent)
    ]

    // Trigger initial plugin views fetch
    window.api
      .getPluginViews()
      .then((views) => {
        useSessionStore.getState().setPluginViews(views)
      })
      .catch(() => {
        /* plugins may not be loaded yet */
      })

    // Trigger initial usage fetch
    window.api
      .fetchAccountUsage()
      .then((data) => {
        useSessionStore.getState().setAccountUsage(data)
      })
      .catch((err) => {
        window.api.logError('useClaudeEvents', `Initial usage fetch failed: ${err}`)
      })

    // Trigger initial block usage fetch
    window.api
      .fetchBlockUsage()
      .then((data) => {
        useSessionStore.getState().setBlockUsage(data)
      })
      .catch((err) => {
        window.api.logError('useClaudeEvents', `Initial block usage fetch failed: ${err}`)
      })

    // Every replicated listener above is now mounted: open the readiness gate and
    // flush whatever the host pushed while it was closed (SyncCore phase 0's
    // pre-mount buffer — docs/architecture/remote.md defect 4). One call for BOTH
    // clients: the web entry mounts this hook only after its first `sync-full`,
    // the desktop mounts it after `hydrateConfigFromDisk`, and the gate is a
    // one-way latch so a reconnect never re-arms it.
    markSyncReady()

    return () => cleanups.forEach((fn) => fn())
    // Every handler reads the store through `getState()` at call time, so the
    // effect has no store-action dependencies to re-run on. (It used to list 29,
    // every one of them a stable Zustand reference — the deps array was
    // ceremony, and each entry was a chance for the effect to tear down and
    // remount every listener mid-turn.)
  }, [])
}

/**
 * The side-effect half of each replicated channel, after its fold is committed.
 *
 * `routingId` is taken straight from `args[0]` — the wire's positional session
 * scoping. There is no `resolveRoutingId` any more: core owns the rekey and
 * re-keys its own registry in the same tick it emits the `session:status` that
 * implies one, so every LATER event already carries the new id. The one event
 * whose own id is stale is that status event itself, and its rekey target is
 * right there in the payload ({@link effectiveIdFor}).
 */
function observeReplicatedEvent(channel: string, args: unknown[]): void {
  const store = useSessionStore.getState()
  const routingId = typeof args[0] === 'string' ? args[0] : ''

  switch (channel) {
    case 'session:created': {
      const data = args[1] as
        { cwd?: string; resumeSessionId?: string; resumeSessionAt?: string } | undefined
      const wasResident = wasResidentAtCreate.get(routingId) === true
      wasResidentAtCreate.delete(routingId)
      // The reducer has already bootstrapped the entry (cwd, sdkActive, seeded);
      // `isHistorical` is view state, so it is cleared here.
      store.markSessionLive(routingId)
      if (wasResident) return
      // Another client created this session. Register it locally — recents +
      // engine map — and either follow it or flag it in the sidebar.
      const follow = store.settings.remoteFollowActions
      store.registerRemoteSession(routingId, follow)
      if (!follow) store.setNeedsAttention(routingId, true)
      if (!data?.resumeSessionId) return
      // A resumed session's transcript lives on disk. The HOST seeds its own
      // canonical copy (create-session.ts), but that seed is not an event, so
      // this replica has to read the same source for itself; `seedColdSession`
      // is idempotent and refuses to clobber live content.
      const resumeSessionId = data.resumeSessionId
      const projectKey = store.directories.find((g) =>
        g.sessions.some((s) => s.sessionId === resumeSessionId)
      )?.projectKey
      if (!projectKey) return
      // The FORK anchor rides the birth event (F3) and is passed straight
      // through: without it this client painted the parent's post-anchor turns
      // above an engine that was resumed from the truncated prefix — a
      // conversation whose visible tail the model has never seen. Absent (the
      // non-fork case, and an older host) loads the whole transcript, exactly as
      // before. Canonical's own seed passes the same value to the same loader.
      void window.api
        .loadSessionHistory(resumeSessionId, projectKey, data.resumeSessionAt)
        .then(({ messages, taskNotifications, customTitle, statusLine, warnings }) => {
          const s = useSessionStore.getState()
          if (!s.sessions[routingId]) return
          seedColdSession(routingId, {
            cwd: data.cwd ?? s.sessions[routingId].cwd,
            messages,
            taskNotifications,
            ...(statusLine ? { statusLine } : {})
          })
          if (warnings?.length) for (const w of warnings) s.addWarning(routingId, w)
          if (customTitle) s.setCustomTitle(routingId, customTitle)
          s.markSessionLive(routingId)
        })
      return
    }

    case 'session:watch-update': {
      // The fold (bootstrap + cwd) has already run; the CONTENT is a refetch
      // since S4. `args[0]` is the payload object here, not a routing id — this
      // is the one channel whose session scoping lives inside its payload.
      const payload = args[0] as
        { routingId?: string; sessionId?: string; projectKey?: string } | undefined
      const watchedId = payload?.routingId
      if (!watchedId || !payload?.sessionId || !payload?.projectKey) return
      // Evicted entries are skipped on purpose: their heavy arrays were dropped
      // to bound the heap and a reselect re-hydrates them from the same disk
      // read, so refetching one would undo the eviction it just paid for.
      if (store.sessions[watchedId]?.evicted !== false) return
      scheduleWatchedRefetch(watchedId, payload.sessionId, payload.projectKey)
      return
    }

    case 'session:removed': {
      // An in-flight refetch must not re-mint a deleted session (F7). The seed
      // itself no-ops on an unknown id; this stops the read from even starting.
      cancelWatchedRefetch(routingId)
      return
    }

    case 'session:user-message': {
      // The transcript row itself is the reducer's; bumping this session up the
      // recents list is registry config, and it persists through the save.
      store.addRecentSession(routingId)
      return
    }

    case 'session:approval-request': {
      const approval = args[1] as { toolName?: string } | undefined
      if (store.activeSessionId !== routingId || !document.hasFocus()) {
        store.setNeedsAttention(routingId, true)
      }
      notifyIfNeeded(
        routingId,
        'Permission required',
        `${approval?.toolName || 'Tool'} needs approval`
      )
      return
    }

    case 'session:status': {
      const status = args[1] as SessionStatus | undefined
      const id = effectiveIdFor(routingId, status)
      // Clear attention when a new turn starts. Nothing else is inferred from a
      // status edge (ADR-038): approvals and queue transitions are event-driven,
      // and the disconnect handling — idle + drop approvals + sdkActive false —
      // is the reducer's.
      if (status?.state === 'running') store.setNeedsAttention(id, false)
      return
    }

    case 'session:result': {
      const session = store.sessions[routingId]
      // Clear any pending vendor auth required card when a turn succeeds
      store.clearVendorAuthRequired(routingId)
      // Mark attention + notify when the agent's turn ends (user's turn)
      if (!session?.sdkActive) return
      // …unless it isn't: a `result` under a running delegated task is followed by
      // an auto-continued turn, not by the user (see hasAutoContinuingTask).
      if (hasAutoContinuingTask(session.activeTasks)) return
      if (store.activeSessionId !== routingId || !document.hasFocus()) {
        store.setNeedsAttention(routingId, true)
      }
      notifyIfNeeded(routingId, 'Ready for input', 'Claude has finished — your turn')
      return
    }

    case 'session:task-notification': {
      // The notification list and `activeTasks` are the reducer's; the stop
      // spinner and the live bash tail are per-client and die here.
      const notification = args[1] as TaskNotification | undefined
      if (notification?.toolUseId) {
        store.clearTaskStopping(routingId, notification.toolUseId)
        store.clearBashOutput(routingId, notification.toolUseId)
      }
      return
    }

    case 'session:slash-commands': {
      const commands = (args[1] ?? []) as SlashCommandInfo[]
      // The filesystem list is NOT cleared here: mergeSlashCommands already
      // gives the engine list precedence by name, so the scan can only fill
      // gaps (engines that under-report, skills added after spawn). Clearing
      // it left the fallback empty for the rest of the app's lifetime, since
      // the only other scan is keyed on cwd changes. Re-scan instead — the
      // main-process scanner caches per cwd for 30s, so this is cheap.
      const cwd = store.sessions[routingId]?.cwd
      if (cwd) {
        void window.api
          .scanCustomCommands(cwd)
          .then((names) =>
            useSessionStore.getState().setCustomCommands(names.map((name) => ({ name })))
          )
          .catch(() => {
            /* scanner failed — keep existing commands */
          })
      }
      void window.api.saveSlashCommands(commands)
      return
    }

    default:
      return
  }
}

/**
 * The id a `session:status` event's SIDE EFFECTS belong to.
 *
 * The reducer may have just moved this session to the engine's stable session id
 * (`rekeyTargetFor`), in which case the entry the observer wants is under the new
 * key and the old one no longer resolves.
 */
function effectiveIdFor(routingId: string, status: SessionStatus | undefined): string {
  const target = status?.sessionId
  if (!target || target === routingId) return routingId
  return getReplicaState().sessions[target] ? target : routingId
}
