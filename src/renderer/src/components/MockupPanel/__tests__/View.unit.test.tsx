/**
 * Layer 1: Unit tests for MockupPanelView.
 *
 * Tests pure rendering: given props, does it render the correct structure?
 * No store access, no IPC — just props in, DOM out.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MockupPanelView, type MockupPanelViewProps } from '../View'

function renderView(overrides: Partial<MockupPanelViewProps> = {}) {
  const props: MockupPanelViewProps = {
    mockupTitle: 'Settings Page',
    mockupDir: 'f0f0f0f0',
    html: '<div>Content</div>',
    error: null,
    src: 'mockup-asset://m/Zm9v/f0f0f0f0/?v=1',
    onClose: vi.fn(),
    onCopyHtml: vi.fn(),
    onDarkModeChange: vi.fn(),
    darkMode: false,
    ...overrides
  }
  return { ...render(<MockupPanelView {...props} />), props }
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

  it('renders iframe in preview tab by default', () => {
    renderView()
    const iframe = document.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('sandbox')).toBe('')
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
    // CodeView tokenizes into multiple spans; assert via combined textContent.
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
})
