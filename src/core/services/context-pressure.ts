/**
 * Context pressure (session tools, slice 4, spec §6.6; consult C3).
 *
 * The user picks thresholds (percent of the window) and a mode in Settings. When a live
 * session's context crosses one, at the END of a turn, ClaudeUI either asks (a banner
 * above the composer on every client) or acts (a `host-instruction` telling the session
 * to finish or park its step and call `session_hand_off`).
 *
 * Reading: the replicated `statusLine.contextWindow {used, size}` in canonical, as it is
 * after the reducer ran. `size 0` is an engine/model with no known window and never arms.
 * Turn ends are the running -> idle edge of `status.state`, the one signal every engine
 * gives (the same approach as `session-notes.ts`). Claude reports the turn's final context
 * a moment AFTER the idle status, and again after reconciling with its transcript, so a
 * reading that arrives while the session is idle after a completed turn counts as that
 * turn's end; a reading mid-turn never acts.
 *
 * Per session and threshold: armed -> fired -> handed_off | failed.
 *  - `fired`: crossed and acted on. One firing per crossing: the threshold re-arms only
 *    when usage drops below it (a compaction, a cleared conversation).
 *  - `handed_off`: the session called `session_hand_off` (see {@link noteHandedOff}). It
 *    fires nothing more until the next prompt from the user, when every threshold re-arms
 *    (C3c); the host's own instruction is not the user speaking.
 *  - `failed`: ClaudeUI asked and the turn ended without a hand-off, or delivering the
 *    instruction failed. The ask banner shows whatever the mode is (C3a).
 *
 * Only live sessions the manager holds are watched, so dispatch targets, automations and
 * side questions (which are not sessions a user types into) are never touched. A turn
 * the user stopped is not acted on, and nothing is evaluated again until another turn
 * ends: stopping an agent and being told to hand off in the same breath would be rude.
 *
 * Cost: a status or status-line event is one Map lookup and a cached settings read.
 */
import {
  contextPercent,
  handOffBlockedReason,
  handOffInstruction,
  isContextPressureAnswer,
  normalizeContextPressure,
  type ContextPressureBanner,
  type ContextPressureSetting
} from '../../shared/context-pressure'
import {
  HIDDEN_OPENCODE_SESSION_TITLES,
  OPENCODE_DISPATCH_SESSION_TITLE
} from '../../shared/dispatch-session'
import type { QueuedItem, SessionStatus } from '../../shared/types'
import type { SendPromptOptions } from '../ipc/handlers-core'
import type { SessionManager } from './session-manager'
import { titleOf } from './session-links'
import { logger } from './logger'
import { addHostObserver, emitEvent, syncCore } from './sync-host'

const LOG = 'ContextPressure'

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface ContextPressureHost {
  manager: SessionManager
  /** `handlers-core.sendPrompt` bound to the manager. */
  sendPrompt: (
    routingId: string,
    prompt: string,
    options: SendPromptOptions
  ) => void | Promise<void>
}

let host: ContextPressureHost | null = null

