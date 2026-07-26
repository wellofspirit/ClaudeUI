/**
 * WS8 guard test: ThinkingBlock renders the duration passed for THIS block
 * (per-message) rather than a single shared per-session scalar — so two
 * historical thinking blocks show their own "Thought for Xs".
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThinkingBlock } from '../ThinkingBlock'

beforeEach(() => {
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = { logError: () => {} }
})

describe('ThinkingBlock — per-block duration', () => {
  it('shows the durationMs prop, not a shared scalar', () => {
    render(
      <>
        <ThinkingBlock text="a" isActive={false} durationMs={5000} />
        <ThinkingBlock text="b" isActive={false} durationMs={12000} />
      </>
    )
    // Pre-fix, both blocks read one session scalar and showed the same value.
    expect(screen.getByText('Thought for 5s')).toBeInTheDocument()
    expect(screen.getByText('Thought for 12s')).toBeInTheDocument()
  })

  it('shows "Thought" (no time) when no duration is known', () => {
    render(<ThinkingBlock text="a" isActive={false} />)
    expect(screen.getByText('Thought')).toBeInTheDocument()
  })
})
