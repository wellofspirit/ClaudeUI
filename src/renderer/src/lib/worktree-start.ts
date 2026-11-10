/**
 * "Start in a worktree" at the first send. A session that has not spawned carries a
 * `pendingWorktree` intent (toggle + name); the send path calls {@link createPendingWorktree}
 * just before it spawns the engine, so nothing is created while the user is still choosing.
 */
import { useSessionStore } from '../stores/session-store'
import { generateWorktreeName } from '../../../shared/worktree-start'

/** The worktree could not be made; the send stops and the welcome screen shows why. */
export class WorktreeCreateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeCreateError'
  }
}

/** What `createWorktree` throws for a directory outside any repository (not a failure here). */
const NOT_A_REPO = 'Not inside a git repository'

/** git's wording when the branch or the directory is taken. */
const ALREADY_EXISTS = /already exists/i

const SEND_DRAFT_EVENT = 'claudeui:send-draft'

/**
 * Make the worktree the session asked for, branched from the remote's default branch, and move
 * the session into it. A no-op when none was asked for, and for a directory that is not a git
 * repository. Throws {@link WorktreeCreateError} (the intent is kept, marked `failed`) otherwise.
 */
export function createPendingWorktree(routingId: string): Promise<void> {
  // One creation per session: a second caller (a voice press during a send) joins the first.
  const running = inFlight.get(routingId)
  if (running) return running
  const run = makePendingWorktree(routingId).finally(() => inFlight.delete(routingId))
  inFlight.set(routingId, run)
  return run
}

const inFlight = new Map<string, Promise<void>>()

/** Attempts at a fresh auto-generated name when it collides with an existing branch or path. */
const NAME_ATTEMPTS = 3

async function makePendingWorktree(routingId: string): Promise<void> {
  const store = useSessionStore.getState()
  const session = store.sessions[routingId]
  const pending = session?.pendingWorktree
  if (!session || !pending?.enabled || !session.cwd) return
  let name = pending.name.trim() || generateWorktreeName()
  store.setPendingWorktree(routingId, { phase: 'creating', error: undefined })
  for (let attempt = 1; ; attempt++) {
    try {
      const info = await window.api.createWorktree(session.cwd, name, { base: 'default' })
      store.setWorktreeInfo(routingId, info)
      store.setPendingWorktree(routingId, null)
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(NOT_A_REPO)) {
        store.setPendingWorktree(routingId, null)
        return
      }
      // A name the user never typed is ours to change; one they typed is theirs to fix.
      if (!pending.nameTouched && attempt < NAME_ATTEMPTS && ALREADY_EXISTS.test(message)) {
        const taken = name
        while (name === taken) name = generateWorktreeName()
        store.setPendingWorktree(routingId, { name })
        continue
      }
      window.api.logError('worktree-start', `Failed to create worktree: ${message}`)
      store.setPendingWorktree(routingId, { phase: 'failed', error: message })
      throw new WorktreeCreateError(message)
    }
  }
}

/** Ask the composer to send the session's current draft (the welcome screen's Retry buttons). */
export function requestDraftSend(routingId: string): void {
  window.dispatchEvent(new CustomEvent(SEND_DRAFT_EVENT, { detail: { routingId } }))
}

/** Listen for {@link requestDraftSend}; returns the unsubscribe. */
export function onDraftSendRequest(handler: (routingId: string) => void): () => void {
  const listener = (e: Event): void =>
    handler((e as CustomEvent<{ routingId: string }>).detail.routingId)
  window.addEventListener(SEND_DRAFT_EVENT, listener)
  return () => window.removeEventListener(SEND_DRAFT_EVENT, listener)
}
