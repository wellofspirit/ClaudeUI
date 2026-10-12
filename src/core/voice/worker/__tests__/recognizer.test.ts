/**
 * @vitest-environment node
 *
 * `wordsFromTokens` — the one pure piece of the sherpa adapter. The real loader
 * needs the addon and a 650 MB model and is exercised by the gated real-model
 * check, not here.
 */

import { describe, it, expect } from 'vitest'
import { wordsFromTokens } from '../recognizer'

describe('wordsFromTokens', () => {
  it('a token starting with a space starts a new word; others continue the last', () => {
    const words = wordsFromTokens(
      [' use', 'Stick', 'To', ' bottom'],
      [0.1, 0.4, 0.6, 1.0],
      [0.2, 0.1, 0.1, 0.3]
    )
    expect(words).toHaveLength(2)
    expect(words[0].word).toBe('useStickTo')
    expect(words[0].start).toBeCloseTo(0.1)
    expect(words[0].end).toBeCloseTo(0.7) // the last token's start + duration
    expect(words[1]).toEqual({ word: 'bottom', start: 1.0, end: 1.3 })
  })

  it('the first token starts a word even without a leading space', () => {
    expect(wordsFromTokens(['hi', ' there'], [0, 0.5], [0.2, 0.2]).map((w) => w.word)).toEqual([
      'hi',
      'there'
    ])
  })

  it('a bare-space token ends the word before it without becoming one', () => {
    expect(
      wordsFromTokens(['a', ' ', 'b'], [0, 0.2, 0.4], [0.1, 0.1, 0.1]).map((w) => w.word)
    ).toEqual(['a', 'b'])
  })

  it('without durations a word ends where it starts', () => {
    expect(wordsFromTokens([' a'], [1.5])).toEqual([{ word: 'a', start: 1.5, end: 1.5 }])
  })

  it('no tokens, no words', () => {
    expect(wordsFromTokens([], [])).toEqual([])
  })
})
