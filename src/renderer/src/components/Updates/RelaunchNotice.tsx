/**
 * The relaunch result notice (auto-update design §8): after ClaudeUI restarted,
 * one line saying how it went, from `app:last-relaunch` — "Updated to 3.9.2 ·
 * What's new", "3.9.2 didn't start, so ClaudeUI went back to 3.9.1" (with the
 * reason), "Relaunched". App-level, mounted like `RemoteServeBanner`.
 *
 * Once per result per client: the last token shown is remembered in
 * `localStorage` (a private window, or storage that throws, may show it again,
 * never fail), and a result older than {@link MAX_AGE_MS} is not news. The
 * helper writes the result only after the new build reported healthy, which
 * is after this window loaded, so the read is repeated a few times over the
 * first two minutes. Dismissible; a success hides itself after ten seconds.
 */
import { useEffect, useRef, useState } from 'react'
import type { RelaunchResult } from '../../../../shared/relaunch'
import { isReleaseVersion } from '../../../../shared/update-manifest'
import { releaseNotesUrl } from './utils'

export const SEEN_KEY = 'claudeui.relaunchNotice.seen'
/** A result older than this (by its `at`) is not shown. */
export const MAX_AGE_MS = 15 * 60_000
export const SUCCESS_HIDE_MS = 10_000
/** When to read `app:last-relaunch` after mount. */
export const READ_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000, 100_000] as const

export interface RelaunchNoticeModel {
  tone: 'success' | 'warning'
  text: string
  /** The reason, for a restart that did not go as asked. */
  detail?: string
  notesUrl?: string
}

/** What a result says; null for nothing worth saying. */
export function relaunchNoticeModel(result: RelaunchResult): RelaunchNoticeModel | null {
  const reason = result.reason ? { detail: result.reason } : {}
  switch (result.status) {
    case 'ok':
    case 'no-health':
      return { tone: 'success', text: 'Relaunched' }
    case 'updated':
      return {
        tone: 'success',
        text: `Updated to ${result.toVersion}`,
        ...(isReleaseVersion(result.toVersion)
          ? { notesUrl: releaseNotesUrl(result.toVersion) }
          : {})
      }
    case 'rolled-back':
      return {
        tone: 'warning',
        text: `${result.toVersion} didn't start, so ClaudeUI went back to ${result.fromVersion}`,
        ...reason
      }
    case 'aborted':
      return {
        tone: 'warning',
        text:
          result.mode === 'swap'
            ? `The update to ${result.toVersion} didn't happen; nothing changed`
            : "The relaunch didn't happen",
        ...reason
      }
    case 'failed':
    case 'interrupted':
      return {
        tone: 'warning',
        text:
          result.mode === 'swap'
            ? `The update to ${result.toVersion} didn't finish; ClaudeUI started as it was`
            : "The relaunch didn't finish",
        ...reason
      }
    default:
      return null
  }
}

function seenToken(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

function markSeen(token: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, token)
  } catch {
    // Storage blocked: at worst it shows again on the next load.
  }
}

export function RelaunchNoticeView({
  model,
  onDismiss
}: {
  model: RelaunchNoticeModel
  onDismiss: () => void
}): React.JSX.Element {
  const success = model.tone === 'success'
  return (
    <div
      data-testid="RelaunchNotice"
      data-state={model.tone}
      className="fixed top-2 left-0 right-0 z-50 pointer-events-none px-4"
    >
      <div
        role="status"
        className={`pointer-events-auto max-w-[480px] mx-auto rounded-lg border bg-bg-secondary shadow-lg shadow-black/20 animate-fade-in px-3 py-2 flex items-start gap-2 text-[12px] ${
          success ? 'border-success/40' : 'border-warning/40'
        }`}
      >
        <span className={`mt-px shrink-0 ${success ? 'text-success' : 'text-warning'}`}>
          {success ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12l5 5 9-10" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3 2 20h20L12 3z" />
              <path d="M12 10v4" />
              <circle cx="12" cy="17" r=".6" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div data-testid="RelaunchNotice.text" className="text-text-primary leading-[18px]">
            {model.text}
            {model.notesUrl && (
              <>
                {' · '}
                <a
                  data-testid="RelaunchNotice.notes"
                  href={model.notesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline cursor-default"
                >
                  What&apos;s new
                </a>
              </>
            )}
          </div>
          {model.detail && (
            <div
              data-testid="RelaunchNotice.detail"
              className="mt-0.5 text-[11px] leading-4 text-text-secondary break-words"
            >
              {model.detail}
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="RelaunchNotice.dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          className="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export function RelaunchNotice(): React.JSX.Element | null {
  const [model, setModel] = useState<RelaunchNoticeModel | null>(null)
  const shown = useRef(false)

  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      if (shown.current) return
      let result: RelaunchResult | null
      try {
        // Through a promise, so a client without the member reads "none".
        result = await Promise.resolve().then(() => window.api.lastRelaunch())
      } catch {
        return
      }
      if (cancelled || shown.current || !result) return
      if (Date.now() - result.at > MAX_AGE_MS || seenToken() === result.token) return
      const next = relaunchNoticeModel(result)
      markSeen(result.token)
      if (!next) return
      shown.current = true
      setModel(next)
    }
    const timers = READ_DELAYS_MS.map((ms) => setTimeout(() => void read(), ms))
    return () => {
      cancelled = true
      for (const t of timers) clearTimeout(t)
    }
  }, [])

  const success = model?.tone === 'success'
  useEffect(() => {
    if (!success) return
    const hide = setTimeout(() => setModel(null), SUCCESS_HIDE_MS)
    return () => clearTimeout(hide)
  }, [success])

  if (!model) return null
  return <RelaunchNoticeView model={model} onDismiss={() => setModel(null)} />
}
