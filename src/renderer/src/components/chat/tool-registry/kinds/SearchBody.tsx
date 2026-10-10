/**
 * search kind body — Claude Glob/Grep · opencode glob/grep · pi grep/find/ls.
 *
 * Search was the last read tool with no body of its own: it fell through to
 * `GenericBody`, which dumped the input as JSON and the result as raw text. It is
 * also the most-called tool after the shell, so the cost of that was paid
 * constantly.
 *
 * What a search result IS: a list of places. So it renders as one — a row per
 * file, with the match count when the output carries locations, and the matched
 * line underneath in the file's own language when the search ran in content mode.
 * Output that does not have that shape (a `Found N files` header with no rows, a
 * tool that answered prose) falls back to the plain terminal view rather than
 * being forced into a table it does not fit.
 */

import { useMemo } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import { TerminalView } from '../../TerminalView'
import { getLang } from '../../../../lib/lang'
import { TOOL_OUTPUT_SCOPE } from '../../ChatSearch/search-scope'
import type { KindBodyProps } from './types'

/** A file and what was found in it. `hits` is absent for a bare path list. */
interface SearchHit {
  path: string
  lines: { line: string; text: string }[]
}

/**
 * Group a search result into per-file rows.
 *
 * Three shapes reach this: `path:line:content` (content mode), a bare path list
 * (files_with_matches, Glob, `ls`), and a `Found N files` header followed by
 * either. The header is dropped — the row count states the same thing — and any
 * line that is neither a location nor a path is treated as prose, which makes the
 * whole parse decline.
 */
export function groupSearchResult(text: string): SearchHit[] | null {
  if (!text.trim()) return null
  const lines = text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !/^Found \d+ (files?|matches?|lines?)/i.test(l))
    .filter((l) => l !== '--')
  if (lines.length === 0) return null

  const byPath = new Map<string, SearchHit>()
  for (const raw of lines) {
    const located = /^([^\s:]+?):(\d+):(.*)$/.exec(raw)
    if (located) {
      const hit = byPath.get(located[1]) ?? { path: located[1], lines: [] }
      hit.lines.push({ line: located[2], text: located[3] })
      byPath.set(located[1], hit)
      continue
    }
    // A bare line must look like a path to count: a tool that answered prose
    // ("No matches found for …") should not render as a file row.
    const candidate = raw.trim()
    if (/\s/.test(candidate) || !/[./\\]/.test(candidate)) return null
    if (!byPath.has(candidate)) byPath.set(candidate, { path: candidate, lines: [] })
  }
  return byPath.size > 0 ? [...byPath.values()] : null
}

function MatchLine({ text, lang }: { text: string; lang: string }): React.JSX.Element {
  return (
    <Highlight theme={themes.oneDark} code={text.trim()} language={lang}>
      {({ tokens, getTokenProps }) => (
        <span className="truncate">
          {(tokens[0] ?? []).map((token, j) => (
            <span key={j} {...getTokenProps({ token })} />
          ))}
        </span>
      )}
    </Highlight>
  )
}

export function SearchBody({
  view,
  block,
  result,
  hideToolInput,
  toolOutputMaxChars = 5000
}: KindBodyProps): React.JSX.Element | null {
  const text = result?.toolResult ?? ''
  const grouped = useMemo(() => (result?.isError ? null : groupSearchResult(text)), [text, result])

  if (view.kind !== 'search') return null

  // The header already carries the pattern and the counts, so the body opens on
  // the places themselves. The input is shown only when the parse declined AND
  // the caller wants it — the same fall-through GenericBody had.
  const showInput = !hideToolInput && !grouped

  return (
    <>
      {showInput && (
        <div data-testid="SearchBody.input" className="px-3 py-2.5">
          <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
            Input
          </div>
          <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
            {JSON.stringify(block.toolInput, null, 2)}
          </pre>
        </div>
      )}

      {result && (
        <div
          {...TOOL_OUTPUT_SCOPE}
          className={`px-3 py-2.5 ${showInput ? 'border-t border-border' : ''}`}
        >
          {result.isError ? (
            <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
              {text.slice(0, toolOutputMaxChars)}
            </pre>
          ) : grouped ? (
            <div data-testid="SearchBody.results" className="flex flex-col">
              {grouped.map((hit) => {
                const lang = getLang(hit.path)
                return (
                  <div
                    key={hit.path}
                    data-testid="SearchBody.file"
                    className="py-1 border-b border-border/50 last:border-b-0"
                  >
                    <div className="flex items-baseline gap-3 text-[11.5px] font-mono">
                      <span className="text-accent truncate flex-1 min-w-0">{hit.path}</span>
                      {hit.lines.length > 0 && (
                        <span className="text-text-muted shrink-0">{hit.lines.length}</span>
                      )}
                    </div>
                    {hit.lines.slice(0, 5).map((line, i) => (
                      <div
                        key={i}
                        className="flex items-baseline gap-2 text-[11px] font-mono pl-2 min-w-0"
                      >
                        <span className="text-text-muted/60 shrink-0 select-none">{line.line}</span>
                        <MatchLine text={line.text} lang={lang} />
                      </div>
                    ))}
                    {hit.lines.length > 5 && (
                      <div className="text-[11px] text-text-muted pl-2">
                        +{hit.lines.length - 5} more in this file
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <TerminalView text={text} />
          )}
        </div>
      )}
    </>
  )
}
