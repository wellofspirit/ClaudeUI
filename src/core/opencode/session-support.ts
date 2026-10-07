/**
 * Small pieces of the opencode 2.x session lifecycle shared by the chat
 * (`OpencodeSession`, S5) and the dispatcher's opencode targets
 * (`cross-engine-dispatcher.ts`, S9).
 */
import { parse as parsePath } from 'node:path'
import type { OpencodeClient } from './OpencodeClient'

/** How long a teardown waits for its interrupts and cancels before giving up. */
export const TEARDOWN_GRACE_MS = 5_000

/** How often a teardown re-reads `GET /api/session/active`. */
const ACTIVE_POLL_MS = 100
/** Every how many reads a session still active is interrupted again. */
const REINTERRUPT_EVERY = 5

/**
 * Stop what ClaudeUI runs on a LIVE server before it lets go of it: a
 * shutdown keeps a running execution's claim (opencode would resume it
 * headless on its next start), and a parked inbox item would run with it.
 *
 * Best-effort and bounded by `graceMs`: interrupt every session in `sessions`
 * (idle or not — an idle interrupt is a no-op upstream, and a turn ClaudeUI
 * has not seen yet, or a background child, runs anyway), cancel the given
 * undelivered inbox items, then wait until `GET /api/session/active` lists
 * none of `sessions` (the interrupt route answers before its cleanup
 * settles), interrupting again every few reads one that is still active (an
 * execution that started after the first interrupt, e.g. from a prompt
 * admitted meanwhile). Never rejects.
 */
export async function stopOpencodeSessions(
  client: Pick<OpencodeClient, 'interrupt' | 'cancelInbox' | 'activeSessions'>,
  sessions: readonly string[],
  inbox?: { readonly sessionID: string; readonly ids: readonly string[] },
  graceMs: number = TEARDOWN_GRACE_MS
): Promise<void> {
  let over = false
  const stop = (async () => {
    await Promise.allSettled([
      ...sessions.map((id) => Promise.resolve().then(() => client.interrupt(id))),
      ...(inbox?.ids ?? []).map((id) =>
        Promise.resolve().then(() => client.cancelInbox(inbox!.sessionID, id))
      )
    ])
    for (let read = 1; !over; read++) {
      const active = await client.activeSessions()
      const still = sessions.filter((id) => id in active)
      if (still.length === 0) return
      if (read % REINTERRUPT_EVERY === 0)
        await Promise.allSettled(
          still.map((id) => Promise.resolve().then(() => client.interrupt(id)))
        )
      await new Promise((done) => setTimeout(done, ACTIVE_POLL_MS))
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((done) => (timer = setTimeout(done, graceMs)))
  try {
    await Promise.race([stop.catch(() => {}), grace])
  } finally {
    over = true
    clearTimeout(timer)
  }
}

/**
 * The directory's git worktree root (`GET /api/location`) — where 2.x stops
 * spelling paths relatively (`permission-paths.ts`), or null outside any
 * repository. Throws when the location cannot be read.
 */
export async function locationWorktree(
  client: Pick<OpencodeClient, 'call'>
): Promise<string | null> {
  const location = await client.call('location.get', {})
  const dir = location?.project?.directory
  // A location outside any repository reports the filesystem root, which 2.x
  // does not treat as a worktree either (`file-access.ts`).
  return typeof dir === 'string' && dir !== '' && parsePath(dir).root !== dir ? dir : null
}
