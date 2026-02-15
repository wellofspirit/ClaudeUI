import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessionStore, type ThemeId } from '../../stores/session-store'
import '@xterm/xterm/css/xterm.css'

interface Props {
  text: string
}

function terminalTheme(theme: ThemeId): Record<string, string> {
  if (theme === 'light') {
    return {
      background: '#e8eaed',
      foreground: '#1a1d24',
      cursor: '#e8eaed',
      selectionBackground: '#b0b4bc',
      black: '#1a1d24',
      red: '#b91c1c',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#2563eb',
      magenta: '#7c3aed',
      cyan: '#0d9488',
      white: '#d1d5db',
      brightBlack: '#4b5261',
      brightRed: '#dc2626',
      brightGreen: '#16a34a',
      brightYellow: '#ca8a04',
      brightBlue: '#3b82f6',
      brightMagenta: '#8b5cf6',
      brightCyan: '#14b8a6',
      brightWhite: '#000000',
    }
  }
  if (theme === 'monokai') {
    return {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#272822',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#66d9ef',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e6db74',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#66d9ef',
      brightWhite: '#ffffff',
    }
  }
  // dark (default)
  return {
    background: '#0d1117',
    foreground: '#d1d5db',
    cursor: '#0d1117',
    selectionBackground: '#343a46',
    black: '#1a1d24',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#6c9eff',
    magenta: '#c678dd',
    cyan: '#56d4dd',
    white: '#d1d5db',
    brightBlack: '#4b5261',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#8bb4ff',
    brightMagenta: '#c678dd',
    brightCyan: '#56d4dd',
    brightWhite: '#ffffff',
  }
}

export function TerminalView({ text }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const theme = useSessionStore((s) => s.settings.theme)
  const colors = terminalTheme(theme)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      theme: colors,
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      scrollback: 0,
      overviewRuler: {},
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    // Write content
    term.write(text)

    // Fit to container and resize to content height
    fitAddon.fit()

    // Resize terminal rows to match actual content lines
    const lines = term.buffer.active.length
    // Find last non-empty line
    let lastLine = 0
    for (let i = 0; i < lines; i++) {
      const line = term.buffer.active.getLine(i)
      if (line && line.translateToString().trim()) lastLine = i
    }
    const neededRows = lastLine + 1
    if (neededRows > 0 && neededRows !== term.rows) {
      term.resize(term.cols, neededRows)
    }

    termRef.current = term

    // Observe container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      // Re-calculate rows after fit
      const lines2 = term.buffer.active.length
      let last2 = 0
      for (let i = 0; i < lines2; i++) {
        const line = term.buffer.active.getLine(i)
        if (line && line.translateToString().trim()) last2 = i
      }
      const rows2 = last2 + 1
      if (rows2 > 0 && rows2 !== term.rows) {
        term.resize(term.cols, rows2)
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [text, theme])

  return (
    <div
      ref={containerRef}
      className="rounded-md border border-border overflow-hidden [&_.xterm]:!p-2 [&_.xterm-viewport]:!overflow-hidden"
      style={{ background: colors.background, ['--xterm-bg' as string]: colors.background }}
    />
  )
}
