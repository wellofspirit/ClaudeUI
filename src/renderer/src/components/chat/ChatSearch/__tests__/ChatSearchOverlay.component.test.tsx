/**
 * Layer 2: Component tests for ChatSearchOverlay.
 *
 * Mounts the overlay against a fake chat DOM. Tests UI behavior:
 * open/close, keyboard navigation, counter, case toggle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useRef, useState } from 'react'
import { ChatSearchOverlay } from '../ChatSearchOverlay'
import { useSessionStore } from '../../../../stores/session-store'

function Harness({ html }: { html: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  return (
    <div>
      <div ref={scrollRef} data-testid="scroll" dangerouslySetInnerHTML={{ __html: html }} />
      <ChatSearchOverlay
        scrollRef={scrollRef}
        active={true}
        query={query}
        onQueryChange={setQuery}
        onClose={() => {}}
      />
    </div>
  )
}

beforeEach(() => {
   
  ;(globalThis as any).window.api = {
    saveSettings: vi.fn(),
  }
  useSessionStore.setState((s) => ({
    settings: { ...s.settings, searchCaseSensitive: false },
  }))
})

describe('ChatSearchOverlay', () => {
  it('autofocuses the input on mount', () => {
    render(<Harness html="<p>hello world</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    expect(document.activeElement).toBe(input)
  })

  it('shows counter "current / total" when matches exist', async () => {
    render(<Harness html="<p>foo bar foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('1 / 2')).toBeTruthy()
  })

  it('shows "No results" when query yields no matches', async () => {
    render(<Harness html="<p>hello</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'xyz' } })
    expect(await screen.findByText(/no results/i)).toBeTruthy()
  })

  it('shows blank counter for short queries (<2 chars)', async () => {
    render(<Harness html="<p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'f' } })
    // Counter region should be empty (no '1 / N' and no 'No results')
    expect(screen.queryByText(/no results/i)).toBeNull()
    expect(screen.queryByText(/\d+\s*\/\s*\d+/)).toBeNull()
  })

  it('advances on Enter (next match)', async () => {
    render(<Harness html="<p>foo</p><p>foo</p><p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('2 / 3')).toBeTruthy()
  })

  it('retreats on Shift+Enter (prev match)', async () => {
    render(<Harness html="<p>foo</p><p>foo</p><p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(await screen.findByText('3 / 3')).toBeTruthy() // wraps
  })

  it('calls onClose on Esc', () => {
    const onClose = vi.fn()
    const scrollRef = { current: document.createElement('div') }
    render(
      <ChatSearchOverlay
        scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
        active={true}
        query=""
        onQueryChange={() => {}}
        onClose={onClose}
      />
    )
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('case toggle re-runs the search', async () => {
    render(<Harness html="<p>Foo</p><p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('1 / 2')).toBeTruthy()
    const caseBtn = screen.getByTitle(/case sensitive/i)
    fireEvent.click(caseBtn)
    expect(await screen.findByText('1 / 1')).toBeTruthy()
  })

  it('prefills and selects the prior query when reopened', () => {
    function Wrapper() {
      const scrollRef = useRef<HTMLDivElement>(null)
      const [active, setActive] = useState(true)
      const [query, setQuery] = useState('foo')
      return (
        <div>
          <button data-testid="toggle" onClick={() => setActive((a) => !a)}>toggle</button>
          <div ref={scrollRef}><p>foo bar</p></div>
          <ChatSearchOverlay
            scrollRef={scrollRef}
            active={active}
            query={query}
            onQueryChange={setQuery}
            onClose={() => setActive(false)}
          />
        </div>
      )
    }
    const { getByTestId, getByPlaceholderText } = render(<Wrapper />)
    // Close
    fireEvent.click(getByTestId('toggle'))
    // Reopen
    fireEvent.click(getByTestId('toggle'))
    const input = getByPlaceholderText(/find in chat/i) as HTMLInputElement
    expect(input.value).toBe('foo')
    // Verify selection: in jsdom, selectionStart/End indicate the selected range
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('foo'.length)
  })
})
