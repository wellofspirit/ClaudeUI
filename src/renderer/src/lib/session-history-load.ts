/**
 * Read a session's transcript from the engine that owns it and put it in the
 * store — the one per-engine history load, shared by the sidebar click and by
 * the reload after a hydrate that did not carry the active transcript.
 *
 * The host does not keep an exited session's transcript (ADR-087 §2), so a
 * snapshot says `seeded: false` for it and every client reads that transcript
 * from disk itself, through the same per-engine load a sidebar click runs.
 */

import type { ChatMessage, DirectoryGroup, ModelRef, SessionInfo } from '../../../shared/types'
import {
  clearViewEvicted,
  markViewEvicted,
  setTranscriptLoadFailed,
  useSessionStore,
  type PerSessionState
} from '../stores/session-store'
import {
  evictLocalSessions,
  getReplicaState,
  patchLocalSession,
  seedColdSession,
  type HydrateOutcome
} from '../stores/replica'

/**
 * How a load ended.
 *
 *  - `loaded`   the transcript was committed.
 *  - `declined` replace mode kept the transcript the entry holds (the read failed or
 *               came back empty over it). Nothing changed, the entry stays evicted so
 *               the next click retries, and a click should still navigate to it.
 *  - `skipped`  nothing was committed and there is nothing to show — superseded, or a
 *               failure with no held transcript.
 */
export type HistoryLoadResult = 'loaded' | 'declined' | 'skipped'

export interface HistoryLoadOptions {
  /**
   * False once a newer selection superseded this load. Checked after every
   * await, before anything is committed — a slow read for a prior click must not
   * land over the session the user has since opened.
   */
  isCurrent: () => boolean
  /**
   * Codex's reader failing is user-visible (its transcript is native, and a
   * silent empty one would hide that), so the caller owns the banner.
   */
  onCodexError?: (message: string | null) => void
  /**
   * Replace the transcript the store already holds instead of filling an empty
   * one. The active session after a resync still shows its last-known
   * conversation, and `seedColdSession` refuses to clobber a held transcript, so
   * the strip and the fill happen back to back in one synchronous step — no empty
   * frame between them. A read that fails or comes back empty over a held
   * transcript changes nothing; over an EMPTY entry replace is the plain fill.
   */
  replace?: boolean
}

/**
 * Seed `sessionEngines` for a session reopened from another engine's own store,
 * before `loadHistoricalSession` reads it back.
 *
 * `model` comes from the transcript's last assistant message because a session
 * that engine created on its own has nothing persisted here, and without it the
 * composer's pill names the configured default — a model the session never ran
 * and the resume will not spawn. A model already persisted for this routing id
 * is the user's own last pick in this session and always wins.
 */
function seedHistoricalEngine(
  routingId: string,
  engineId: 'opencode' | 'pi',
  lastModel: ModelRef | null | undefined
): void {
  const state = useSessionStore.getState()
  const existing = state.sessionEngines[routingId]
  const sessionEngines = {
    ...state.sessionEngines,
    [routingId]: {
      ...existing,
      engineId,
      ...(!existing?.model && lastModel ? { model: lastModel } : {})
    }
  }
  useSessionStore.setState({ sessionEngines })
  window.api.saveSessionConfig({ sessionEngines })
}

/** Does the replica hold a transcript for this session right now? */
function holdsTranscript(routingId: string): boolean {
  return (getReplicaState().sessions[routingId]?.messages.length ?? 0) > 0
}

/**
 * Replace mode's strip. Marking the entry evicted first is what makes
 * `loadHistoricalSession` start from the resident entry (draft, mode, model and
 * `status.sessionId` survive) instead of a fresh session; the strip then empties
 * the transcript so the fill that follows takes the whole thing.
 *
 * `false` — and nothing touched — when the read is empty over a transcript the
 * replica holds: that is a read that lost its file, not a conversation that
 * ended, and blanking the view for it would be strictly worse.
 */
function stripForReplace(routingId: string, loaded: readonly ChatMessage[]): boolean {
  if (loaded.length === 0 && holdsTranscript(routingId)) return false
  markViewEvicted([routingId])
  evictLocalSessions([routingId])
  return true
}

