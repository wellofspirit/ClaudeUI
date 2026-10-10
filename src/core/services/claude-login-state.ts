/**
 * The Claude login signal carried by a cli.js `initialize` response — the one
 * source of the sign-in banner and of `ClaudeAuthProvider`'s probe (ADR-014).
 *
 * In single-account mode (and under a custom endpoint profile) it is cli.js's
 * own word: a present `account.email` is logged in. Under a host token
 * (multi-account, `sdk/host-token.ts`) cli.js reports
 * `{tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty"}` and no
 * email at all, so that rule would call every signed-in account signed out.
 * There the ACTIVE account answers instead: its credential says whether it is
 * signed in (`hostTokenLogin`), and its `account` row says who it is, since
 * that is what the app recorded at sign-in.
 */

import type { OAuthAccount } from '../../shared/types'
import { accountState } from '../host'
import { hostTokenLogin } from './claude-host-token'

export interface ClaudeLoginSignal {
  loggedIn: boolean
  /** The account to show, or null when the response carried none. */
  account: OAuthAccount | null
}

/** Read the login signal out of an initialize response's `account`. */
export function claudeLoginSignal(initAccount: unknown): ClaudeLoginSignal {
  const account = initAccount as Record<string, unknown> | null | undefined
  const reported: OAuthAccount | null = account
    ? {
        email: (account.email as string | null) ?? null,
        organization: (account.organization as string | null) ?? null,
        subscriptionType: (account.subscriptionType as string | null) ?? null,
        tokenSource: (account.tokenSource as string | null) ?? null,
        apiKeySource: (account.apiKeySource as string | null) ?? null,
        apiProvider: (account.apiProvider as string | null) ?? null
      }
    : null

  const login = hostTokenLogin()
  if (!login) return { loggedIn: !!reported?.email, account: reported }

  const state = accountState()
  const active = state?.accounts.find((a) => a.id === state.activeId)
  return {
    loggedIn: login.signedIn,
    account: {
      email: active?.email ?? null,
      organization: active?.organization ?? null,
      subscriptionType: active?.subscriptionType ?? login.subscriptionType,
      tokenSource: reported?.tokenSource ?? null,
      // Not cli.js's `apiProvider: "firstParty"`: `inferBillingType` reads any
      // provider as an API key, and this is the account's subscription.
      apiKeySource: null,
      apiProvider: null
    }
  }
}
