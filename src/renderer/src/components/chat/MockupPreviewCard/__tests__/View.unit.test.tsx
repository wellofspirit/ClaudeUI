/**
 * Layer 1: Unit tests for MockupPreviewCardView.
 *
 * Tests pure rendering: given props, does it render the correct structure?
 * No store access, no IPC — just props in, DOM out.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MockupPreviewCardView, type MockupPreviewCardViewProps } from '../View'

function renderView(overrides: Partial<MockupPreviewCardViewProps> = {}) {
  const props: MockupPreviewCardViewProps = {
    directory: 'abc12345',
    title: 'Test Mockup',
    html: '<div>Hello</div>',
    error: null,
    srcdoc: '<html><body><div>Hello</div></body></html>',
    onExpand: vi.fn(),
    onCopyHtml: vi.fn(),
    ...overrides
  }
  return { ...render(<MockupPreviewCardView {...props} />), props }
}

describe('MockupPreviewCardView', () => {
  it('renders title and directory ID', () => {
    renderView()
    expect(screen.getByText('Test Mockup')).toBeInTheDocument()
    expect(screen.getByText('abc12345')).toBeInTheDocument()
  })

  it('renders default title when none provided', () => {
    renderView({ title: undefined })
    expect(screen.getByText('UI Mockup')).toBeInTheDocument()
  })

  it('renders iframe in preview tab by default', () => {
    renderView()
    const iframe = document.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('sandbox')).toBe('')
    expect(iframe?.title).toBe('Test Mockup')
  })

  it('renders loading state when srcdoc is null', () => {
    renderView({ srcdoc: null })
    expect(screen.getByText('Loading mockup...')).toBeInTheDocument()
  })

  it('renders error state', () => {
    renderView({ error: 'File not found', srcdoc: null })
    expect(screen.getByText('File not found')).toBeInTheDocument()
  })

  it('switches to code tab and shows HTML source', () => {
    renderView()
    fireEvent.click(screen.getByText('code'))
    expect(screen.getByText('<div>Hello</div>')).toBeInTheDocument()
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

  it('renders both preview and code tab buttons', () => {
    renderView()
    expect(screen.getByText('preview')).toBeInTheDocument()
    expect(screen.getByText('code')).toBeInTheDocument()
  })
})
