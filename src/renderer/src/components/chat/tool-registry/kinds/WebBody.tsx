/**
 * Web kind body — Codex `webSearch` · Claude `WebSearch`/`WebFetch` · opencode
 * `websearch`/`webfetch`.
 *
 * Replaces the JSON dump `GenericBody` gave every one of them (F20). The action
 * line says what the tool DID (searched / fetched / found in page); the results
 * list renders the structured rows when the engine's wire carries them, and
 * falls back to the raw result text — through the same `TerminalView` the
 * generic body used — when it does not.
 *
 * SECURITY. A result's title, url and snippet are UNTRUSTED text: they come from
 * a search backend by way of the model, and nothing here puts them through the
 * markdown pipeline. A url becomes a real link ONLY when it starts with
 * `http://` or `https://` — a `javascript:`, `data:` or `file:` url renders as
 * plain text, so a poisoned result cannot become a one-click payload.
 */

import { TerminalView } from '../../TerminalView'
import type { KindBodyProps } from './types'

const ACTION_LABEL: Readonly<Record<string, string>> = {
  search: 'Searched',
  fetch: 'Fetched',
  find: 'Found in page',
  other: 'Web'
}

/** Only these two schemes become an anchor. Everything else stays text. */
export function isSafeResultUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/** `electronjs.org › docs › latest` — the readable form of a result's location. */
export function resultLocation(url: string): string {
  if (!isSafeResultUrl(url)) return url
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    return [parsed.host, ...segments].join(' › ')
  } catch {
    return url
  }
}

export function WebBody({
  view,
  result,
  hideToolInput,
  isError
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'web') return null
  const results = view.results ?? []
  const text = result?.toolResult ?? ''
  const showText = !!result && !!text && results.length === 0

  return (
    <>
      {!hideToolInput && (
        <div data-testid="WebBody" className="px-3 py-2.5">
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            {ACTION_LABEL[view.action ?? 'other'] ?? ACTION_LABEL.other}
          </div>
          <div
            data-testid="WebBody.target"
            className="text-[12px] text-text-primary font-mono break-words leading-[1.4]"
          >
            {view.target}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div
          data-testid={hideToolInput ? 'WebBody' : undefined}
          className={`px-3 py-2.5 flex flex-col gap-2.5 ${hideToolInput ? '' : 'border-t border-border'}`}
        >
          <div className="text-[11px] text-text-secondary uppercase tracking-wider">
            {results.length === 1 ? '1 result' : `${results.length} results`}
          </div>
          {results.map((entry, index) => (
            <div key={index} data-testid="WebBody.result" data-id={String(index)}>
              {isSafeResultUrl(entry.url) ? (
                <a
                  data-testid="WebBody.resultLink"
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[12px] text-accent hover:underline break-words leading-[1.4]"
                >
                  {entry.title}
                </a>
              ) : (
                <div className="text-[12px] text-text-primary break-words leading-[1.4]">
                  {entry.title}
                </div>
              )}
              {entry.url && (
                <div className="text-[11px] text-text-muted font-mono break-words leading-[1.4]">
                  {resultLocation(entry.url)}
                </div>
              )}
              {entry.snippet && (
                <div className="text-[11px] text-text-secondary leading-[1.5] break-words mt-0.5">
                  {entry.snippet}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showText && (
        <div
          data-testid={hideToolInput && results.length === 0 ? 'WebBody' : undefined}
          className={`px-3 py-2.5 ${hideToolInput ? '' : 'border-t border-border'}`}
        >
          {!hideToolInput && (
            <div
              className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}
            >
              {isError ? 'Error' : 'Result'}
            </div>
          )}
          <TerminalView text={text} />
        </div>
      )}
    </>
  )
}
