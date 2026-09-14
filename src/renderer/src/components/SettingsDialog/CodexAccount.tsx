import { useEffect, useState } from 'react'
import type { CodexAuthStatus } from '../../../../shared/codex-types'
import type { SharedProviderAccountList } from '../../../../shared/shared-provider'
import { SettingRow } from './settings-controls'

/**
 * The Codex page's account row — a REPORT, not a flow (ADR-068 §1).
 *
 * Codex no longer owns a login the product can start: the vault owns the ChatGPT
 * identity, every Codex process is injected with the active account, and the
 * management surface is the shared ChatGPT provider. So this row says which
 * account Codex runs as and links to where that is changed; the device-code
 * pane, its three channels and its poller are gone.
 *
 * Three states, all of them honest about where the credential lives:
 *
 *  - an active vault account — "ChatGPT · <email>" with the plan;
 *  - no vault account but a native login (`codex login` in a terminal) — Codex
 *    keeps working on its own credential, and the row says so;
 *  - neither — nothing is signed in.
 */
export function CodexAccount(): React.JSX.Element {
  const [native, setNative] = useState<CodexAuthStatus>()
  const [vault, setVault] = useState<SharedProviderAccountList>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [status, accounts] = await Promise.all([
          window.api.codexAuthStatus(),
          window.api.listProviderAccounts('chatgpt')
        ])
        if (!live) return
        setNative(status)
        setVault(accounts)
        setError('')
      } catch {
        if (live) setError('Codex account status is unavailable')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const active = vault?.accounts.find((account) => account.id === vault.activeId)
  const count = vault?.accounts.length ?? 0
  // `codexAuthStatus` reads the SAME app-server path a session does, so once the
  // vault holds an account it reports the injected identity, not a native one.
  // A native login is therefore only observable — and only worth mentioning —
  // when the vault is empty.
  const nativeLogin = !active && native?.authenticated === true
  const description = active
    ? `${count} account${count === 1 ? '' : 's'} available`
    : nativeLogin
      ? 'Codex is using its own login; sign in here to manage it in ClaudeUI'
      : native?.error
        ? native.error
        : 'Sign in to ChatGPT to run Codex under a ClaudeUI-managed account'

  return (
    <SettingRow
      testid="CodexAccount"
      layout="stacked"
      label={active ? `ChatGPT · ${active.email ?? 'Account'}` : 'Not signed in through ClaudeUI'}
      labelBadge={
        active?.planType ? (
          <span
            data-testid="CodexAccount.plan"
            className="shrink-0 border border-border rounded-full px-[7px] text-[10.5px] leading-4 text-text-secondary"
          >
            {active.planType}
          </span>
        ) : undefined
      }
      description={error || description}
    >
      <button
        data-testid="CodexAccount.manage"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('open-settings', { detail: { page: 'models', group: 'providers' } })
          )
        }
        className="text-[12px] text-accent hover:text-accent/80 transition-colors"
      >
        Manage in Models &amp; providers ›
      </button>
    </SettingRow>
  )
}
