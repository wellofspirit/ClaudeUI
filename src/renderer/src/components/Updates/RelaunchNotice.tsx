/**
 * The relaunch result notice (auto-update design §8): after ClaudeUI restarted,
 * one line saying how it went, from `app:last-relaunch` — "Updated to 3.9.2 ·
 * What's new", "Rebuilt from e4f1a2c", "3.9.2 didn't start, so ClaudeUI went
 * back to 3.9.1" (with the reason), "Relaunched". App-level, mounted like
 * `RemoteServeBanner`.
 *
 * Builds are named by version (`buildVersion`, so a local build reads
 * `3.9.1-pre.14 +22`), and by commit when a rebuild left the version as it
 * was (the job's `fromBuild` / `toBuild`). "What's new" is offered only for a
 * release that changed the version.
 *
 * Once per result per client: the last token shown is remembered in
 * `localStorage` (a private window, or storage that throws, may show it again,
 * never fail), and a result older than {@link MAX_AGE_MS} is not news. The
 * helper writes the result only after the new build reported healthy, which
 * is after this window loaded, so the read is repeated every second for the
 * first 15 s, then a few more times over the first two minutes. Dismissible;
 * a success hides itself ten seconds after it is first on screen (a window
 * still hidden behind others waits until it is visible).
 */
import { useEffect, useRef, useState } from 'react'
import type { RelaunchResult } from '../../../../shared/relaunch'
import type { AppUpdateView } from '../../../../shared/types/app-update'
import { buildVersion, releaseNotesUrl } from './utils'

export const SEEN_KEY = 'claudeui.relaunchNotice.seen'
/** A result older than this (by its `at`) is not shown. */
export const MAX_AGE_MS = 15 * 60_000
export const SUCCESS_HIDE_MS = 10_000
/** When to read `app:last-relaunch` after mount: every second for 15 s, then backing off. */
export const READ_DELAYS_MS: readonly number[] = [
  ...Array.from({ length: 16 }, (_, i) => i * 1000),
  30_000,
  60_000,
  100_000
]

export interface RelaunchNoticeModel {
  tone: 'success' | 'warning'
  text: string
  /** The reason, for a restart that did not go as asked. */
  detail?: string
  notesUrl?: string
}

/**
 * What a result says; null for nothing worth saying. `current` is the running
 * build (the app-update view's), so the side of the result that is running is
 * named the way Settings names it.
 */
export function relaunchNoticeModel(
  result: RelaunchResult,
  current?: AppUpdateView['current'] | null
): RelaunchNoticeModel | null {
  const reason = result.reason ? { detail: result.reason } : {}
  const named = (version: string): string =>
    current && current.version === version ? (buildVersion(current) ?? version) : version
  const sameVersion = result.fromVersion === result.toVersion
  switch (result.status) {
    case 'ok':
    case 'no-health': {
      // A relaunch into a build made in place (`source: 'rebuild'` on a relaunch).
      if (result.mode !== 'relaunch' || result.source !== 'rebuild')
        return { tone: 'success', text: 'Relaunched' }
      // The commit names the build only when it changed (not an uncommitted rebuild).
      const build =
        result.toBuild && result.toBuild !== result.fromBuild ? ` ${result.toBuild}` : ''
      const target = sameVersion ? `the new build${build}` : named(result.toVersion)
      // No rollback: a build that never came up is not a success, whatever runs now.
      if (result.status === 'no-health')
        return {
          tone: 'warning',
          text: `ClaudeUI restarted, but ${target} didn't report healthy`,
          ...reason
        }
      return { tone: 'success', text: `Relaunched into ${target}` }
    }
    case 'updated':
      if (sameVersion)
        return {
          tone: 'success',
          text: result.toBuild ? `Rebuilt from ${result.toBuild}` : 'Rebuilt'
        }
      return {
        tone: 'success',
        text: `Updated to ${named(result.toVersion)}`,
        ...(result.mode === 'swap' && result.source === 'release'
          ? { notesUrl: releaseNotesUrl(result.toVersion) }
          : {})
      }
    case 'rolled-back':
      if (sameVersion)
        return {
          tone: 'warning',
          text: `The rebuild${result.toBuild ? ` from ${result.toBuild}` : ''} didn't start, so ClaudeUI went back to ${result.fromBuild ?? 'the build before it'}`,
          ...reason
        }
      return {
        tone: 'warning',
        text: `${result.toVersion} didn't start, so ClaudeUI went back to ${named(result.fromVersion)}`,
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

/** The running build, to name it in the notice; null when the host cannot say. */
async function runningBuild(): Promise<AppUpdateView['current'] | null> {
  try {
    return (await Promise.resolve().then(() => window.api.appUpdateState())).current
  } catch {
    return null
  }
}

export function RelaunchNotice(): React.JSX.Element | null {
  const [model, setModel] = useState<RelaunchNoticeModel | null>(null)
  const shown = useRef(false)

  useEffect(() => {
    let cancelled = false
    let reading = false
    const read = async (): Promise<void> => {
      if (shown.current || reading) return
      reading = true
      try {
        let result: RelaunchResult | null
        try {
          // Through a promise, so a client without the member reads "none".
          result = await Promise.resolve().then(() => window.api.lastRelaunch())
        } catch {
          return
        }
        if (cancelled || shown.current || !result) return
        if (Date.now() - result.at > MAX_AGE_MS || seenToken() === result.token) return
        const next = relaunchNoticeModel(result, await runningBuild())
        if (cancelled) return
        markSeen(result.token)
        if (!next) return
        shown.current = true
        setModel(next)
      } finally {
        reading = false
      }
    }
    const timers = READ_DELAYS_MS.map((ms) => setTimeout(() => void read(), ms))
    return () => {
      cancelled = true
      for (const t of timers) clearTimeout(t)
    }
  }, [])

  // Ten seconds from when the success is first on screen: a window that is
  // still hidden (behind others, minimised) starts counting once it shows.
  const success = model?.tone === 'success'
  useEffect(() => {
    if (!success) return
    let hide: ReturnType<typeof setTimeout> | undefined
    const start = (): void => {
      if (hide === undefined) hide = setTimeout(() => setModel(null), SUCCESS_HIDE_MS)
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') start()
    }
    if (document.visibilityState !== 'hidden') start()
    else document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (hide !== undefined) clearTimeout(hide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [success])

  if (!model) return null
  return <RelaunchNoticeView model={model} onDismiss={() => setModel(null)} />
}