/** Called once by the session IPC registration; nothing acts before it. */
export function configureContextPressure(next: ContextPressureHost | null): void {
  host = next
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The instruction has been sent and its turn has not ended yet. */
interface Asked {
  percent: number
  /** The highest threshold that was crossed: the banner a failure shows re-arms with it. */
  level: number
  /**
   * The engine took the instruction in: it started a turn (idle delivery) or came off the queue
   * (busy delivery). Only the turn that ends after this decides the outcome; a turn that was
   * already running when the instruction was queued ends without having read it.
   */
  started: boolean
  /** A queue event showed the instruction waiting in the queue. */
  queued: boolean
  /** Clean turn ends seen since delivery while it was not yet taken in. */
  waited: number
}

interface Watch {
  /** A turn is running. */
  running: boolean
  /** A turn ended cleanly since the last Stop (or since the watch began). */
  turnEnded: boolean
  /** A stop was requested during the running turn. */
  stopped: boolean
  /** Thresholds crossed and acted on, until usage drops below them. */
  fired: Set<number>
  asked: Asked | null
  /** `session_hand_off` succeeded: nothing fires until the user's next prompt. */
  handedOff: boolean
  /** The threshold the current banner stands for, so re-arming it clears the banner. */
  bannerLevel: number | null
  /** Ids of consumed queue items seen in the last queue event (to spot a newly consumed one). */
  consumedSeen: Set<string>
}

const watches = new Map<string, Watch>()

function newWatch(): Watch {
  return {
    running: false,
    turnEnded: false,
    stopped: false,
    fired: new Set(),
    asked: null,
    handedOff: false,
    bannerLevel: null,
    consumedSeen: new Set()
  }
}

function watchOf(id: string): Watch {
  let w = watches.get(id)
  if (!w) {
    w = newWatch()
    watches.set(id, w)
  }
  return w
}

// ---------------------------------------------------------------------------
// Reading canonical
// ---------------------------------------------------------------------------

let settingRaw: unknown
let settingValue: ContextPressureSetting = normalizeContextPressure(undefined)

/** The setting from canonical's replicated settings; normalised once per distinct value. */
function setting(): ContextPressureSetting {
  const raw = syncCore.getCanonicalState().settings.contextPressure
  if (raw !== settingRaw) {
    settingRaw = raw
    settingValue = normalizeContextPressure(raw)
  }
  return settingValue
}

/**
 * Is this a session a user types into? Not a dispatch target or other throwaway session. Those
 * are recognised by title: `titleOf` falls back to the first user message in canonical, which for
 * an opencode dispatch target is its fixed marker title (the same test the session tools use).
 */
function eligible(id: string): boolean {
  if (!host?.manager.get(id)) return false
  const title = titleOf(id).trim()
  return (
    title !== OPENCODE_DISPATCH_SESSION_TITLE && !HIDDEN_OPENCODE_SESSION_TITLES.includes(title)
  )
}

function setBanner(id: string, banner: ContextPressureBanner | null, level: number | null): void {
  const session = syncCore.getCanonicalState().sessions[id]
  if (!session) return
  const w = watchOf(id)
  w.bannerLevel = banner ? level : null
  const held = session.contextPressure
  if (held?.kind === banner?.kind && held?.percent === banner?.percent) return
  if (!held && !banner) return
  emitEvent('session:context-pressure', [id, banner])
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Drop every fired threshold the usage is now below; a banner those stood for goes with them. */
function rearm(id: string, w: Watch, pct: number): void {
  for (const level of [...w.fired]) {
    if (level <= pct) continue
    w.fired.delete(level)
    if (w.bannerLevel === level) setBanner(id, null, null)
  }
}

function deliverInstruction(id: string, w: Watch, given: Pick<Asked, 'percent' | 'level'>): void {
  const asked: Asked = { ...given, started: false, queued: false, waited: 0 }
  const engine = syncCore.getCanonicalState().sessions[id]?.selectedEngineId ?? 'claude'
  w.asked = asked
  const sent = host
  const fail = (err: unknown): void => {
    logger.warn(LOG, `could not deliver the hand-off instruction to ${id}: ${String(err)}`)
    if (w.asked !== asked) return
    w.asked = null
    setBanner(id, { kind: 'failed', percent: asked.percent }, asked.level)
  }
  if (!sent) return fail(new Error('context pressure is not configured'))
  // Out of the observer's stack: the send starts a turn, which emits its own events.
  Promise.resolve()
    .then(() =>
      sent.sendPrompt(id, handOffInstruction(asked.percent, engine), { origin: 'host-instruction' })
    )
    .catch(fail)
}

/** The first turn end after a crossing: ask, or act. Called when a turn has just ended or a reading arrives while idle. */
function evaluate(id: string, w: Watch): void {
  if (w.running || !w.turnEnded || w.asked || w.handedOff) return
  const cfg = setting()
  if (cfg.mode === 'off') return
  const session = syncCore.getCanonicalState().sessions[id]
  const pct = contextPercent(session?.statusLine?.contextWindow)
  if (pct === null) return
  for (const level of [...w.fired]) if (!cfg.thresholds.includes(level)) w.fired.delete(level)
  const crossed = cfg.thresholds.filter((t) => t <= pct && !w.fired.has(t))
  if (crossed.length === 0 || !eligible(id)) return
  for (const level of crossed) w.fired.add(level)
  const level = Math.max(...crossed)
  const percent = Math.round(pct)
  // A session in plan mode cannot call the tool: it is asked about, never told.
  if (cfg.mode === 'ask' || handOffBlockedReason(session?.permissionMode)) {
    setBanner(id, { kind: 'ask', percent }, level)
  } else deliverInstruction(id, w, { percent, level })
}

/** A turn is over: settle the hand-off ClaudeUI asked for, else look for a crossing. */
function onTurnEnd(id: string, w: Watch, clean: boolean): void {
  const stopped = w.stopped
  w.stopped = false
  w.turnEnded = clean && !stopped
  const asked = w.asked
  // The user stopped the turn that was acting on the instruction: their own doing, not the
  // session's fault. No banner; the thresholds stay fired and the banner's Hand off is a click away.
  if (asked?.started && stopped) {
    w.asked = null
    return
  }
  // The turn that was already running when the instruction was queued ends without having read
  // it: wait for the turn that takes it in. A turn that died ends the wait.
  if (asked && !asked.started && clean) {
    asked.waited++
    // Never seen queued or consumed after two turn ends (the running one, then the one that should
    // have taken it): nothing will settle it, so it is a failure rather than a hold on the watcher.
    if (asked.queued || asked.waited < 2) return
    logger.warn(LOG, `the hand-off instruction to ${id} was never taken in; marking it failed`)
  }
  if (asked) {
    w.asked = null
    // handed_off: `noteHandedOff` already cleared `asked`, so reaching here means no hand-off.
    setBanner(id, { kind: 'failed', percent: asked.percent }, asked.level)
    return
  }
  if (w.turnEnded) evaluate(id, w)
}

/**
 * The user spoke: a handed-off session may act again. `fired` is kept: the old session still
 * holds its context after a hand-off, so the same crossing must not count twice (one new session
 * per user turn in the old one); a new firing needs usage to drop below the threshold first
 * (a compaction, /clear).
 */
function userSpoke(w: Watch): void {
  w.handedOff = false
}

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

/**
 * The id canonical keys a status's session by. A resumed session's first status names the
 * durable id in `status.sessionId` and the reducer has already rekeyed canonical to it;
 * the watch follows.
 */
function followRekey(id: string, status: SessionStatus): string {
  const durable = status.sessionId
  if (!durable || durable === id) return id
  const moved = watches.get(id)
  if (moved && !watches.has(durable)) {
    watches.delete(id)
    watches.set(durable, moved)
  }
  return durable
}

function onStatus(rawId: string, status: SessionStatus | undefined): void {
  if (!status) return
  const id = followRekey(rawId, status)
  if (!syncCore.getCanonicalState().sessions[id]) return
  // Off costs nothing: no watch is made for a session while the mode is off.
  if (!watches.has(id) && setting().mode === 'off') return
  const w = watchOf(id)
  if (status.state === 'running') {
    w.running = true
    return
  }
  const wasRunning = w.running
  w.running = false
  if (!wasRunning) return
  // idle is a turn that ended; error / disconnected is one that did not end well.
  onTurnEnd(id, w, status.state === 'idle')
}

function onStatusLine(id: string): void {
  const session = syncCore.getCanonicalState().sessions[id]
  if (!session) return
  const w = watches.get(id)
  if (!w) return
  const pct = contextPercent(session.statusLine?.contextWindow)
  if (pct === null) return
  rearm(id, w, pct)
  evaluate(id, w)
}

function onUserMessage(id: string, data: unknown): void {
  const w = watches.get(id)
  if (!w) return
  if ((data as { origin?: unknown } | undefined)?.origin === 'host-instruction') {
    // The idle delivery: the instruction started a turn.
    if (w.asked) w.asked.started = true
    return
  }
  userSpoke(w)
}

/** A queued prompt the engine just took in: the user spoke if it is not the host's own. */
function onQueueChanged(id: string, data: unknown): void {
  const w = watches.get(id)
  if (!w) return
  const items = (data as { items?: QueuedItem[] } | undefined)?.items
  if (!Array.isArray(items)) return
  const consumed = items.filter((item) => item.state === 'consumed')
  const fresh = consumed.some(
    (item) => item.origin !== 'host-instruction' && !w.consumedSeen.has(item.itemId)
  )
  const tookInstruction = consumed.some(
    (item) => item.origin === 'host-instruction' && !w.consumedSeen.has(item.itemId)
  )
  w.consumedSeen = new Set(consumed.map((item) => item.itemId))
  if (fresh) userSpoke(w)
  const asked = w.asked
  if (!asked || asked.started) return
  if (tookInstruction) asked.started = true
  else if (items.some((item) => item.state === 'queued' && item.origin === 'host-instruction')) {
    asked.queued = true
  } else if (asked.queued) {
    // It was waiting and is gone without being taken in (recalled, cleared): it was not read.
    w.asked = null
    setBanner(id, { kind: 'failed', percent: asked.percent }, asked.level)
  }
}

/**
 * A settings change takes away the prompts it made meaningless: every banner when the mode goes
 * off (a failed one too), and the banner of a threshold the user removed.
 */
function onSettingsChanged(): void {
  const cfg = setting()
  for (const [id, session] of Object.entries(syncCore.getCanonicalState().sessions)) {
    if (!session.contextPressure) continue
    const level = watches.get(id)?.bannerLevel
    if (cfg.mode === 'off' || (level != null && !cfg.thresholds.includes(level))) {
      setBanner(id, null, null)
    }
  }
}

addHostObserver((channel, args) => {
  try {
    if (channel === 'config:settings-changed') return onSettingsChanged()
    const id = args[0]
    if (typeof id !== 'string') return
    switch (channel) {
      case 'session:status':
        return onStatus(id, args[1] as SessionStatus | undefined)
      case 'session:status-line':
        return onStatusLine(id)
      case 'session:user-message':
        return onUserMessage(id, args[1])
      case 'session:queue-changed':
        return onQueueChanged(id, args[1])
      case 'session:removed':
        watches.delete(id)
        return
    }
  } catch (err) {
    logger.warn(LOG, `bookkeeping for "${channel}" failed: ${String(err)}`)
  }
})

// ---------------------------------------------------------------------------
// From the rest of core
// ---------------------------------------------------------------------------

/**
 * `session_hand_off` succeeded in this session: the hand-off ClaudeUI asked for (or the
 * user asked for in words) happened. Clears the banner and the pending ask, and holds
 * every threshold until the user's next prompt.
 */
export function noteHandedOff(routingId: string): void {
  if (!syncCore.getCanonicalState().sessions[routingId]) return
  const w = watchOf(routingId)
  w.handedOff = true
  w.asked = null
  setBanner(routingId, null, null)
}

/**
 * A stop was requested for this session. A turn the user cut short is not a moment to
 * tell the agent to wrap up: the crossing waits for a turn that ends by itself.
 */
export function noteTurnStopped(routingId: string): void {
  const w = watches.get(routingId)
  if (w?.running) w.stopped = true
}

/**
 * `session:context-pressure:respond`: the user's answer to the banner, from any client.
 * `handoff` sends the instruction (queued if the session is busy); `dismiss` only clears
 * the banner. Either way the banner is gone on every client.
 */
export function respondContextPressure(
  routingId: unknown,
  answer: unknown
): { success: boolean; error?: string } {
  if (typeof routingId !== 'string' || !isContextPressureAnswer(answer)) {
    return { success: false, error: 'Unknown context-pressure answer.' }
  }
  const banner = syncCore.getCanonicalState().sessions[routingId]?.contextPressure
  if (!banner) return { success: false, error: 'Nothing to answer: the prompt is already gone.' }
  const w = watchOf(routingId)
  if (answer === 'handoff') {
    const blocked = handOffBlockedReason(
      syncCore.getCanonicalState().sessions[routingId]?.permissionMode
    )
    if (blocked) return { success: false, error: blocked }
  }
  const level = w.bannerLevel ?? 0
  setBanner(routingId, null, null)
  if (answer === 'handoff') deliverInstruction(routingId, w, { percent: banner.percent, level })
  return { success: true }
}

/** Test seam: how many sessions are being watched. */
export function __watchCountForTests(): number {
  return watches.size
}

/** Test seam: forget every watch and the cached setting. */
export function resetContextPressureForTests(): void {
  watches.clear()
  host = null
  settingRaw = undefined
  settingValue = normalizeContextPressure(undefined)
}
