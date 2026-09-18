import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { useShallow } from 'zustand/react/shallow'
import { NoticeCard } from '../shared/NoticeCard'

/**
 * The transcript's one "a credential was rejected" row (ADR-068 §4).
 *
 * It replaces `VendorAuthRequiredCard`, which was opencode-only and carried a
 * whole re-login flow of its own. This row is engine-NEUTRAL — it renders the
 * session's `authRequired`, which Codex, opencode and Claude all raise the same
 * way — and it carries no flow at all: its action opens `SignInDialog`, the one
 * place a flow lives.
 *
 * TWO KINDS OF PROVIDER, because only one of them has a flow to offer:
 *
 *  · `anthropic` / `chatgpt` — ClaudeUI drives the sign-in, so the action opens
 *    the dialog on that provider, in `reauth` mode, carrying the account the
 *    event blamed and the prompt whose turn died (so the done state can offer to
 *    re-send it);
 *  · `opencode:<vendorId>` / `pi:<vendorId>` — an API key or an OAuth credential
 *    in that ENGINE's own store. There is no ClaudeUI flow for either, so the
 *    action opens Settings › Models & providers instead of a dialog that would
 *    have nothing to run. The prefix is the engine's, and `provider-registry.ts`
 *    mints the very same ids for the rows those actions land on.
 *
 * The event carries no message: the emitting engine sends its own words as an
 * ordinary `session:error`, which `FloatingError` already renders below this.
 */
export function AuthRequiredRow(): React.JSX.Element | null {
  const authRequired = useActiveSession((s) => s.authRequired)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const { openSignIn, clearAuthRequired } = useSessionStore(
    useShallow((s) => ({ openSignIn: s.openSignIn, clearAuthRequired: s.clearAuthRequired }))
  )

  if (!authRequired || !activeSessionId) return null
  const { providerId, accountId } = authRequired

  const drivable = providerId === 'anthropic' || providerId === 'chatgpt'
  const name =
    providerId === 'anthropic'
      ? 'Claude'
      : providerId === 'chatgpt'
        ? 'ChatGPT'
        : providerId.replace(/^(?:opencode|pi):/, '')

  /** The prompt whose turn the rejection killed, for the dialog's Retry. */
  const lastUserPrompt = (): string | null => {
    const messages = useSessionStore.getState().sessions[activeSessionId]?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue
      const text = messages[i].content.find((block) => block.type === 'text')
      return text && text.type === 'text' ? text.text : null
    }
    return null
  }

  const act = (): void => {
    if (!drivable) {
      window.dispatchEvent(
        new CustomEvent('open-settings', { detail: { page: 'models', group: 'providers' } })
      )
      clearAuthRequired(activeSessionId)
      return
    }
    const prompt = lastUserPrompt()
    openSignIn({
      providerId,
      mode: 'reauth',
      ...(accountId ? { accountId } : {}),
      ...(prompt ? { retry: { routingId: activeSessionId, prompt } } : {})
    })
  }

  return (
    <div
      data-testid="AuthRequiredRow"
      data-id={providerId}
      className="absolute top-12 left-0 right-0 z-20 pointer-events-none"
    >
      <div className="pointer-events-auto px-4 pt-2">
        <div className="max-w-[740px] mx-auto">
          <NoticeCard
            testId="AuthRequiredRow.card"
            dismissTestId="AuthRequiredRow.dismiss"
            variant="warning"
            text={`${name} rejected the credential — sign in again to continue.`}
            onDismiss={() => clearAuthRequired(activeSessionId)}
            actions={
              <button
                type="button"
                data-testid={drivable ? 'AuthRequiredRow.signIn' : 'AuthRequiredRow.settings'}
                data-id={providerId}
                onClick={act}
                className="text-[12px] font-medium rounded-md px-3 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer"
              >
                {drivable ? 'Sign in' : 'Open provider settings'}
              </button>
            }
          />
        </div>
      </div>
    </div>
  )
}
