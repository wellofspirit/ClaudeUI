/**
 * @vitest-environment node
 *
 * The LocalAgreement-2 policy, as arithmetic: no sockets, no clock, no model.
 */

import { describe, it, expect } from 'vitest'
import {
  BOUNDARY_ECHO_S,
  GUARD_S,
  LEAD_IN_S,
  MAX_WINDOW_S,
  MIN_PREVIEW_AUDIO_S,
  PREVIEW_EVERY_MS,
  advancePreview,
  newPreviewState,
  previewDue,
  previewWindowStart,
  shiftWords,
  type Word
} from '../preview'

/** Words `text` spaced `step` s apart, each lasting `len` s, starting at `from`. */
function say(text: string, from = 0, step = 0.5, len = 0.4): Word[] {
  return text.split(' ').map((word, i) => ({
    word,
    start: from + i * step,
    end: from + i * step + len
  }))
}

describe('previewDue — when a preview decode may start', () => {
  const base = { now: 5_000, lastPreviewAt: null, decoding: false, audioSeconds: 3 }

  it('waits for 1.5 s of audio', () => {
    expect(previewDue({ ...base, audioSeconds: MIN_PREVIEW_AUDIO_S - 0.01 })).toBe(false)
    expect(previewDue({ ...base, audioSeconds: MIN_PREVIEW_AUDIO_S })).toBe(true)
  })

  it('the first preview needs no interval, later ones need a full second since the last', () => {
    expect(previewDue({ ...base, lastPreviewAt: null })).toBe(true)
    expect(previewDue({ ...base, lastPreviewAt: base.now - (PREVIEW_EVERY_MS - 1) })).toBe(false)
    expect(previewDue({ ...base, lastPreviewAt: base.now - PREVIEW_EVERY_MS })).toBe(true)
  })

  it('never while a decode is in flight', () => {
    expect(previewDue({ ...base, decoding: true })).toBe(false)
  })
})

