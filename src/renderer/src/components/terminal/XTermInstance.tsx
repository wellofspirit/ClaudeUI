import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessionStore, type ThemeId } from '../../stores/session-store'
import '@xterm/xterm/css/xterm.css'

interface Props {
  terminalId: string
  isActive: boolean
}

function buildXtermTheme(themeId: ThemeId): Record<string, string> {
  if (themeId === 'light') {
    return {
      background: '#f0f0f0',
      foreground: '#000000',
      cursor: '#3a6fd8',
      cursorAccent: '#f0f0f0',
      selectionBackground: '#3a6fd840',
      black: '#000000',
      red: '#b91c1c',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#3a6fd8',
      magenta: '#6d35c7',
      cyan: '#1a7a6e',
      white: '#f0f0f0',
      brightBlack: '#4b5060',
      brightRed: '#dc2626',
      brightGreen: '#16a34a',
      brightYellow: '#ca8a04',
      brightBlue: '#5284e0',
      brightMagenta: '#9571d4',
      brightCyan: '#4bbcac',
      brightWhite: '#ffffff'
    }
  }
  if (themeId === 'monokai') {
    return {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#272822',
      selectionBackground: '#66d9ef40',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e6db74',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    }
  }
  // dark (default)
  return {
    background: '#0d1117',
    foreground: '#d1d5db',
    cursor: '#6c9eff',
    cursorAccent: '#0d1117',
    selectionBackground: '#6c9eff40',
    black: '#0d1117',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#6c9eff',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d1d5db',
    brightBlack: '#4b5261',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93bbff',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f3f4f6'
  }
}

export function XTermInstance({ terminalId, isActive }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const theme = useSessionStore((s) => s.settings.theme)

  // Initialize Terminal once on mount
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      theme: buildXtermTheme(theme),
      allowProposedApi: true
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    // Defer initial fit so container has dimensions
    requestAnimationFrame(() => {
      fitAddon.fit()
      window.api.resizeTerminal(terminalId, term.cols, term.rows)
    })

    termRef.current = term
    fitAddonRef.current = fitAddon

    // User input -> IPC -> PTY
    const dataDisposable = term.onData((data) => {
      window.api.writeTerminal(terminalId, data)
    })

    // PTY output -> terminal
    const unsub = window.api.onTerminalData(({ terminalId: id, data }) => {
      if (id === terminalId) term.write(data)
    })

    // Fit on resize
    const ro = new ResizeObserver(() => {
      if (containerRef.current?.offsetWidth === 0) return // hidden tab
      fitAddon.fit()
      window.api.resizeTerminal(terminalId, term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    return () => {
      unsub()
      dataDisposable.dispose()
      ro.disconnect()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // Refit when tab becomes visible (switching tabs, opening panel)
  useEffect(() => {
    if (!isActive) return
    const fit = fitAddonRef.current
    const term = termRef.current
    if (!fit || !term) return
    // Defer fit until display:block takes effect
    requestAnimationFrame(() => {
      fit.fit()
      window.api.resizeTerminal(terminalId, term.cols, term.rows)
      term.focus()
    })
  }, [isActive, terminalId])

  // Update theme without reinitializing
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = buildXtermTheme(theme)
    }
  }, [theme])

  return <div ref={containerRef} className="h-full w-full" style={{ padding: '4px 8px' }} />
}
