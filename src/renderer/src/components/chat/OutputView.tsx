/**
 * OutputView — what a command printed, coloured when it has a shape we can name.
 *
 * Wraps `TerminalView`, which stays the renderer for everything else: ANSI output
 * is passed straight through to it untouched, because text that coloured itself
 * must never be re-coloured. Only when `detectOutputFormat` recognises a shape —
 * a grep/rg gutter, a unified diff, JSON, or one file a plain read printed — does
 * this component take over, and even then it renders exactly the structure that
 * was detected: the gutter muted, the content in the file's language.
 *
 * The detector is deliberately conservative (see `lib/shell-highlight.ts`), so
 * the common case here is a straight hand-off.
 */

import { useMemo } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import { TerminalView } from './TerminalView'
import { detectOutputFormat, splitGrepLine } from '../../lib/shell-highlight'

interface Props {
  text: string
  /** The command that produced `text`; the only evidence for a single-file read. */
  command?: string
  maxHeight?: number | string
}

/** One Prism-highlighted line, for the renderers that own their own line layout. */
function CodeLine({ code, lang }: { code: string; lang: string }): React.JSX.Element {
  return (
    <Highlight theme={themes.oneDark} code={code} language={lang}>
      {({ tokens, getTokenProps }) => (
        <span>
          {(tokens[0] ?? []).map((token, j) => (
            <span key={j} {...getTokenProps({ token })} />
          ))}
        </span>
      )}
    </Highlight>
  )
}

const PRE_CLASSES =
  'text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] rounded-md p-2 border border-border overflow-auto bg-bg-primary'

/** `grep`/`rg`: the gutter is navigation, the rest is code. */
function GrepOutput({ text, lang }: { text: string; lang: string }): React.JSX.Element {
  const lines = text.split('\n')
  return (
    <pre data-testid="OutputView.grep" className={PRE_CLASSES} style={{ maxHeight: 260 }}>
      {lines.map((line, i) => {
        const split = splitGrepLine(line)
        if (!split) {
          // A separator or a summary tail — not a match row, so not code.
          return (
            <div key={i} className="text-text-muted">
              {line}
            </div>
          )
        }
        return (
          <div key={i}>
            <span className="select-none text-text-muted/70">{split.gutter}</span>
            <CodeLine code={split.content} lang={lang} />
          </div>
        )
      })}
    </pre>
  )
}

/** A unified diff, in the same palette the edit card uses. */
function DiffOutput({ text }: { text: string }): React.JSX.Element {
  return (
    <pre data-testid="OutputView.diff" className={PRE_CLASSES} style={{ maxHeight: 260 }}>
      {text.split('\n').map((line, i) => {
        const tone =
          line.startsWith('+++') || line.startsWith('---')
            ? 'text-text-muted'
            : line.startsWith('@@')
              ? 'text-accent'
              : line.startsWith('+')
                ? 'text-success'
                : line.startsWith('-')
                  ? 'text-danger'
                  : line.startsWith('diff ') || line.startsWith('index ')
                    ? 'text-text-muted'
                    : 'text-text-primary/70'
        return (
          <div key={i} className={tone}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}

/** Whole-text highlighting for the JSON and single-file-read cases. */
function WholeOutput({
  text,
  lang,
  testId
}: {
  text: string
  lang: string
  testId: string
}): React.JSX.Element {
  const code = text.endsWith('\n') ? text.slice(0, -1) : text
  return (
    <Highlight theme={themes.oneDark} code={code} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre data-testid={testId} className={PRE_CLASSES} style={{ maxHeight: 260 }}>
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })} style={undefined}>
              {line.map((token, j) => (
                <span key={j} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  )
}

export function OutputView({ text, command, maxHeight }: Props): React.JSX.Element {
  const format = useMemo(() => detectOutputFormat(text, command), [text, command])

  switch (format.kind) {
    case 'grep':
      return <GrepOutput text={text} lang={format.lang} />
    case 'diff':
      return <DiffOutput text={text} />
    case 'json':
      return <WholeOutput text={text} lang="json" testId="OutputView.json" />
    case 'file':
      return <WholeOutput text={text} lang={format.lang} testId="OutputView.file" />
    case 'plain':
    default:
      return <TerminalView text={text} maxHeight={maxHeight} />
  }
}
