import { describe, it, expect } from 'vitest'
import { handbackBodyShown } from '../HandbackReport'

describe('handbackBodyShown', () => {
  it('hides the body under a loaded stream, whose "Hand back" call already shows it', () => {
    expect(handbackBodyShown(true, false, false)).toBe(false)
  })

  it('hides the body while the transcript loads, so it does not flash and vanish', () => {
    expect(handbackBodyShown(false, true, false)).toBe(false)
  })

  it('shows the body when there is no stream to show it (transcript missing)', () => {
    expect(handbackBodyShown(false, false, false)).toBe(true)
  })

  it('keeps the body for an X-Agent, whose hand_back call renders as raw JSON', () => {
    expect(handbackBodyShown(true, false, true)).toBe(true)
    expect(handbackBodyShown(false, true, true)).toBe(true)
  })
})
