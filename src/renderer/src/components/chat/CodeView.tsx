import { useMemo } from 'react'
import { Highlight, themes } from 'prism-react-renderer'

/**
 * The extension→language map and `getLang` now live in `lib/lang.ts` so that
 * non-rendering consumers (tool-card chips, the Bash output detectors, the
 * search body) can name a language without importing this component and its
 * Prism bundle. Re-exported here: every existing import site is unchanged.
 */
import { getLang } from '../../lib/lang'
export { EXT_TO_LANG, getLang } from '../../lib/lang'

/** Strip `cat -n` style line-number prefixes (e.g. "     1→content") */
export function stripLineNumbers(s: string): string {
  return s.replace(/^ *\d+→/gm, '')
}

/** Extract the starting line number from cat -n output, defaulting to 1 */
export function getStartLine(s: string): number {
  const match = s.match(/^ *(\d+)→/)
  return match ? parseInt(match[1], 10) : 1
}

interface Props {
  code: string
  filePath?: string
}

export function CodeView({ code, filePath }: Props): React.JSX.Element {
  const startLine = useMemo(() => getStartLine(code), [code])
  const cleaned = useMemo(() => stripLineNumbers(code), [code])
  // Trim trailing newline to avoid an empty last line
  const trimmed = cleaned.endsWith('\n') ? cleaned.slice(0, -1) : cleaned
  const lang = getLang(filePath)

  return (
    <Highlight theme={themes.oneDark} code={trimmed} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          data-testid="CodeView"
          className="text-[11px] font-mono leading-[1.3] rounded-md border border-border overflow-auto"
          style={{ background: 'var(--color-bg-primary)' }}
        >
          <code>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line })
              return (
                <div key={i} {...lineProps} className="flex" style={undefined}>
                  <span className="shrink-0 w-10 text-right pr-3 select-none text-text-muted/50 text-[11px]">
                    {startLine + i}
                  </span>
                  <span className="flex-1 px-2">
                    {line.map((token, j) => (
                      <span key={j} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              )
            })}
          </code>
        </pre>
      )}
    </Highlight>
  )
}
