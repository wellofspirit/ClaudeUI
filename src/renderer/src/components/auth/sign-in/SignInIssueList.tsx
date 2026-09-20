/**
 * Provider-LIST mode (ADR-070 §5): the pill aggregates, so when several
 * credentials are down it has no single flow to open and hands the dialog the
 * whole set instead.
 *
 * Every row is live off `useAuthSummary` — the same answer the pill reads, so
 * the list cannot disagree with the indicator that opened it, and a provider
 * that resolves leaves the list on its own.
 */

import { useSessionStore } from '../../../stores/session-store'
import { AUTH_ISSUE_NAME } from '../../../stores/auth-issues'
import type { AuthIssue, AuthRetry } from '../../../stores/auth-issues'
import { useAuthSummary } from '../../../stores/use-auth-summary'
import { isDrivableProvider, providerDisplayName } from '../../../utils/sign-in-provider'
import { SettingRow, Button } from '../../SettingsDialog/settings-controls'
import { SheetGroup } from '../../SettingsDialog/SheetFrame'
import { openProviderSettings } from '../../SettingsDialog/settings-target'
import { DIALOG, DialogFrame, RetryRow, StateChip } from './shared'

export function SignInIssueList(): React.JSX.Element {
  const closeSignIn = useSessionStore((s) => s.closeSignIn)
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const retrySend = useSessionStore((s) => s.retrySend)
  const clearAuthRequired = useSessionStore((s) => s.clearAuthRequired)
  const summary = useAuthSummary()

  /** Switch this dialog into that provider's ordinary flow — one request replaces another. */
  const signIn = (issue: AuthIssue): void => {
    if (!isDrivableProvider(issue.providerId)) return openProviderSettings()
    openSignIn({
      providerId: issue.providerId,
      mode: 'reauth',
      ...(issue.accountId ? { accountId: issue.accountId } : {}),
      ...(issue.retry ? { retry: issue.retry } : {})
    })
  }

  /**
   * Every prompt an auth failure stopped: the ones still blocked (no credential
   * yet) and the ones a resolution has already unblocked. Only the second kind
   * can actually be sent, which is what disables the button.
   */
  const stopped: AuthRetry[] = [
    ...summary.retryable,
    ...summary.issues.flatMap((issue) => (issue.retry ? [issue.retry] : []))
  ]
  /** The ones a resolution has unblocked — the only ones a click can send. */
  const takeable = summary.retryable

  /**
   * ONE list per render, counted and re-sent. The count was `stopped` while the
   * click sent `takeable[0]`, so "3 prompts were stopped · Retry" re-sent one
   * and left two parked with no surface left saying so. Once anything is
   * takeable the row names exactly what the click will send; before that it
   * names what is parked, and the button is disabled.
   */
  const named: AuthRetry[] = takeable.length > 0 ? takeable : stopped

  const retry = (): void => {
    for (const owed of takeable) {
      void retrySend(owed.routingId, owed.prompt)
      clearAuthRequired(owed.routingId)
    }
  }

  return (
    <DialogFrame
      onClose={closeSignIn}
      heading={<span className="text-[15px] font-semibold text-text-primary">Sign-ins</span>}
    >
      <div className="space-y-3">
        {/* Everything resolved while the list was open — another client signed
            in, most likely. An empty bordered box would read as a failed read,
            and ADR-070's settled state has no action, so it says so and offers
            nothing. */}
        {summary.issues.length === 0 && stopped.length === 0 && (
          <SettingRow testid={`${DIALOG}.settled`} description="Nothing needs a sign-in." />
        )}
        {summary.issues.length > 0 && (
          <SheetGroup testid={`${DIALOG}.group`} id="issues" label="Providers">
            {summary.issues.map((issue) => (
              <SettingRow
                key={issue.providerId}
                testid={`${DIALOG}.issue`}
                dataId={issue.providerId}
                label={providerDisplayName(issue.providerId)}
                labelBadge={
                  <>
                    <StateChip
                      // The state's one name (ADR-070 §4) — this row said "not
                      // signed in" for the state the pill above it was calling
                      // "Sign-in needed".
                      text={AUTH_ISSUE_NAME[issue.kind]}
                      tone={issue.kind === 'expired' ? 'danger' : 'neutral'}
                      testid={`${DIALOG}.issueState`}
                    />
                    {issue.blocks.map((label) => (
                      <StateChip
                        key={label}
                        text={label}
                        tone="neutral"
                        testid={`${DIALOG}.issueBlocks`}
                      />
                    ))}
                  </>
                }
              >
                <Button
                  variant={issue.drivable ? 'primary' : 'tinted'}
                  testid={`${DIALOG}.issueSignIn`}
                  dataId={issue.providerId}
                  onClick={() => signIn(issue)}
                >
                  {/* ADR-030: an engine-native credential has no flow here, so
                      the row offers the page that can fix it — the same answer
                      the pill and the transcript row give. */}
                  {issue.drivable ? 'Sign in' : 'Settings'}
                </Button>
              </SettingRow>
            ))}
          </SheetGroup>
        )}
        {named.length > 0 && named[0] && (
          <RetryRow
            count={named.length}
            prompt={named[0].prompt}
            action="Retry after sign-in"
            disabled={takeable.length === 0}
            onRetry={retry}
          />
        )}
      </div>
    </DialogFrame>
  )
}
