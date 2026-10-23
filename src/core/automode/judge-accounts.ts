/**
 * A synchronous snapshot of the vault's ChatGPT accounts, for the auto-mode FALLBACK judge's owners.
 *
 * The owners decide the fallback in synchronous code (`fallbackJudgeTransport` hook, banner text)
 * but the vault answers asynchronously, so each owner refreshes this from its already-async
 * `judgeAvailable` hook — which the judge pipeline always awaits before it would ask for a
 * fallback. Two facts are read off it: which account is ACTIVE (the primary judge's ChatGPT route
 * pays with it, so a fallback on the same model and the same account only repeats its failure) and
 * a named account's plan type (the banner label, `… (Business account)` — never an email).
 *
 * Token-free by construction: it keeps ids and plan types, nothing else. A failed refresh keeps
 * the previous snapshot; both uses are advisory (the resolver itself refuses an account that is
 * gone), so a stale snapshot costs at most a repeated failure or a plain label.
 */

import { authVault, CHATGPT_PROVIDER_ID } from '../auth/vault/AuthVault'

/** What one refresh reads from the vault. */
export interface ChatgptAccountSnapshot {
  /** The active account's vault id; null when none is active. */
  activeId: string | null
  accounts: ReadonlyArray<{ id: string; planType?: string }>
}

const EMPTY: ChatgptAccountSnapshot = { activeId: null, accounts: [] }

let snapshot: ChatgptAccountSnapshot = EMPTY

async function readVault(): Promise<ChatgptAccountSnapshot> {
  const [activeId, accounts] = await Promise.all([
    authVault.getActiveAccountId(CHATGPT_PROVIDER_ID),
    authVault.listAccounts(CHATGPT_PROVIDER_ID)
  ])
  return {
    activeId,
    accounts: accounts.map((a) => ({ id: a.id, ...(a.planType ? { planType: a.planType } : {}) }))
  }
}

/** Re-read the vault into the snapshot. `read` is for tests. Never throws. */
export async function refreshChatgptAccounts(
  read: () => Promise<ChatgptAccountSnapshot> = readVault
): Promise<void> {
  try {
    snapshot = await read()
  } catch {
    // Keep the last snapshot.
  }
}

/** The active ChatGPT account's vault id as of the last refresh; null when unknown or none. */
export function activeChatgptAccountId(): string | null {
  return snapshot.activeId
}

/** A vault account's plan type (`business`, `plus`, …) as of the last refresh. */
export function chatgptAccountPlan(accountId: string): string | undefined {
  return snapshot.accounts.find((a) => a.id === accountId)?.planType
}

/** Forget the snapshot — for tests. */
export function resetChatgptAccounts(): void {
  snapshot = EMPTY
}