describe('advancePreview — LocalAgreement-2', () => {
  it('the first hypothesis has nothing to agree with: shown, not committed', () => {
    const { state, text } = advancePreview(newPreviewState(), say('add a retry'), 3)
    expect(text).toBe('add a retry')
    expect(state.committed).toEqual([])
    expect(state.commitStart).toBe(0)
    expect(state.open.map((w) => w.word)).toEqual(['add', 'a', 'retry'])
  })

  it('commits the words two decodes agree on that end ≥ 1 s behind the live edge', () => {
    // Words end at 0.4, 0.9, 1.4, 1.9; the edge is 3.0, so the cut-off is 2.0.
    const hyp = say('one two three four')
    const first = advancePreview(newPreviewState(), hyp, 3)
    const second = advancePreview(first.state, hyp, 3)
    expect(second.state.committed).toEqual(['one', 'two', 'three', 'four'])
    expect(second.text).toBe('one two three four')
    // Everything committed: the next window starts where the last word ended.
    expect(second.state.commitStart).toBeCloseTo(1.9)
    expect(second.state.open).toEqual([])
  })

  it('the guard holds back a stable word that ends too close to the edge', () => {
    const hyp = say('one two three four') // ends 0.4 … 1.9
    const first = advancePreview(newPreviewState(), hyp, 2.5)
    const second = advancePreview(first.state, hyp, 2.5) // cut-off 1.5: one, two, three
    expect(second.state.committed).toEqual(['one', 'two', 'three'])
    expect(second.state.open.map((w) => w.word)).toEqual(['four'])
    // The window restarts where the last committed word ENDED, not at the next
    // word's start: TDT timestamps are emission frames and can clip an onset.
    expect(second.state.commitStart).toBeCloseTo(1.4)
    expect(second.text).toBe('one two three four')
  })

  it('stops committing at the first word the decodes disagree on', () => {
    const first = advancePreview(newPreviewState(), say('use the stick bottom'), 5)
    const second = advancePreview(first.state, say('use the stick to bottom'), 5)
    // Agreed prefix is "use the stick"; all three are old enough.
    expect(second.state.committed).toEqual(['use', 'the', 'stick'])
    expect(second.state.open.map((w) => w.word)).toEqual(['to', 'bottom'])
    expect(second.text).toBe('use the stick to bottom')
  })

  it('compares case-insensitively and keeps the newer spelling of what stays open', () => {
    const first = advancePreview(newPreviewState(), say('Hello world'), 5)
    const second = advancePreview(first.state, say('hello World'), 5)
    expect(second.state.committed).toEqual(['hello', 'World'])
  })

  it('a hypothesis that revises its first word commits nothing', () => {
    const first = advancePreview(newPreviewState(), say('the cat sat'), 5)
    const second = advancePreview(first.state, say('a cat sat'), 5)
    expect(second.state.committed).toEqual([])
    expect(second.text).toBe('a cat sat')
  })

  it('carries committed words through later windows (word times are in take time)', () => {
    let state = newPreviewState()
    const hyp1 = say('alpha beta gamma delta') // 0 … 1.9
    state = advancePreview(state, hyp1, 4).state
    state = advancePreview(state, hyp1, 4).state
    expect(state.committed).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    // The next window decodes from 1.9 s; its words arrive already shifted.
    const hyp2 = shiftWords(say('epsilon zeta', 0), state.commitStart)
    state = advancePreview(state, hyp2, 6).state
    const last = advancePreview(state, hyp2, 6)
    expect(last.text).toBe('alpha beta gamma delta epsilon zeta')
    expect(last.state.committed).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])
  })

  describe('the max-window force-commit', () => {
    it('commits old words even without agreement once the window passes 15 s, keeping the last open', () => {
      // 40 words, 0.5 s apart, ending 0.4 … 19.9; edge 20 → cut-off 19.
      const words = 'w'
        .repeat(40)
        .split('')
        .map((c, i) => c + i)
      const hyp = say(words.join(' '))
      // A previous hypothesis (a short take, nothing forced) that disagrees from
      // the first word on: stable = 0.
      const prev = advancePreview(newPreviewState(), say('zzz ' + words.slice(1).join(' ')), 1)
      const { state } = advancePreview(prev.state, hyp, 20)
      // Words ending ≤ 19.0: indices 0..37 (end 18.4+…); the last is held open anyway.
      expect(state.committed.length).toBeGreaterThan(30)
      expect(state.committed[0]).toBe('w0')
      expect(state.open.length).toBeGreaterThanOrEqual(1)
      expect(state.open.at(-1)!.word).toBe('w39')
      for (const w of state.open) expect(w.end).toBeGreaterThan(20 - GUARD_S - 1e-9)
    })

    it('does not fire at or below the cap', () => {
      const hyp = say('a1 b2 c3 d4 e5 f6 g7 h8')
      const prev = advancePreview(newPreviewState(), say('q1 b2 c3 d4 e5 f6 g7 h8'), 1)
      const { state } = advancePreview(prev.state, hyp, MAX_WINDOW_S)
      expect(state.committed).toEqual([])
    })

    it('never commits the final word, even if every word is old', () => {
      const hyp = say('only one old pair', 0)
      const prev = advancePreview(newPreviewState(), say('xx one old pair', 0), 1)
      const { state } = advancePreview(prev.state, hyp, 30)
      expect(state.committed).toEqual(['only', 'one', 'old'])
      expect(state.open.map((w) => w.word)).toEqual(['pair'])
    })
  })

  it('an empty hypothesis keeps the committed text, and the window follows the edge', () => {
    const first = advancePreview(newPreviewState(), say('keep this'), 5)
    const second = advancePreview(first.state, say('keep this'), 5)
    const third = advancePreview(second.state, [], 8)
    expect(third.text).toBe('keep this')
    expect(third.state.commitStart).toBeCloseTo(8 - GUARD_S - 0.2)
  })

  it('agreement ignores punctuation and case, and keeps the newer spelling', () => {
    const first = advancePreview(newPreviewState(), say('Okay so we add'), 5)
    const second = advancePreview(first.state, say('Okay, so we add.'), 5)
    expect(second.state.committed).toEqual(['Okay,', 'so', 'we', 'add.'])
    expect(second.text).toBe('Okay, so we add.')
  })

  it('a word that is only punctuation does not stop agreement from comparing the rest', () => {
    const first = advancePreview(newPreviewState(), say('wait — what'), 5)
    const second = advancePreview(first.state, say('wait — what'), 5)
    expect(second.state.committed).toEqual(['wait', '—', 'what'])
  })
})

