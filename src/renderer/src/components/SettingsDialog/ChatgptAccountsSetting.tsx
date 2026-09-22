/**
 * ChatgptAccountsSetting — the ChatGPT half of Models & providers › Accounts
 * (F14; ADR-068 §2 for the accounts themselves).
 *
 * MOVED, NOT COPIED. These rows were the Manage sheet's Accounts card. Every
 * provider's stored accounts now live on the ONE Accounts page — the sheet keeps
 * a link — so that a user looking for "my accounts" finds all of them in one
 * place instead of one list on a page and another inside a sheet.
 *
 * IT OWNS NO STATE OF RECORD. The rows are a projection of
 * `providerRegistry.entries['chatgpt'].accounts`, the snapshot the store holds
 * (F12), and every action routes to an existing writer. The registry publishes
 * no change event, so each write is followed by `refreshProviderAuth()`: without
 * it the radio would keep showing the account it just switched away from.
 *
 * THREE STATES, and the third is not "signed out". A registry that has not
 * answered yet renders NOTHING — the same honest unknown the composer's
 * sign-in hint takes (ADR-030) — because claiming "no ChatGPT account" before
 * anything has been read would put a sign-in row in front of a signed-in user.
 */

import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type { ProviderAccounts } from '../../../../shared/provider-registry'
import { Button, SettingRow, ToggleSwitch } from './settings-controls'
import { CredentialChip } from './ProviderSheet'
import { accountDisplayName } from '../../utils/sign-in-provider'

/** Testid namespace (ADR-027 tier 1/2). */
const PANE = 'ChatgptAccounts'

/** The shared vault's id for the ChatGPT subscription (`AuthVault.CHATGPT_PROVIDER_ID`). */
const CHATGPT_ENTRY_ID = 'chatgpt'

/**
 * Plan and a shortened workspace id — what tells two accounts of one person
 * apart.
 *
 * "ChatGPT workspace", never a bare "Workspace" (owner ruling, 2026-09-16): on
 * every other surface in this app a workspace is a DIRECTORY, and the vault's
 * `accountId` is the ChatGPT organisation the account belongs to. The explainer
 * row below says so once, where the accounts first appear.
 */
function accountDescription(account: { planType?: string; accountId?: string }): string {
  const workspace = account.accountId
    ? `ChatGPT workspace ${account.accountId.length > 14 ? `${account.accountId.slice(0, 14)}…` : account.accountId}`
    : undefined
  return [account.planType, workspace].filter(Boolean).join(' · ')
}

