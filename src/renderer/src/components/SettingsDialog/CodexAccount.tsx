import { useEffect, useState } from 'react'
import type { CodexAuthStatus, CodexLoginState } from '../../../../shared/codex-types'
import { useSessionStore } from '../../stores/session-store'

export function CodexAccount(): React.JSX.Element {
  const [account, setAccount] = useState<CodexAuthStatus>()
  const [flow, setFlow] = useState<CodexLoginState>({ status: 'idle' })
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => {
    try {
      const [account, next] = await Promise.all([
        window.api.codexAuthStatus(),
        window.api.codexLoginStatus()
      ])
      if (next.status === 'completed') {
        const groups = await window.api.getEngineModels()
        useSessionStore.getState().setAvailableModels(groups.flatMap((group) => group.models))
      }
      setAccount(account)
      setFlow(next)
      setError('')
    } catch {
      setError('Native Codex status is unavailable')
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    if (flow.status !== 'waiting' && flow.status !== 'starting') return
    let live = true
    let polling = false
    const timer = setInterval(() => {
      if (polling) return
      polling = true
      void window.api
        .codexLoginStatus()
        .then(async (next) => {
          if (!live) return
          if (next.status === 'completed') {
            const [account, groups] = await Promise.all([
              window.api.codexAuthStatus(),
              window.api.getEngineModels()
            ])
            if (!live) return
            setAccount(account)
            useSessionStore.getState().setAvailableModels(groups.flatMap((group) => group.models))
          }
          setFlow(next)
        })
        .catch(() => {
          if (live)
            setError('Native login status failed. Retry status; no credentials were removed.')
        })
        .finally(() => {
          polling = false
        })
    }, 1500)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [flow.status])
  return (
    <section data-testid="CodexAccount" className="p-4 space-y-3 text-sm">
      <p>
        Codex owns its credentials and refresh. Upstream multi-process refresh behavior is accepted;
        failures require explicit retry or sign-in, never automatic logout.
      </p>
      <p data-testid="CodexAccount.status">
        {account
          ? (account.error ??
            (account.authenticated ? `Authenticated: ${account.authKind}` : 'Not signed in'))
          : 'Reading native status...'}
      </p>
      {account?.catalogError && <p role="alert">{account.catalogError}</p>}
      {account?.modelCount !== undefined && <p>{account.modelCount} native models discovered.</p>}
      <div className="flex gap-3">
        <button data-testid="CodexAccount.refresh" onClick={() => void refresh()}>
          Refresh status
        </button>
        <button
          data-testid="CodexAccount.signIn"
          disabled={!account?.available || flow.status === 'waiting' || flow.status === 'starting'}
          onClick={async () => {
            setError('')
            setFlow({ status: 'starting' })
            try {
              const next = await window.api.codexLoginStart()
              if (next.status === 'completed') await refresh()
              else setFlow(next)
            } catch (error) {
              setFlow({ status: 'failed' })
              setError(error instanceof Error ? error.message : 'Native login failed')
            }
          }}
        >
          Sign in with device code
        </button>
      </div>
      {flow.status === 'waiting' && (
        <div data-testid="CodexAccount.deviceCode">
          <p>Open this URL in your browser. No host browser was opened.</p>
          <a
            href={flow.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="underline break-all"
          >
            {flow.verificationUrl}
          </a>
          <p className="font-mono select-all">{flow.userCode}</p>
          <button
            data-testid="CodexAccount.cancel"
            onClick={async () => {
              await window.api.codexLoginCancel()
              await refresh()
            }}
          >
            Cancel login
          </button>
        </div>
      )}
      <p aria-live="polite">{flow.status !== 'idle' ? flow.status : ''}</p>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
