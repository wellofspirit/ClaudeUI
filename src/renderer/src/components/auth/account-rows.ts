/**
 * The stored accounts a sign-in surface renders, derived from the ONE copy of
 * them in the store (ADR-070, Slice I).
 *
 * This file exists because `SignInDialog` used to hold a second copy. It read
 * `account:get` / `provider-account:list` into its own `useState` once per open
 * and mapped it there, so a freshly ADDED account — persisted under the
 * placeholder label `Account 2` before the OAuth completes, because the email is
 * not knowable until it does (`AccountManager.addAccount`) — stayed `Account 2`
 * in the dialog for the life of that open. The backfill worked: `noteLogin`
 * writes the email and the plan and broadcasts `account:changed`, which
 * `useClaudeEvents` folds into `accountsState`, which is why Settings showed the
 * right name while the dialog beside it did not. One fact, two copies, and the
 * copy the user was looking at had no way to be refreshed.
 *
 * So the mapping lives here, as a PURE function of the store's value, and the
 * dialog renders `store → rows` on every change rather than a snapshot taken at
 * open time. Pure also means unit-testable, which is what pins the ADR-068
 * rulings below — they are the interesting part of this file, not the shape
 * change.
 */

import type { AccountsState } from '../../../../shared/types'
import type { SharedProviderAccountList } from '../../../../shared/shared-provider'
import { accountDisplayName } from '../../utils/sign-in-provider'

/** One stored account, flattened out of the two providers' different shapes. */
export interface AccountRow {
  id: string
  label: string
  /** The subscription tier, as a neutral chip. */
  plan?: string
  /** The vault gave up on this credential — a danger chip, not prose. */
  expired?: boolean
  active: boolean
}

/**
 * The rows, plus whether there is anything to CHOOSE between.
 *
 * The two answers are separate on purpose (F3). "No rows" used to mean both
 * "start the flow, there is nothing to pick" and "this host has no account", and
 * Anthropic with multi-account off is the case where they disagree: one
 * credential is signed in, but there is no alternative to switch to. It
 * auto-starts like an empty list AND names its account like a full one, so the
 * chooser the user lands on after Cancel tells the truth either way.
 */
export interface AccountsView {
  rows: AccountRow[]
  /**
   * Nothing to choose between, so the dialog goes straight to its confirm
   * screen (ADR-070 Ruling 1 — the SCREEN, never the flow).
   */
  autoStart: boolean
  /**
   * Whether "+ Add account" is offered. False for Anthropic with multi-account
   * OFF: `addAccount()` would silently switch the host to file-based
   * multi-account, a Settings decision, not a side effect of cancelling a
   * sign-in.
   */
  canAdd: boolean
}

/**
 * What a surface shows when the read SETTLED on nothing it can see — the read
 * threw and no copy of the answer exists anywhere.
 *
 * `autoStart: false` so a failed read lands on the chooser rather than
 * confirming a flow against an answer nobody has, and `canAdd: true` so the
 * chooser still has its one live affordance. Both preserve, verbatim, what the
 * dialog did when its own `readAccounts` rejected.
 */
export const UNREADABLE_ACCOUNTS: AccountsView = { rows: [], autoStart: false, canAdd: true }

/**
 * `account:get`'s answer as rows (ADR-015 / ADR-068).
 *
 * `label: accountDisplayName(account.email)` keeps the fallback deliberately. A
 * placeholder label such as `Account 2` is the account's stored `email` — it is
 * the honest state of a credential whose login has not landed yet — so this
 * must NOT try to detect one and hide it. The fix for the placeholder is that it
 * stops being the truth, not that the renderer second-guesses it.
 */
export function anthropicAccountsView(state: AccountsState): AccountsView {
  const rows = state.accounts.map((account) => ({
    id: account.id,
    label: accountDisplayName(account.email),
    plan: account.subscriptionType ?? undefined,
    active: account.id === state.activeId
  }))
  if (!state.enabled) {
    // Multi-account off means ONE credential and nothing to choose between; the
    // chooser would be a list of one with no alternative. Report that one — the
    // active row, or the only one on file — rather than an empty list that would
    // read as "nobody is signed in".
    const one = rows.find((row) => row.active) ?? rows[0]
    return { rows: one ? [{ ...one, active: true }] : [], autoStart: true, canAdd: false }
  }
  return { rows, autoStart: rows.length === 0, canAdd: true }
}

/** `provider-account:list`'s answer as rows (ADR-068 §2). */
export function chatgptAccountsView(list: SharedProviderAccountList): AccountsView {
  const rows = list.accounts.map((account) => ({
    id: account.id,
    label: accountDisplayName(account.email),
    // Two facts, two chips (rule: no sentence that restates its own state).
    // `Plus · sign-in expired` was one string and the danger half of it read as
    // a footnote.
    plan: account.planType ?? undefined,
    expired: account.needsReauth === true,
    active: account.id === list.activeId
  }))
  return { rows, autoStart: rows.length === 0, canAdd: true }
}