describe('the window follows a pause instead of growing through it', () => {
  it('an empty hypothesis in a window past the cap moves the window to just behind the edge', () => {
    const { state } = advancePreview(newPreviewState(), [], 30)
    expect(state.commitStart).toBeCloseTo(30 - GUARD_S - 0.2)
    expect(state.committed).toEqual([])
  })

  it('a single late word after a long pause does not leave the window at 0', () => {
    // 30 s of silence, then one word at 30.0–30.4; the edge is 31.
    const word: Word[] = [{ word: 'hello', start: 30, end: 30.4 }]
    const first = advancePreview(newPreviewState(), word, 31)
    expect(first.state.commitStart).toBeCloseTo(30 - GUARD_S - 0.2)
    expect(first.text).toBe('hello')
    // Next decode agrees; by edge 32 the word is old enough to commit, and the
    // window then starts where it ended.
    const second = advancePreview(first.state, word, 32)
    expect(second.state.committed).toEqual(['hello'])
    expect(second.state.commitStart).toBeCloseTo(30.4)
  })

  it('never moves the window backwards', () => {
    const state = { committed: ['a'], commitStart: 20, open: [] }
    expect(advancePreview(state, [], 20.5).state.commitStart).toBe(20)
  })

  it('never puts the window past the live edge', () => {
    const state = { committed: [], commitStart: 0, open: [] }
    const late: Word[] = [{ word: 'x', start: 10, end: 10.4 }]
    expect(advancePreview(state, late, 5).state.commitStart).toBeLessThanOrEqual(5)
  })

  it('invariant: a long silence never makes the decoded window large', () => {
    // A model that hears one word at 10.0–10.4 and nothing else, previewed once a
    // second for two minutes. Each step decodes [commitStart, edge].
    const spoken: Word[] = [{ word: 'word', start: 10, end: 10.4 }]
    let state = newPreviewState()
    let widest = 0
    for (let edge = 2; edge <= 120; edge++) {
      widest = Math.max(widest, edge - state.commitStart)
      const hypothesis = spoken.filter((w) => w.start >= state.commitStart && w.end <= edge)
      state = advancePreview(state, hypothesis, edge).state
    }
    // One second of new audio plus the guard margin, with room for the word.
    expect(widest).toBeLessThan(MAX_WINDOW_S / 2)
    expect(state.committed).toEqual(['word'])
  })
})

describe('the echo of the last committed word at a window boundary', () => {
  // "the open" committed, ending at 1.4; the next window starts there.
  const committedState = (): ReturnType<typeof newPreviewState> => {
    const hyp = say('the open') // 0–0.4, 0.5–0.9 … ends 0.9
    const first = advancePreview(newPreviewState(), hyp, 3)
    return advancePreview(first.state, hyp, 3).state
  }

  it('drops a first word that repeats the last committed one right at the window start', () => {
    const state = committedState()
    expect(state.committed).toEqual(['the', 'open'])
    // The model re-hears "open"'s tail as "Open", then the real next words.
    const hyp = shiftWords(say('Open code adapter', 0, 0.5), state.commitStart)
    const { text } = advancePreview(state, hyp, 5)
    expect(text).toBe('the open code adapter')
  })

  it('keeps a real repetition that starts later than the boundary', () => {
    const state = committedState()
    const hyp = shiftWords(say('open open', BOUNDARY_ECHO_S + 0.2, 0.5), state.commitStart)
    expect(advancePreview(state, hyp, 5).text).toBe('the open open open')
  })

  it('keeps a first word that differs from the last committed one', () => {
    const state = committedState()
    const hyp = shiftWords(say('code adapter'), state.commitStart)
    expect(advancePreview(state, hyp, 5).text).toBe('the open code adapter')
  })
})

