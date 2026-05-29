/**
 * Layer 1: Unit tests for MockupPanelView.
 *
 * Tests pure rendering: given props, does it render the correct structure?
 * No store access, no IPC — just props in, DOM out.
 */

import { createRef } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MockupPanelView, type MockupPanelViewProps } from '../View'

function renderView(overrides: Partial<MockupPanelViewProps> = {}): ReturnType<typeof render> & {
  props: MockupPanelViewProps
  ref: ReturnType<typeof createRef<HTMLIFrameElement>>
} {
  const props: MockupPanelViewProps = {
    mockupTitle: 'Settings Page',
    mockupDir: 'f0f0f0f0',
    html: '<div>Content</div>',
    error: null,
    src: 'mockup-asset://f0f0f0f0.m/Zm9v/?v=1',
    sandbox: 'allow-scripts allow-same-origin',
    onClose: vi.fn(),
    onCopyHtml: vi.fn(),
    onRefresh: vi.fn(),
    onDarkModeChange: vi.fn(),
    darkMode: false,
    consoleLogs: [],
    consoleErrors: [],
    consoleOpen: false,
    onToggleConsole: vi.fn(),
    onClearConsole: vi.fn(),
    ...overrides
  }
  const ref = createRef<HTMLIFrameElement>()
  return { ...render(<MockupPanelView ref={ref} {...props} />), props, ref }
}

describe('MockupPanelView', () => {
  it('renders title and directory ID', () => {
    renderView()
    expect(screen.getByText('Settings Page')).toBeInTheDocument()
    expect(screen.getByText('f0f0f0f0')).toBeInTheDocument()
  })

  it('renders default title when null', () => {
    renderView({ mockupTitle: null })
    expect(screen.getByText('UI Mockup')).toBeInTheDocument()
  })

  it('renders iframe with allow-scripts allow-same-origin sandbox', () => {
    renderView()
    const iframe = document.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('forwards iframe ref to parent for the bridge to hook onto', () => {
    const { ref } = renderView()
    expect(ref.current).toBeInstanceOf(HTMLIFrameElement)
  })

  it('renders error state', () => {
    renderView({ error: 'Failed to load', src: null })
    expect(screen.getByText('Failed to load')).toBeInTheDocument()
  })

  it('renders loading state when src is null', () => {
    renderView({ src: null })
    expect(screen.getByText('Loading mockup...')).toBeInTheDocument()
  })

  it('switches to code tab', () => {
    const { container } = renderView()
    fireEvent.click(screen.getByText('code'))
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toContain('<div>Content</div>')
  })

  it('calls onClose when close button clicked', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Close'))
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('calls onCopyHtml when copy button clicked', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Copy HTML source'))
    expect(props.onCopyHtml).toHaveBeenCalledOnce()
  })

  it('calls onRefresh when refresh button is clicked', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Reload mockup'))
    expect(props.onRefresh).toHaveBeenCalledOnce()
  })

  it('Copy + Refresh live in the toolbar (with preview/code tabs), not the header', () => {
    renderView()
    const copyBtn = screen.getByTitle('Copy HTML source') as HTMLElement
    const refreshBtn = screen.getByTitle('Reload mockup') as HTMLElement
    // Toolbar is identified by the preview/code tab button's parent.
    const previewTab = screen.getByText('preview') as HTMLElement
    const toolbar = previewTab.parentElement as HTMLElement
    expect(toolbar.contains(copyBtn)).toBe(true)
    expect(toolbar.contains(refreshBtn)).toBe(true)
    // And NOT in the header (Close button's parent).
    const closeBtn = screen.getByTitle('Close') as HTMLElement
    const header = closeBtn.parentElement as HTMLElement
    expect(header.contains(copyBtn)).toBe(false)
    expect(header.contains(refreshBtn)).toBe(false)
  })

  it('calls onDarkModeChange when dark mode toggled', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Toggle dark mode'))
    expect(props.onDarkModeChange).toHaveBeenCalledWith(true)
  })

  it('renders device frame buttons', () => {
    renderView()
    expect(screen.getByText('mobile')).toBeInTheDocument()
    expect(screen.getByText('tablet')).toBeInTheDocument()
    expect(screen.getByText('desktop')).toBeInTheDocument()
  })

  it('hides directory ID when mockupDir is null', () => {
    renderView({ mockupDir: null })
    expect(screen.queryByText('f0f0f0f0')).not.toBeInTheDocument()
  })

  it('renders the console drawer toggle', () => {
    renderView()
    expect(screen.getByText('Console')).toBeInTheDocument()
  })

  it('shows a log entry when the drawer is open', () => {
    renderView({
      consoleOpen: true,
      consoleLogs: [{ id: 1, timestamp: 0, level: 'warn', args: ['deprecated api'] }]
    })
    expect(screen.getByText(/deprecated api/)).toBeInTheDocument()
    expect(screen.getByText('[warn]')).toBeInTheDocument()
  })

  it('shows an error entry with filename + lineno', () => {
    renderView({
      consoleOpen: true,
      consoleErrors: [
        {
          id: 1,
          timestamp: 0,
          message: 'boom',
          stack: '',
          filename: 'inline',
          lineno: 5
        }
      ]
    })
    expect(screen.getByText(/boom/)).toBeInTheDocument()
    expect(screen.getByText(/inline:5/)).toBeInTheDocument()
  })

  it('console counter shows log + error totals with error highlighting', () => {
    renderView({
      consoleLogs: [{ id: 1, timestamp: 0, level: 'log', args: ['hi'] }],
      consoleErrors: [{ id: 2, timestamp: 0, message: 'x', stack: '', filename: '', lineno: 0 }]
    })
    // Label shows "2" total plus "1 error"
    expect(screen.getByText(/2/)).toBeInTheDocument()
    expect(screen.getByText(/1 error/)).toBeInTheDocument()
  })
})
