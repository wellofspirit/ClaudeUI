import { useMemo } from 'react'
import { AnsiUp } from 'ansi_up'
import { useSessionStore, type ThemeId } from '../../stores/session-store'
import { useStickToBottom } from '../../hooks/useStickToBottom'

interface Props {
  text: string
  /** Override the default max height. Use "none" to fill available space. */
  maxHeight?: number | string
}

// 10 rows * 12px fontSize * 1.3 lineHeight + 16px padding
const MAX_VISIBLE_HEIGHT = 10 * 12 * 1.3 + 16 // ~172px

function terminalColors(theme: ThemeId): { bg: string; fg: string } {
  if (theme === 'light') return { bg: '#e8eaed', fg: '#1a1d24' }
  if (theme === 'monokai') return { bg: '#272822', fg: '#f8f8f2' }
  return { bg: '#0d1117', fg: '#d1d5db' }
}

export function TerminalView({ text, maxHeight }: Props): React.JSX.Element {
  const theme = useSessionStore((s) => s.settings.theme)
  const { bg, fg } = terminalColors(theme)
  // The pre is the scroll box and its max-height keeps its own size fixed, so
  // the growing thing is the wrapper inside it.
  const { scrollerRef, contentRef } = useStickToBottom<HTMLPreElement>()

  // Fresh AnsiUp per conversion: AnsiUp carries SGR state across calls, so a
  // shared module-level instance bled colors between unrelated tool cards. Each
  // card renders its complete text, so no cross-call state is needed.
  //
  // The memo holds the `{ __html }` OBJECT, not just the string: React compares
  // dangerouslySetInnerHTML by identity and rewrites innerHTML whenever the object
  // changes, so a fresh literal on every render (the follow state re-renders this
  // box when it is scrolled) would replace the text nodes under a find-in-chat
  // match or a selection.
  const html = useMemo(() => {
    const ansi = new AnsiUp()
    ansi.use_classes = false
    ansi.escape_html = true
    return { __html: ansi.ansi_to_html(text) }
  }, [text])

  return (
    <pre
      data-testid="TerminalView"
      ref={scrollerRef}
      className="text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] rounded-md p-2 border border-border overflow-y-auto"
      style={{
        background: bg,
        color: fg,
        maxHeight: maxHeight ?? MAX_VISIBLE_HEIGHT,
        flex: maxHeight === 'none' ? 1 : undefined,
        minHeight: maxHeight === 'none' ? 0 : undefined
      }}
    >
      <div ref={contentRef} dangerouslySetInnerHTML={html} />
    </pre>
  )
}
