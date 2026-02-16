import { useMemo, useRef, useEffect } from 'react'
import { AnsiUp } from 'ansi_up'
import { useSessionStore, type ThemeId } from '../../stores/session-store'

interface Props {
  text: string
}

// 10 rows * 12px fontSize * 1.3 lineHeight + 16px padding
const MAX_VISIBLE_HEIGHT = 10 * 12 * 1.3 + 16 // ~172px

function terminalColors(theme: ThemeId): { bg: string; fg: string } {
  if (theme === 'light') return { bg: '#e8eaed', fg: '#1a1d24' }
  if (theme === 'monokai') return { bg: '#272822', fg: '#f8f8f2' }
  return { bg: '#0d1117', fg: '#d1d5db' }
}

const ansi = new AnsiUp()
ansi.use_classes = false
ansi.escape_html = true

export function TerminalView({ text }: Props): React.JSX.Element {
  const theme = useSessionStore((s) => s.settings.theme)
  const { bg, fg } = terminalColors(theme)
  const preRef = useRef<HTMLPreElement>(null)

  const html = useMemo(() => ansi.ansi_to_html(text), [text])

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [html])

  return (
    <pre
      ref={preRef}
      className="text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] rounded-md p-2 border border-border overflow-y-auto"
      style={{ background: bg, color: fg, maxHeight: MAX_VISIBLE_HEIGHT }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