/**
 * Load `info`'s transcript into the store ({@link HistoryLoadResult}). The caller
 * does the navigation (`switchSession`); nothing here selects a session.
 *
 * A Claude read that rejects rejects here too: the click path lets that propagate,
 * and the reload catches it and logs.
 *
 * Replace mode checks liveness at COMMIT time: the read takes seconds, and a prompt
 * sent meanwhile spawns the engine and starts folding live events into the entry. A
 * strip and `loadHistoricalSession` then would wipe the turn, stamp the running
 * session historical and reset its capabilities, so a session that went live is
 * `declined` — nothing committed, and the caller proceeds exactly as it would for a
 * resident live entry (a click still opens it, a watch still watches it) — and its
 * live fold owns it. Every caller (click, rename, watch toggle, post-hydrate reload)
 * is covered by this one check.
 */
export async function loadSessionIntoStore(
  info: SessionInfo,
  options: HistoryLoadOptions
): Promise<HistoryLoadResult> {
  const { isCurrent, onCodexError, replace = false } = options
  const routingId = info.sessionId
  const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

  // opencode sessions: load the prior transcript from opencode's own store
  // (read-only, via the global session id) so the chat view paints immediately
  // on click — parity with Claude's JSONL load. The OpencodeSession is created
  // only when the user sends a prompt; it then resumes the same session id (and
  // re-replays the same messages, idempotent by id). We seed sessionEngines with
  // engineId:'opencode' so loadHistoricalSession sets selectedEngineId, which
  // InputBox uses to pass routingId as resumeSessionId on the first createSession.
  //
  // pi sessions get the same treatment. Both resume by id on their first spawn
  // because `loadHistoricalSession` marks the entry historical, whether or not the
  // read returned messages; seeding `engineId` is all the wiring they need.
  if (info.engineId === 'opencode' || info.engineId === 'pi') {
    const engineId = info.engineId
    // Best-effort history load (empty if the engine is down) — paints the
    // transcript immediately rather than waiting for the first new prompt. The
    // status line rides along, so the cost and token figures appear with it
    // instead of only after the first new turn (S1d), and so does the model the
    // transcript last answered on.
    const loaded = await (
      engineId === 'opencode'
        ? window.api.loadOpencodeHistory(info.sessionId)
        : window.api.loadPiHistory(info.sessionId)
    ).catch(() => null)
    // A newer click superseded this one while history loaded — discard.
    if (!isCurrent()) return 'skipped'
    // A failed read paints empty on a click; over a held transcript it must not.
    if (!loaded && replace && holdsTranscript(routingId)) return 'declined'
    const { messages, statusLine, lastModel } = loaded ?? {
      messages: [] as ChatMessage[],
      statusLine: null,
      lastModel: null
    }
    // Host-run pi subagent transcripts (ADR-089) come back inline, keyed by the
    // parent `agent` call id — the Codex precedent below. opencode returns none.
    const subagentMessages =
      loaded && 'subagentMessages' in loaded ? loaded.subagentMessages : undefined
    // pi's agent notifications (ADR-089 S3): finished background runs, plus an
    // `unfinished` entry for a launch that never reported back.
    const taskNotifications =
      loaded && 'taskNotifications' in loaded ? loaded.taskNotifications : undefined
    if (replace && isLive(routingId)) return 'declined'
    if (replace && !stripForReplace(routingId, messages)) return 'declined'
    // Seed sessionEngines BEFORE loadHistoricalSession so it reads the right
    // engine (and model) — it is the one that restores both onto the session.
    seedHistoricalEngine(routingId, engineId, lastModel)
    store().loadHistoricalSession(
      routingId,
      messages,
      info.cwd,
      taskNotifications,
      subagentMessages,
      statusLine
    )
    if (info.title && info.title !== 'Untitled') store().setCustomTitle(routingId, info.title)
    return 'loaded'
  }

  if (info.engineId === 'codex') {
    const state = store()
    const sessionEngines = {
      ...state.sessionEngines,
      [routingId]: { ...state.sessionEngines[routingId], engineId: 'codex' as const }
    }
    useSessionStore.setState({ sessionEngines })
    onCodexError?.(null)
    const history = await window.api
      .loadSessionHistory(info.sessionId, info.projectKey)
      .catch(() => {
        if (isCurrent())
          onCodexError?.(
            'Codex history could not be loaded. Check the native installation/account and retry; no transcript was replaced.'
          )
        return null
      })
    if (!history)
      return replace && isCurrent() && holdsTranscript(routingId) ? 'declined' : 'skipped'
    if (!isCurrent()) return 'skipped'
    if (replace && isLive(routingId)) return 'declined'
    if (replace && !stripForReplace(routingId, history.messages)) return 'declined'
    store().loadHistoricalSession(
      routingId,
      history.messages,
      info.cwd,
      history.taskNotifications,
      // Codex's reader returns the child threads' transcripts inline (they
      // are native THREADS on the same connection, not JSONL sidecars), so
      // there is no second fetch to make here as there is for Claude.
      history.subagentMessages,
      history.statusLine,
      history.warnings
    )
    if (info.title) store().setCustomTitle(routingId, info.title)
    return 'loaded'
  }

  // Claude sessions: load from JSONL transcript
  let claude: Awaited<ReturnType<typeof window.api.loadSessionHistory>>
  try {
    claude = await window.api.loadSessionHistory(info.sessionId, info.projectKey)
  } catch (err) {
    // Over a held transcript a failed read must not take the click down with it:
    // the entry opens as it is and stays evicted. Otherwise it propagates, as the
    // click path always has.
    if (!(replace && holdsTranscript(routingId))) throw err
    // A newer click owns the view now; navigating back to this one would yank it away.
    if (!isCurrent()) return 'skipped'
    warn(
      `reading the transcript of ${routingId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return 'declined'
  }
  const { messages, taskNotifications, customTitle, agentIdToToolUseId, statusLine, warnings } =
    claude

  // Load subagent histories in parallel
  const subagentMessages: Record<string, ChatMessage[]> = {}
  const entries = Object.entries(agentIdToToolUseId)
  if (entries.length > 0) {
    const results = await Promise.all(
      entries.map(async ([agentId, toolUseId]) => {
        try {
          const msgs = await window.api.loadSubagentHistory(
            info.sessionId,
            info.projectKey,
            agentId
          )
          return { toolUseId, msgs }
        } catch {
          return { toolUseId, msgs: [] as ChatMessage[] }
        }
      })
    )
    for (const { toolUseId, msgs } of results) {
      if (msgs.length > 0) subagentMessages[toolUseId] = msgs
    }
  }
  // A newer click superseded this one while history + subagents loaded — discard.
  if (!isCurrent()) return 'skipped'
  if (replace && isLive(routingId)) return 'declined'
  if (replace && !stripForReplace(routingId, messages)) return 'declined'
  store().loadHistoricalSession(
    routingId,
    messages,
    info.cwd,
    taskNotifications,
    subagentMessages,
    statusLine,
    warnings
  )
  if (customTitle) store().setCustomTitle(routingId, customTitle)
  // todos + the Files widget are derived from the transcript INSIDE the cold-
  // history seed now (SyncCore 4c): they are sealed, and deriving them here
  // would have been a client computing state the reducer already computes.
  return 'loaded'
}

export function findSessionInfo(
  directories: readonly DirectoryGroup[],
  routingId: string
): SessionInfo | undefined {
  for (const group of directories) {
    const found = group.sessions.find((s) => s.sessionId === routingId)
    if (found) return found
  }
  return undefined
}

/**
 * Is this evicted entry idle, so a sidebar click may reload it from disk?
 *
 * An idle evicted entry may still hold a stale tail (a resync's kept transcript
 * whose reload never landed), and the fill-only seed would keep it, so the click
 * replaces; for an empty entry replace is the same plain fill. A LIVE entry is not
 * reloaded at all: a replace over a streaming session could wipe the turn in flight,
 * and a fill-only load would stamp it historical. The live fold and
 * {@link loadResumedTranscript} own it, and the click just opens it. `undefined` is
 * a session this client has never loaded — nothing to replace.
 */
export function replaceOnClick(
  session: Pick<PerSessionState, 'sdkActive' | 'status'> | undefined
): boolean {
  return session !== undefined && !isLiveSession(session)
}

/**
 * Is an engine up for this session, or a turn running? A live session's transcript
 * is being folded from events, so nothing may replace it or stamp it historical.
 */
function isLiveSession(session: Pick<PerSessionState, 'sdkActive' | 'status'>): boolean {
  return session.sdkActive || session.status.state === 'running'
}

/**
 * Does a sidebar click open this entry as it is, with no disk read? True for a
 * session that is resident and either holds its transcript or is LIVE (see
 * {@link replaceOnClick}); false for one never loaded and for an idle evicted one.
 */
export function opensResident(
  session: Pick<PerSessionState, 'evicted' | 'sdkActive' | 'status'> | undefined
): boolean {
  return session !== undefined && (!session.evicted || isLiveSession(session))
}

/**
 * Make sure the transcript a sidebar action needs (auto-rename, the watch toggle) is
 * in memory, through the same per-engine load a click runs. A resident entry —
 * holding its transcript, or live — is used as it is and nothing is read; a session
 * absent from the listing cannot be loaded.
 */
export async function ensureTranscriptLoaded(
  routingId: string
): Promise<HistoryLoadResult | 'resident' | 'unlisted'> {
  const state = useSessionStore.getState()
  const session = state.sessions[routingId]
  if (opensResident(session)) return 'resident'
  const info = findSessionInfo(state.directories, routingId)
  if (!info) return 'unlisted'
  return loadSessionIntoStore(info, { isCurrent: () => true, replace: replaceOnClick(session) })
}

function isLive(routingId: string): boolean {
  const session = useSessionStore.getState().sessions[routingId]
  return session !== undefined && isLiveSession(session)
}

function warn(message: string): void {
  window.api?.logRelay?.('warn', 'SessionHistory', message)
}

/** Reloads in flight, by routing id — see {@link awaitTranscriptReload}. */
const reloadsInFlight = new Map<string, Promise<void>>()

/** Test seam: forget every reload in flight (module state outlives a test). */
export function resetHistoryLoadForTests(): void {
  reloadsInFlight.clear()
}

/**
 * The active-session reload in flight for `routingId`, or `undefined`.
 *
 * A prompt sent from an evicted, empty entry spawns the engine, and the host seeds
 * its own transcript from the same file as soon as it is created. If the client's
 * read is still open when the first turn folds in, the fill refuses (it would
 * clobber live events) and the sender sees only the new turn. Waiting for this
 * promise first lets the history land. It resolves on every outcome, so it can be
 * awaited without a catch.
 */
export function awaitTranscriptReload(routingId: string): Promise<void> | undefined {
  return reloadsInFlight.get(routingId)
}

/**
 * Before a lazy spawn: if this entry is evicted and empty and its reload is still
 * in flight, wait for it ({@link awaitTranscriptReload}). With no reload in flight
 * (it already failed, or never started) this returns at once and the spawn resumes
 * by id as it would anyway.
 */
export async function awaitReloadBeforeSpawn(routingId: string): Promise<void> {
  const session = useSessionStore.getState().sessions[routingId]
  if (!session?.evicted || session.messages.length > 0) return
  await awaitTranscriptReload(routingId)
}

/**
 * After a hydrate whose snapshot did not carry the ACTIVE session's transcript
 * (`hydrateReplica` named it), read it from disk and replace. Also the Retry of the
 * "couldn't load" state.
 *
 * The listing comes from the replicated `directories`: it is what knows the
 * session's engine and project key, and it arrives in the same snapshot. A session
 * that is not listed, or a read that fails, leaves the view exactly as it is — on
 * a resync that is the last-known transcript — and says why.
 *
 * Bails if the session stopped being the active one, or went live, while the read
 * was in flight: a live session's transcript is being folded from events, and a
 * disk read that began before them would wipe the turn.
 *
 * When it bails for any reason but "went live" the entry is marked evicted. A
 * resync keeps the local transcript on screen unmarked, expecting this read to
 * replace it; if the read never lands, that transcript may be a truncated tail,
 * and an unmarked entry would take the sidebar's resident fast path and be shown
 * as complete forever. Marked, the next click reloads it. The entry is also
 * flagged as failed, which is what turns an empty chat's spinner into a Retry.
 */
export function reloadActiveTranscript(routingId: string): Promise<void> {
  const running = runReload(routingId).finally(() => {
    if (reloadsInFlight.get(routingId) === running) reloadsInFlight.delete(routingId)
  })
  reloadsInFlight.set(routingId, running)
  return running
}

async function runReload(routingId: string): Promise<void> {
  setTranscriptLoadFailed(routingId, false)
  const info = findSessionInfo(useSessionStore.getState().directories, routingId)
  let result: HistoryLoadResult = 'skipped'
  try {
    if (!info) {
      warn(
        `active session ${routingId} is not in the directory listing; its transcript was not reloaded`
      )
    } else {
      result = await loadSessionIntoStore(info, {
        isCurrent: () => {
          const state = useSessionStore.getState()
          return (
            state.activeSessionId === routingId &&
            state.sessions[routingId] !== undefined &&
            !isLive(routingId)
          )
        },
        replace: true,
        onCodexError: (message) => {
          if (message) warn(`${message} (session ${routingId})`)
        }
      })
    }
  } catch (err) {
    warn(
      `reloading the transcript of ${routingId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (result === 'loaded' || isLive(routingId)) return
  markViewEvicted([routingId])
  setTranscriptLoadFailed(routingId, true)
}

/**
 * A fill that cannot happen (no listing, or the read failed) must not leave a live,
 * empty, evicted entry on "Loading conversation..." with no way out: the Retry path
 * refuses a live session, and the live fold decides what the chat shows. The flag
 * is dropped only while the entry is still empty — a held tail keeps it, so the
 * next idle click replaces that.
 */
function releaseEmptyEvicted(routingId: string): void {
  const session = useSessionStore.getState().sessions[routingId]
  if (session?.evicted && session.messages.length === 0) clearViewEvicted([routingId])
}

/**
 * Fill a LIVE session's transcript from disk the way a follower of a resume does:
 * `seedColdSession` is fill-only, so events that already streamed in win, and no
 * view patch or `loadHistoricalSession` runs over the live entry.
 *
 * Two callers need exactly this: the `session:created`-with-resume observer (a
 * client that learns of a resume as it happens) and a hydrate whose snapshot
 * carries a live session whose own history read had not landed yet. In both the
 * host's seed is not an event, so nothing else brings the transcript here.
 *
 * Bound: if live events already folded into the entry, the fill refuses (it would
 * clobber them). The entry then keeps its evicted flag and reads as unseeded, so the
 * next click once it is idle replaces the tail from disk.
 *
 * Silent when the session is not in the directory listing — a brand-new resume
 * races its own listing, and the fill cannot know where to read without it.
 */
export async function loadResumedTranscript(
  routingId: string,
  resume: { resumeSessionId: string; resumeSessionAt?: string; cwd?: string }
): Promise<void> {
  const projectKey = findSessionInfo(
    useSessionStore.getState().directories,
    resume.resumeSessionId
  )?.projectKey
  if (!projectKey) {
    releaseEmptyEvicted(routingId)
    return
  }
  try {
    // The FORK anchor is passed straight through: without it a fork painted the
    // parent's post-anchor turns above an engine resumed from the truncated
    // prefix. Absent loads the whole transcript, as canonical's own seed does.
    const { messages, taskNotifications, customTitle, statusLine, warnings } =
      await window.api.loadSessionHistory(
        resume.resumeSessionId,
        projectKey,
        resume.resumeSessionAt
      )
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    if (!session) return
    const wasSeeded = getReplicaState().sessions[routingId]?.seeded
    const filled = seedColdSession(routingId, {
      cwd: resume.cwd ?? session.cwd,
      messages,
      taskNotifications,
      ...(statusLine ? { statusLine } : {})
    })
    if (warnings?.length) for (const w of warnings) state.addWarning(routingId, w)
    if (customTitle) state.setCustomTitle(routingId, customTitle)
    state.markSessionLive(routingId)
    if (filled) {
      // The transcript is here now, so the entry stops being one the sidebar would
      // reload from disk over a live session.
      if (session.evicted) clearViewEvicted([routingId])
      setTranscriptLoadFailed(routingId, false)
    } else if (wasSeeded === false) {
      // Refused: live events got there first, so the entry holds a tail. It must
      // not read as complete — it keeps its evicted flag, and the next click once
      // it is idle replaces it from disk (`replaceOnClick`).
      patchLocalSession(routingId, { seeded: false })
    }
  } catch (err) {
    releaseEmptyEvicted(routingId)
    warn(
      `loading the resumed transcript of ${routingId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * What a client does after `hydrateReplica`: read the active session's transcript
 * from disk when the snapshot did not carry it, and fill every live session whose
 * transcript the host had not read yet. Both entry points call this next to the
 * hydrate.
 *
 * Best-effort by construction: whatever goes wrong here is logged and swallowed, so a
 * post-hydrate read can never stop the app from rendering.
 */
export function finishHydrate(outcome: HydrateOutcome): void {
  try {
    if (outcome.reloadActive) void reloadActiveTranscript(outcome.reloadActive)
    for (const routingId of outcome.fillResumed) {
      const session = getReplicaState().sessions[routingId]
      void loadResumedTranscript(routingId, {
        resumeSessionId: session?.status.sessionId ?? routingId,
        cwd: session?.cwd
      })
    }
  } catch (err) {
    warn(`post-hydrate reads could not start: ${err instanceof Error ? err.message : String(err)}`)
  }
}
