/**
 * What an ACTIVE ChatGPT account switch does to the Codex sessions that are
 * already running ([ADR-069](../../../docs/adr/adr-069_codex-host-per-home-and-account.md) §4).
 *
 * A Codex session is a thread on the host for ONE account (§1/§2), and the
 * account a session follows can change under it: `provider-account:switch` — and
 * removing the active account, which promotes another — re-points what "active"
 * means for every session that did not pin one. Those sessions cannot stay where
 * they are: their host is injected with the account the user has just stopped
 * using, so the next turn would bill the wrong subscription.
 *
 * They are not migrated eagerly either. Each one leaves its host and goes
 * `disconnected`, and its NEXT prompt resumes the thread on the new account's
 * host — the same continuation a Claude session makes after its process is
 * replaced (ADR-045), and the only order that works: the thread's writer lock is
 * still held by the host being left for about a minute after it is vacated, so a
 * resume issued now would have to wait for it while the user is not even asking
 * for a turn (`CodexSession.resumeThread` does that waiting, on the prompt).
 *
 * A PINNED session is untouched, including one pinned to the account that has
 * just stopped being active: a pin is a deliberate choice of identity and the
 * switch is not about it. Its host therefore keeps running, which is why the
 * followers' departure closes a host only when nothing is left on it.
 *
 * Lives in its own module, rather than inline in the boot seam, because it is
 * the one rule here worth a guard test of its own — and because `core-services`
 * may not grow engine-specific policy.
 */
import { logger } from '../services/logger'
import type { ISession } from '../providers/ISession'

const LOG_SOURCE = 'CodexHost'

/** The slice of `SessionManager` this needs. Structural, so a test fakes it. */
export interface CodexSwitchSessions {
  forEach(fn: (session: ISession) => void): void
}

/**
 * Tell every live Codex session that follows the active account to leave its
 * host. Best effort per session: one that throws must not cost the next one its
 * move, and the switch itself has already happened either way.
 */
export async function followCodexActiveAccount(
  sessions: CodexSwitchSessions,
  activeAccountId: string | null
): Promise<void> {
  const followers: Array<Promise<void>> = []
  sessions.forEach((session) => {
    if (session.engineId !== 'codex' || !session.followActiveAccount) return
    followers.push(
      session.followActiveAccount(activeAccountId).catch((error: unknown) => {
        logger.warn(
          LOG_SOURCE,
          `account switch: session ${session.routingId} could not leave its host: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    )
  })
  // One line per switch, at debug: which account won and how many live Codex
  // sessions were asked to follow it. Each session decides for itself whether it
  // moves (a pin, or a host that is already the right one, stays), so this
  // counts the ASKING — it is the line that says the boot seam is wired at all.
  logger.debug(
    LOG_SOURCE,
    `account switch: active=${activeAccountId ?? 'none'} codex sessions asked=${followers.length}`
  )
  await Promise.all(followers)
}
