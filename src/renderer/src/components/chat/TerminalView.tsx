import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  text: string
}

export function TerminalView({ text }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      theme: {
        background: '#0d1117',
        foreground: '#d1d5db',
        cursor: '#0d1117', // hide cursor by matching bg
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
      },
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
  }, [text])

  return (
    <div
      ref={containerRef}
      className="rounded-md border border-border overflow-hidden [&_.xterm]:!p-2 [&_.xterm-viewport]:!overflow-hidden [&_.xterm-viewport]:!bg-[#0d1117] [&_.xterm-screen]:!bg-[#0d1117]"
      style={{ background: '#0d1117' }}
    />
  )
}
