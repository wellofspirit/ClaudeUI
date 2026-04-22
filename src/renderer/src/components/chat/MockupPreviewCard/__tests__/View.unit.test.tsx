/**
 * Layer 1: Unit tests for MockupPreviewCardView.
 *
 * Tests pure rendering: given props, does it render the correct structure?
 * No store access, no IPC — just props in, DOM out.
 */

import { createRef } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MockupPreviewCardView, type MockupPreviewCardViewProps } from '../View'

function renderView(overrides: Partial<MockupPreviewCardViewProps> = {}): ReturnType<
  typeof render
> & {
  props: MockupPreviewCardViewProps
  ref: ReturnType<typeof createRef<HTMLIFrameElement>>
} {
  const props: MockupPreviewCardViewProps = {
    title: 'Test Mockup',
    html: '<div>Hello</div>',
    error: null,
    src: 'mockup-asset://abc12345.m/Zm9v/?v=1',
    onExpand: vi.fn(),
    onCopyHtml: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides
  }
  const ref = createRef<HTMLIFrameElement>()
  return { ...render(<MockupPreviewCardView ref={ref} {...props} />), props, ref }
}

describe('MockupPreviewCardView', () => {
  it('does NOT render its own title/header row (the tool-call block above already shows it)', () => {
    // Avoids duplicated title in the chat stream. The title still flows
    // through to the iframe's accessibility title attribute.
    renderView()
    expect(screen.queryByText('Test Mockup')).not.toBeInTheDocument()
    expect(screen.queryByText('UI Mockup')).not.toBeInTheDocument()
  })

  it('passes title through to the iframe title attribute for accessibility', () => {
    renderView()
    const iframe = document.querySelector('iframe')!
    expect(iframe.title).toBe('Test Mockup')
  })

  it('iframe title falls back to "Mockup preview" when none provided', () => {
    renderView({ title: undefined })
    const iframe = document.querySelector('iframe')!
    expect(iframe.title).toBe('Mockup preview')
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

  it('uses a fixed 16:9 aspect ratio for the iframe container', () => {
    // Card uses a fixed aspect ratio instead of dynamic height. The 16:9
    // lives on the iframe's parent wrapper (so the iframe can fill 100%).
    const { container } = renderView()
    const wrapper = container.querySelector('iframe')?.parentElement as HTMLElement
    expect(wrapper.style.aspectRatio).toBe('16 / 9')
  })

  it('the loading placeholder also uses the 16:9 ratio so layout is stable', () => {
    // Prevents a layout jump from the placeholder to the live iframe
    // (important since the card sits in the chat scroll stream).
    const { container } = renderView({ src: null })
    const placeholder = container.querySelector('[style*="aspect-ratio"]') as HTMLElement | null
    expect(placeholder).not.toBeNull()
    expect(placeholder!.style.aspectRatio).toBe('16 / 9')
  })

  it('renders loading state when src is null', () => {
    renderView({ src: null })
    expect(screen.getByText('Loading mockup...')).toBeInTheDocument()
  })

  it('renders error state', () => {
    renderView({ error: 'File not found', src: null })
    expect(screen.getByText('File not found')).toBeInTheDocument()
  })

  it('switches to code tab and shows HTML source', () => {
    const { container } = renderView()
    fireEvent.click(screen.getByText('code'))
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toContain('<div>Hello</div>')
  })

  it('shows Loading... in code tab when html is null', () => {
    renderView({ html: null })
    fireEvent.click(screen.getByText('code'))
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('calls onExpand when expand button is clicked', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Open in side panel'))
    expect(props.onExpand).toHaveBeenCalledOnce()
  })

  it('calls onCopyHtml when copy button is clicked', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Copy HTML'))
    expect(props.onCopyHtml).toHaveBeenCalledOnce()
  })

  it('calls onRefresh when refresh button is clicked', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByTitle('Reload mockup'))
    expect(props.onRefresh).toHaveBeenCalledOnce()
  })

  it('Copy + Refresh buttons live in the tab bar, not the header', () => {
    // Positioned alongside preview/code tabs so they're always visible and
    // don't crowd the mockup title row.
    renderView()
    const copyBtn = screen.getByTitle('Copy HTML') as HTMLElement
    const refreshBtn = screen.getByTitle('Reload mockup') as HTMLElement
    const tabBtn = screen.getByText('preview') as HTMLElement
    const tabBar = tabBtn.parentElement as HTMLElement
    expect(tabBar.contains(copyBtn)).toBe(true)
    expect(tabBar.contains(refreshBtn)).toBe(true)
  })

  it('renders both preview and code tab buttons', () => {
    renderView()
    expect(screen.getByText('preview')).toBeInTheDocument()
    expect(screen.getByText('code')).toBeInTheDocument()
  })
})
