/**
 * Layer 2: Component test for find-in-chat live updates.
 *
 * Exercises the MutationObserver path: as new DOM nodes are appended to the
 * scroll container, the engine should recompute (after the 150ms debounce)
 * and the overlay counter should reflect the new total.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatSearchOverlay } from '../ChatSearchOverlay'
import { useSessionStore } from '../../../../stores/session-store'

function LiveHarness() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [extras, setExtras] = useState<string[]>([])
  const [query, setQuery] = useState('')
  return (
    <div>
      <button data-testid="add-foo" onClick={() => setExtras((e) => [...e, 'foo'])}>
        add
      </button>
      <div ref={scrollRef}>
        <p>foo bar</p>
        {extras.map((t, i) => (
          <p key={i}>{t}</p>
        ))}
      </div>
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

describe('find-in-chat live updates', () => {
  it('updates the match counter as new content is appended', async () => {
    render(<LiveHarness />)
    const input = screen.getByPlaceholderText(/find in chat/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(await screen.findByText('1 / 1')).toBeTruthy()

    // Append two more matches via state update
    fireEvent.click(screen.getByTestId('add-foo'))
    fireEvent.click(screen.getByTestId('add-foo'))

    // Engine debounces 150ms before recomputing
    await waitFor(
      () => {
        expect(screen.getByText(/\/ 3/)).toBeTruthy()
      },
      { timeout: 1000 }
    )
  })
})
