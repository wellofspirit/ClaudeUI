import { useMemo, useRef, useEffect } from 'react'
import { AnsiUp } from 'ansi_up'
import { useSessionStore, type ThemeId } from '../../stores/session-store'

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
  const preRef = useRef<HTMLPreElement>(null)

  // Fresh AnsiUp per conversion: AnsiUp carries SGR state across calls, so a
  // shared module-level instance bled colors between unrelated tool cards. Each
  // card renders its complete text, so no cross-call state is needed.
  const html = useMemo(() => {
    const ansi = new AnsiUp()
    ansi.use_classes = false
    ansi.escape_html = true
    return ansi.ansi_to_html(text)
  }, [text])

  // Show the tail: pin to the bottom on mount and whenever the content changes.
  // NOT by reading `scrollHeight` right in the effect — that forces a layout of
  // the card even while its message is skipped by `content-visibility: auto`
  // (`.cv-auto`), and on a transcript with hundreds of tool cards those forced
  // layouts were most of the time it took to open the session. A ResizeObserver
  // reports only once the card is actually laid out (skipped content is not),
  // after layout and before paint, so the pin is cheap and never flashes the
  // top first. A card already on screen reports right away; one scrolled past
  // reports when it is scrolled back into view.
  useEffect(() => {
    const el = preRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight
      ro.disconnect()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [html])

  return (
    <pre
      data-testid="TerminalView"
      ref={preRef}
      className="text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] rounded-md p-2 border border-border overflow-y-auto"
      style={{
        background: bg,
        color: fg,
        maxHeight: maxHeight ?? MAX_VISIBLE_HEIGHT,
        flex: maxHeight === 'none' ? 1 : undefined,
        minHeight: maxHeight === 'none' ? 0 : undefined
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
