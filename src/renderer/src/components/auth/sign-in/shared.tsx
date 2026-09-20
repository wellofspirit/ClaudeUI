/**
 * The chrome every sign-in screen shares: the frame, the provider header, the
 * two row vocabularies, and the engine-feed derivation the header and the done
 * state must answer identically.
 *
 * It lives beside the stages rather than inside {@link ../SignInDialog} so a
 * stage can render the shell without reaching into the state machine that owns
 * it. Nothing here holds flow state — props in, callbacks out.
 */

import type { SignInProviderId } from '../../../stores/session-store'
import { SIGN_IN_PROVIDER_LABEL } from '../../../utils/sign-in-provider'
import type { EngineId } from '../../../../../shared/types'
import { engineMeta } from '../../../../../shared/engine-meta'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { useEscapeLayer } from '../../shared/use-escape-layer'
import { Button } from '../../SettingsDialog/settings-controls'
import { EngineChip } from '../../SettingsDialog/ProviderSheet'

/** The testid root every screen shares — the dialog is one object to a test. */
export const DIALOG = 'SignInDialog'

// One name table for every entry point (Slice 6): the picker item, the composer
// hint and this heading must agree on what the provider is called.
export const PROVIDER_NAME = SIGN_IN_PROVIDER_LABEL

/**
 * The header's provider mark. One glyph each rather than a vendor logo: the
 * app ships no brand assets, and a coloured initial is enough to tell two
 * dialogs apart at a glance.
 */
const PROVIDER_MARK: Record<SignInProviderId, string> = { anthropic: 'C', chatgpt: 'G' }

/**
 * One engine a credential feeds, and WHEN a new token reaches it.
 *
 * The header renders the set (rule 1: which engines a credential feeds is a
 * set, so render a set) and the done state renders the same set with its
 * effects (rule 5: three parallel sentences become one row of chips). ONE
 * derivation for both — the header and the done state cannot answer the
 * question differently.
 */
export interface EngineFeed {
  engineId: EngineId
  /** Overrides `engineMeta().label`; see {@link ANTHROPIC_FEEDS}. */
  label?: string
  /** Absent = the new token is in use already. */
  effect?: string
}

/**
 * Anthropic feeds Claude Code and nothing else, and it feeds it on the NEXT
 * session: a running cli.js caches its OAuth token for the life of the process,
 * which is exactly why `retrySend` respawns rather than re-prompting.
 *
 * "Claude Code" rather than `engineMeta('claude').label` ("Claude") because the
 * title beside it already says Claude; the chip names the product the
 * credential feeds.
 */
export const ANTHROPIC_FEEDS: readonly EngineFeed[] = [
  { engineId: 'claude', label: 'Claude Code', effect: 'next session' }
]

export const feedLabel = (feed: EngineFeed): string => feed.label ?? engineMeta(feed.engineId).label

/**
 * A fact chip: the plan (neutral) or a dead credential (danger).
 *
 * `SettingRow`'s own badge vocabulary is fixed (engine / locked / appliesOn) and
 * `CredentialChip`'s value set is the provider registry's, so neither can say
 * "Plus" or "expired". Same geometry as `CredentialChip` on purpose — a chip
 * here has to read as the same object as a chip in Settings.
 */
export function StateChip({
  text,
  tone,
  testid,
  dataId
}: {
  text: string
  tone: 'neutral' | 'danger'
  testid: string
  /** ADR-027: every one of these testids repeats — per row, or per stage. */
  dataId?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      {...(dataId ? { 'data-id': dataId } : {})}
      className={`shrink-0 rounded-full px-[7px] text-[10.5px] leading-4 font-medium ${
        tone === 'danger'
          ? 'border border-danger/40 text-danger'
          : 'border border-border text-text-secondary'
      }`}
    >
      {text}
    </span>
  )
}

/**
 * The bordered accent row that owns the screen's ONE primary action (rule 6).
 *
 * Shared by the done state (an immediate `Retry`) and the provider list (a
 * `Retry after sign-in`, inert until a resolution makes it takeable), because
 * they are the same offer at two moments and a second row style would let the
 * two drift.
 */
export function RetryRow({
  count,
  prompt,
  action,
  disabled,
  onRetry
}: {
  count: number
  prompt: string
  action: string
  disabled?: boolean
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid={`${DIALOG}.retryRow`}
      className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5 flex items-center gap-3"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] text-text-primary">
          {count === 1 ? '1 prompt was stopped' : `${count} prompts were stopped`}
        </span>
        <span className="block text-[11px] text-text-muted truncate">“{prompt}”</span>
      </span>
      <Button variant="primary" testid={`${DIALOG}.retry`} disabled={disabled} onClick={onRetry}>
        {action}
      </Button>
    </div>
  )
}

/**
 * The shell every mode shares: scrim, panel, header row, scrolling body.
 *
 * `×` / the scrim / Escape are the three closes, and there is no fourth — see
 * the module header on the deleted footer. The header is `min-h`, not a fixed
 * 52px, so the engine chips WRAP on a phone instead of overflowing the row.
 */
export function DialogFrame({
  dataId,
  heading,
  onClose,
  children
}: {
  dataId?: string
  heading: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const isMobile = useIsMobile()
  useEscapeLayer(onClose)

  return (
    <div
      data-testid={DIALOG}
      {...(dataId ? { 'data-id': dataId } : {})}
      className="fixed inset-0 z-[100] flex"
    >
      <span
        data-testid={`${DIALOG}.scrim`}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <div
        className={
          isMobile
            ? 'relative z-10 w-full h-full flex flex-col bg-bg-primary animate-fade-in'
            : 'relative z-10 m-auto w-[460px] max-w-[92vw] max-h-[88vh] flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl animate-fade-in'
        }
      >
        <div className="min-h-[52px] shrink-0 flex items-center flex-wrap gap-2 px-4 py-2 border-b border-border">
          {heading}
          <button
            type="button"
            data-testid={`${DIALOG}.close`}
            title="Close"
            onClick={onClose}
            className="ml-auto shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  )
}

/** The provider dialog's heading: the mark, the name, and what it feeds. */
export function ProviderHeading({
  providerId,
  feeds
}: {
  providerId: SignInProviderId
  feeds: readonly EngineFeed[]
}): React.JSX.Element {
  return (
    <>
      <span
        data-testid={`${DIALOG}.mark`}
        aria-hidden="true"
        className="shrink-0 w-5 h-5 rounded-full bg-bg-tertiary flex items-center justify-center text-[10px] font-semibold text-text-secondary"
      >
        {PROVIDER_MARK[providerId]}
      </span>
      <span className="text-[15px] font-semibold text-text-primary truncate">
        {PROVIDER_NAME[providerId]}
      </span>
      {feeds.map((feed) => (
        <EngineChip
          key={feed.engineId}
          engine={feed.engineId}
          enabled
          label={feed.label}
          testid={`${DIALOG}.engineChip`}
        />
      ))}
    </>
  )
}
