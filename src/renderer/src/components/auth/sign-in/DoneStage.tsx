/**
 * `done` — who the credential belongs to, which engines it reaches and when,
 * and the prompt the dead credential stopped (ADR-070 §5 rule 6: the primary
 * slot belongs to Retry).
 */

import type { AuthRetry } from '../../../stores/auth-issues'
import { DIALOG, RetryRow, StateChip, feedLabel, type EngineFeed } from './shared'

export interface DoneStageProps {
  /** The credential's email, when the read after the write knew one. */
  signedInAs: string | null
  plan: string | null
  feeds: readonly EngineFeed[]
  /** ONE list, counted and re-sent — see {@link ../SignInDialog}'s `retries`. */
  retries: AuthRetry[]
  onRetry: () => void
}

export function DoneStage({
  signedInAs,
  plan,
  feeds,
  retries,
  onRetry
}: DoneStageProps): React.JSX.Element {
  const retry: AuthRetry | undefined = retries[0]

  return (
    <div data-testid={`${DIALOG}.done`} className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="text-success text-[14px]" aria-hidden="true">
          ✓
        </span>
        <span
          data-testid={`${DIALOG}.signedIn`}
          className="flex-1 min-w-0 text-[13px] text-text-primary truncate"
        >
          {signedInAs ?? 'Signed in'}
        </span>
        {plan && <StateChip text={plan} tone="neutral" testid={`${DIALOG}.plan`} dataId="done" />}
      </div>
      {feeds.length > 0 && (
        <div className="rounded-lg border border-border px-3 py-2.5 flex items-center flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
          {feeds.map((feed) => (
            <span
              key={feed.engineId}
              data-testid={`${DIALOG}.fanOut`}
              data-id={feed.engineId}
              className="flex items-center gap-1.5"
            >
              <span
                className={feed.effect ? 'text-text-secondary' : 'text-success'}
                aria-hidden="true"
              >
                {feed.effect ? '↻' : '✓'}
              </span>
              <span className="text-text-secondary">{feedLabel(feed)}</span>
              {feed.effect && <span className="text-text-muted">{feed.effect}</span>}
            </span>
          ))}
        </div>
      )}
      {retry && (
        <RetryRow count={retries.length} prompt={retry.prompt} action="Retry" onRetry={onRetry} />
      )}
    </div>
  )
}