export function ChatgptAccountsSetting(): React.JSX.Element | null {
  const registry = useSessionStore((s) => s.providerRegistry)
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Which destructive action is one click from happening. Per ROW (`<id>`):
   * arming Remove on one account must not arm it on every other row too.
   */
  const [confirming, setConfirming] = useState<string | null>(null)

  // The page can be opened before boot's read has landed (or after one that
  // failed); ask once so the honest unknown below is a moment, not a state.
  useEffect(() => {
    if (registry === null) void useSessionStore.getState().refreshProviderAuth()
  }, [registry])

  // The honest unknown — see the header.
  if (registry === null) return null

  const entry = registry.entries.find((candidate) => candidate.id === CHATGPT_ENTRY_ID)
  const accounts: ProviderAccounts | undefined = entry?.accounts
  const list = accounts?.list ?? []

  /** Run one write, then re-read the registry the rows are drawn from. */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await useSessionStore.getState().refreshProviderAuth()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Two-click confirm: arm on the first press, act on the second. */
  const confirmThen = (which: string, action: () => Promise<unknown>): void => {
    if (confirming !== which) {
      setConfirming(which)
      return
    }
    setConfirming(null)
    void run(action)
  }

  return (
    <div data-testid={PANE} className="divide-y divide-border/55">
      <SettingRow
        testid={`${PANE}.heading`}
        label="ChatGPT"
        labelBadge={
          entry ? (
            <CredentialChip credential={entry.credential} testid={`${PANE}.credential`} />
          ) : undefined
        }
        description="One ChatGPT sign-in, shared by Codex, pi and opencode."
        error={error ?? undefined}
      >
        {list.length > 0 && (
          <Button
            variant="tinted"
            testid={`${PANE}.addAccount`}
            disabled={busy}
            onClick={() => openSignIn({ providerId: 'chatgpt', mode: 'add' })}
          >
            + Add account
          </Button>
        )}
      </SettingRow>

      {list.length === 0 ? (
        <SettingRow
          testid={`${PANE}.signInRow`}
          description="No ChatGPT account is stored. Signing in makes it available to Codex, and to pi and opencode where their routes are on."
        >
          <Button
            variant="tinted"
            testid={`${PANE}.signIn`}
            disabled={busy}
            onClick={() => openSignIn({ providerId: 'chatgpt', mode: 'reauth' })}
          >
            Sign in to ChatGPT
          </Button>
        </SettingRow>
      ) : (
        <>
          {list.map((account) => {
            const active = account.id === accounts?.activeId
            const armed = confirming === account.id
            return (
              // `as="label"` rather than `as="button"`: the row carries a Remove
              // BUTTON, and a button inside a button is invalid HTML. A click on
              // an interactive descendant of a <label> does not activate the
              // label's control, so Remove never doubles as "switch to this one".
              <SettingRow
                key={account.id}
                as="label"
                testid={`${PANE}.account`}
                dataId={account.id}
                label={accountDisplayName(account.email)}
                description={accountDescription(account)}
                className={active ? 'bg-accent/5' : 'hover:bg-bg-hover/40'}
                leading={
                  <input
                    type="radio"
                    name={`${PANE}-account`}
                    value={account.id}
                    checked={active}
                    disabled={busy}
                    onChange={() => {
                      // Already active: re-vending the credential we are already
                      // on would recycle opencode for nothing.
                      if (active) return
                      void run(() => window.api.switchProviderAccount(CHATGPT_ENTRY_ID, account.id))
                    }}
                    className="appearance-none w-4 h-4 shrink-0 rounded-full border-[1.5px] border-border-bright bg-transparent checked:border-accent checked:bg-accent checked:shadow-[inset_0_0_0_3.5px_var(--color-bg-secondary)] cursor-pointer"
                  />
                }
              >
                <Button
                  variant="danger"
                  testid={`${PANE}.accountRemove`}
                  dataId={account.id}
                  disabled={busy}
                  onClick={() =>
                    confirmThen(account.id, () =>
                      window.api.removeProviderAccount(CHATGPT_ENTRY_ID, account.id)
                    )
                  }
                >
                  {armed ? 'Remove?' : 'Remove'}
                </Button>
              </SettingRow>
            )
          })}

          {/* One account is not a choice to make per session, so the toggle that
              configures that choice is not shown until there are two. */}
          {list.length > 1 && (
            <SettingRow
              testid={`${PANE}.perSession`}
              label="Per-session accounts"
              description="Let a Codex session pin one account instead of following the active one. New sessions only."
            >
              <button
                type="button"
                data-testid={`${PANE}.perSessionToggle`}
                aria-pressed={accounts?.perSession === true}
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    window.api.setProviderAccountsPerSession(
                      CHATGPT_ENTRY_ID,
                      !(accounts?.perSession === true)
                    )
                  )
                }
                className="cursor-default disabled:opacity-40"
              >
                <ToggleSwitch checked={accounts?.perSession === true} />
              </button>
            </SettingRow>
          )}

          {/* The switch RULE, stated per provider. Both providers DISCONNECT
              the sessions whose credential changed and let each resume on its
              next message: Claude cancels every live Claude session
              (`invalidateLiveSessions`, ADR-015 as built); a Codex session that
              follows the active account leaves its host (ADR-069 §4), while one
              PINNED to an account is left alone because its credential did not
              change. Stated twice because the pin exists only on ChatGPT. */}
          <SettingRow
            testid={`${PANE}.switchRule`}
            description="Switching disconnects every running Codex session that follows the active account; each resumes with the new account on its next message. A session pinned to an account keeps it. pi and opencode follow the active account."
          />
        </>
      )}

      <SettingRow
        testid={`${PANE}.workspaceNote`}
        dimmed
        description="A ChatGPT workspace is the ChatGPT organisation an account belongs to, not a directory."
      />
    </div>
  )
}
