/**
 * Layer 2: Component tests for ChatSearchOverlay.
 *
 * Mounts the overlay against a fake chat DOM. Tests UI behavior:
 * open/close, keyboard navigation, counter, case + tool-output toggles, and
 * the find-indicator flash.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    saveSettings: vi.fn()
  }
  useSessionStore.setState((s) => ({
    settings: { ...s.settings, searchCaseSensitive: false, searchExcludeToolOutput: false }
  }))
})

describe('ChatSearchOverlay', () => {
  it('autofocuses the input on mount', () => {
    render(<Harness html="<p>hello world</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    expect(document.activeElement).toBe(input)
  })

  it('shows "– / total" while no match is current (typing never jumps)', async () => {
    render(<Harness html="<p>foo bar foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('– / 2')).toBeTruthy()
  })

  it('shows "current / total" once a match is selected', async () => {
    render(<Harness html="<p>foo bar foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
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
    // Counter region should be empty (no 'N / M' and no 'No results')
    expect(screen.queryByText(/no results/i)).toBeNull()
    expect(screen.queryByText(/\/\s*\d+/)).toBeNull()
  })

  it('advances on Enter (first Enter selects match 1, the next one match 2)', async () => {
    render(<Harness html="<p>foo</p><p>foo</p><p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('– / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('2 / 3')).toBeTruthy()
  })

  it('retreats on Shift+Enter (prev match)', async () => {
    render(<Harness html="<p>foo</p><p>foo</p><p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('– / 3')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(await screen.findByText('3 / 3')).toBeTruthy() // wraps back from the pick
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

  it('Escape closes the bar while focus is on one of its buttons', () => {
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
    const toggle = screen.getByTestId('ChatSearchOverlay.excludeToolOutputToggle')
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('case toggle re-runs the search', async () => {
    render(<Harness html="<p>Foo</p><p>foo</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('– / 2')).toBeTruthy()
    const caseBtn = screen.getByTitle(/case sensitive/i)
    fireEvent.click(caseBtn)
    expect(await screen.findByText('– / 1')).toBeTruthy()
  })

  it('exclude-tool-output toggle flips the setting + aria-pressed and re-queries', async () => {
    render(<Harness html={'<p>foo</p><div data-search-scope="tool-output"><pre>foo</pre></div>'} />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('– / 2')).toBeTruthy()

    const toggle = screen.getByTestId('ChatSearchOverlay.excludeToolOutputToggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('title')).toBe('Exclude tool output')
    fireEvent.click(toggle)
    expect(useSessionStore.getState().settings.searchExcludeToolOutput).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText('– / 1')).toBeTruthy()

    fireEvent.click(toggle)
    expect(useSessionStore.getState().settings.searchExcludeToolOutput).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(await screen.findByText('– / 2')).toBeTruthy()
  })

  it('prefills and selects the prior query when reopened', () => {
    function Wrapper() {
      const scrollRef = useRef<HTMLDivElement>(null)
      const [active, setActive] = useState(true)
      const [query, setQuery] = useState('foo')
      return (
        <div>
          <button data-testid="toggle" onClick={() => setActive((a) => !a)}>
            toggle
          </button>
          <div ref={scrollRef}>
            <p>foo bar</p>
          </div>
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

  it('re-runs the prefilled query against the fresh engine when reopened', async () => {
    function Wrapper() {
      const scrollRef = useRef<HTMLDivElement>(null)
      const [active, setActive] = useState(true)
      const [query, setQuery] = useState('')
      return (
        <div>
          <button data-testid="toggle" onClick={() => setActive((a) => !a)}>
            toggle
          </button>
          <div ref={scrollRef}>
            <p>foo foo</p>
          </div>
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
    render(<Wrapper />)
    fireEvent.change(screen.getByPlaceholderText(/find in chat/i), { target: { value: 'foo' } })
    expect(await screen.findByText('– / 2')).toBeTruthy()
    fireEvent.click(screen.getByTestId('toggle'))
    fireEvent.click(screen.getByTestId('toggle'))
    // The counter alone would pass on stale state; navigating proves the new
    // engine holds the matches.
    fireEvent.keyDown(screen.getByPlaceholderText(/find in chat/i), { key: 'Enter' })
    expect(await screen.findByText('1 / 2')).toBeTruthy()
  })
})

describe('ChatSearchOverlay find indicator', () => {
  const rect = (top: number, left = 40, width = 30, height = 16): DOMRect =>
    ({
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  function FlashHarness({ html }: { html: string }) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [query, setQuery] = useState('')
    return (
      <div style={{ position: 'relative' }}>
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

  let clientRects: DOMRect[]
  beforeEach(() => {
    // jsdom has no layout: every rect is zero-sized at the origin unless
    // stubbed. With the container at 0/0 and a clientHeight of 0, the clamped
    // target is 0 = scrollTop, so the reveal settles on its first frame.
    clientRects = [rect(0)]
    Range.prototype.getBoundingClientRect = () => rect(0)
    Range.prototype.getClientRects = () => clientRects as unknown as DOMRectList
    HTMLElement.prototype.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
  })
  afterEach(() => {
    delete (Range.prototype as Partial<Range>).getBoundingClientRect
    delete (Range.prototype as Partial<Range>).getClientRects
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo
  })

  async function revealFirst(): Promise<HTMLElement> {
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'needle' } })
    expect(await screen.findByText('– / 1')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    return screen.findByTestId('ChatSearchOverlay.flash')
  }

  it('flashes a text clone of a single-line match, outside the scroll container', async () => {
    render(<FlashHarness html="<p>find the needle here</p>" />)
    const flash = await revealFirst()
    expect(flash.getAttribute('data-fragments')).toBe('1')
    expect(flash.textContent).toBe('needle')
    expect(screen.getByTestId('scroll').contains(flash)).toBe(false)
    expect(flash.closest('[data-search="skip"]')).not.toBeNull()
  })

  it('flashes one text bubble per line of a match that wraps', async () => {
    // "needle" is text offsets 9-15; it wraps after "nee".
    Range.prototype.getBoundingClientRect = function (this: Range) {
      return this.startOffset < 12 ? rect(0, 300) : rect(16, 0)
    }
    render(<FlashHarness html="<p>find the needle here</p>" />)
    const flash = await revealFirst()
    expect(flash.getAttribute('data-fragments')).toBe('2')
    const fragments = screen.getAllByTestId('ChatSearchOverlay.flashFragment')
    expect(fragments.map((f) => f.textContent)).toEqual(['nee', 'dle'])
  })

  // Scrolling repositions rather than removes it: see ChatSearchFlash.component.test.tsx.
  it('removes the indicator when it finishes, on a new step, and on query change', async () => {
    render(<FlashHarness html="<p>needle one</p><p>needle two</p>" />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // jsdom has no AnimationEvent, so React binds onAnimationEnd to the
    // vendor-prefixed name; fireEvent.animationEnd would never reach it.
    fireEvent(
      await screen.findByTestId('ChatSearchOverlay.flash'),
      new Event('webkitAnimationEnd', { bubbles: true })
    )
    expect(screen.queryByTestId('ChatSearchOverlay.flash')).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByTestId('ChatSearchOverlay.flash')
    fireEvent.keyDown(input, { key: 'Enter' }) // a new step clears it at once
    expect(screen.queryByTestId('ChatSearchOverlay.flash')).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByTestId('ChatSearchOverlay.flash')
    fireEvent.change(input, { target: { value: 'needle ' } })
    await waitFor(() => expect(screen.queryByTestId('ChatSearchOverlay.flash')).toBeNull())
  })
})
