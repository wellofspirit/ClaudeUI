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
import { onSyncEvent, markSyncReady } from '../../../shared/sync/client-registry'
import { useSessionStore } from '../stores/session-store'
import { onReplicaApplied, seedColdSession, getReplicaState } from '../stores/replica'
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
 * Was this session already resident when its `session:created` arrived?
 *
 * Captured by a PRE-fold listener, because after the fold the answer is always
 * "yes" — the reducer bootstraps the entry. The observer needs it to decide
 * whether this client is the ORIGINATOR (which already registered the session
 * locally, with its engine/model pick) or a follower learning about someone
 * else's session for the first time.
 */
const wasResidentAtCreate = new Map<string, boolean>()

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
      const data = args[1] as { cwd?: string; resumeSessionId?: string } | undefined
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
      void window.api
        .loadSessionHistory(resumeSessionId, projectKey)
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
      notifyIfNeeded(routingId, 'Permission required', `${approval?.toolName || 'Tool'} needs approval`)
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