describe('the lead-in before the commit point', () => {
  // "the open" committed, ending at 0.9; a preview window now decodes from 0 (the
  // lead-in reaches back past the take's start), so it re-hears the committed words.
  const committedState = (): ReturnType<typeof newPreviewState> => {
    const hyp = say('the open') // 0–0.4, 0.5–0.9
    const first = advancePreview(newPreviewState(), hyp, 3)
    return advancePreview(first.state, hyp, 3).state
  }

  it('previewWindowStart is the commit point less the lead-in, clamped at 0', () => {
    expect(previewWindowStart({ committed: [], commitStart: 0, open: [] })).toBe(0)
    expect(previewWindowStart({ committed: [], commitStart: LEAD_IN_S - 0.5, open: [] })).toBe(0)
    expect(previewWindowStart({ committed: [], commitStart: LEAD_IN_S, open: [] })).toBe(0)
    expect(previewWindowStart({ committed: [], commitStart: 10, open: [] })).toBeCloseTo(
      10 - LEAD_IN_S
    )
    expect(LEAD_IN_S).toBe(3)
  })

  it('ignores a hypothesis that repeats the committed words in its lead-in', () => {
    const state = committedState()
    expect(state.commitStart).toBeCloseTo(0.9)
    // The lead-in re-hears "the open" (mid 0.2, 0.7 < 0.9), then new speech.
    const hyp = say('the open code adapter') // code 1.0–1.4, adapter 1.5–1.9
    const first = advancePreview(state, hyp, 5)
    expect(first.text).toBe('the open code adapter')
    expect(first.state.open.map((w) => w.word)).toEqual(['code', 'adapter'])
    // A second agreeing decode commits only the new words — each once.
    const second = advancePreview(first.state, hyp, 5)
    expect(second.state.committed).toEqual(['the', 'open', 'code', 'adapter'])
    expect(second.text).toBe('the open code adapter')
  })

  it('lead-in words that disagree between decodes do not block agreement', () => {
    const state = committedState()
    const first = advancePreview(state, say('a closed code adapter'), 5)
    const second = advancePreview(first.state, say('the open code adapter'), 5)
    expect(second.state.committed).toEqual(['the', 'open', 'code', 'adapter'])
  })

  it('keeps or drops a word straddling the commit point by its midpoint', () => {
    const state = { committed: ['go'], commitStart: 10, open: [] as Word[] }
    // Midpoint 10.1 ≥ 10: new audio, kept.
    const kept = advancePreview(state, [{ word: 'now', start: 9.8, end: 10.4 }], 12)
    expect(kept.text).toBe('go now')
    // Midpoint 9.9 < 10: committed audio, dropped.
    const dropped = advancePreview(state, [{ word: 'now', start: 9.4, end: 10.4 }], 12)
    expect(dropped.text).toBe('go')
    // Exactly on the point: kept.
    const edgeCase = advancePreview(state, [{ word: 'now', start: 9.9, end: 10.1 }], 12)
    expect(edgeCase.text).toBe('go now')
  })

  it('still drops the echo of the last committed word that starts at the commit point', () => {
    const state = committedState()
    // "Open" re-heard right at the commit point (mid 1.0 ≥ 0.9), then the real words.
    const hyp = [
      { word: 'the', start: 0, end: 0.4 },
      { word: 'open', start: 0.5, end: 0.9 },
      { word: 'Open', start: 0.9, end: 1.2 },
      { word: 'code', start: 1.3, end: 1.7 }
    ]
    expect(advancePreview(state, hyp, 5).text).toBe('the open code')
  })
})

describe('shiftWords', () => {
  it('moves word times by the window offset and leaves the words', () => {
    expect(shiftWords([{ word: 'a', start: 0.5, end: 0.9 }], 2)).toEqual([
      { word: 'a', start: 2.5, end: 2.9 }
    ])
  })
})
